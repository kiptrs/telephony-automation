import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const numberRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  telnyx_number_id: z.string().nullable(),
  tenant_id: z.string().uuid().nullable(),
  tenant_slug: z.string().nullable(),
  max_concurrent: z.number().int(),
  status: z.enum(["active", "paused", "released"]),
  active_leases: z.number().int(),
  last_used_at: z.date().nullable(),
});

export interface PhoneNumber {
  id: string;
  e164: string;
  telnyxNumberId: string | null;
  tenantId: string | null;
  tenantSlug: string | null;
  maxConcurrent: number;
  status: "active" | "paused" | "released";
  activeLeases: number;
  lastUsedAt: string | null;
}

function toNumber(row: z.infer<typeof numberRow>): PhoneNumber {
  return {
    id: row.id,
    e164: row.e164,
    telnyxNumberId: row.telnyx_number_id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    maxConcurrent: row.max_concurrent,
    status: row.status,
    activeLeases: row.active_leases,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

const SELECT_NUMBER = `
  SELECT pn.id, pn.e164, pn.telnyx_number_id, pn.tenant_id, t.slug AS tenant_slug,
         pn.max_concurrent, pn.status, pn.last_used_at,
         (SELECT count(*)::int FROM number_leases nl
           WHERE nl.phone_number_id = pn.id
             AND nl.released_at IS NULL AND nl.expires_at > now()) AS active_leases
    FROM phone_numbers pn
    LEFT JOIN tenants t ON t.id = pn.tenant_id
`;

export async function listNumbers(pool: Pool): Promise<PhoneNumber[]> {
  const result = await pool.query(`${SELECT_NUMBER} ORDER BY pn.e164`);
  return parseRows(numberRow, result).map(toNumber);
}

export async function insertNumber(
  pool: Pool,
  args: {
    e164: string;
    telnyxNumberId: string | null;
    tenantId: string | null;
    maxConcurrent: number;
  },
): Promise<PhoneNumber> {
  const inserted = await pool.query(
    `INSERT INTO phone_numbers (e164, telnyx_number_id, tenant_id, max_concurrent)
          VALUES ($1, $2, $3, $4) RETURNING id`,
    [args.e164, args.telnyxNumberId, args.tenantId, args.maxConcurrent],
  );
  const { id } = parseExactlyOne(z.object({ id: z.string().uuid() }), inserted);
  const found = await findNumber(pool, id);
  if (!found) throw new Error("number vanished after insert");
  return found;
}

export async function findNumber(
  pool: Pool,
  id: string,
): Promise<PhoneNumber | null> {
  const result = await pool.query(`${SELECT_NUMBER} WHERE pn.id = $1`, [id]);
  const row = parseOne(numberRow, result);
  return row === null ? null : toNumber(row);
}

export async function updateNumber(
  pool: Pool,
  id: string,
  args: {
    status?: "active" | "paused" | "released";
    tenantId?: string | null;
    maxConcurrent?: number;
  },
): Promise<PhoneNumber | null> {
  const result = await pool.query(
    `UPDATE phone_numbers
        SET status = COALESCE($2, status),
            max_concurrent = COALESCE($3, max_concurrent),
            tenant_id = CASE WHEN $4 THEN $5 ELSE tenant_id END
      WHERE id = $1
      RETURNING id`,
    [
      id,
      args.status ?? null,
      args.maxConcurrent ?? null,
      // A separate flag, because null is a meaningful value here: it moves the
      // number back into the shared pool.
      Object.prototype.hasOwnProperty.call(args, "tenantId"),
      args.tenantId ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return findNumber(pool, id);
}
