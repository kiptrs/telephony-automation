import type { ParsedContact } from "@console/shared";
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseRows } from "../db/rows.js";

const contactRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  external_ref: z.string().nullable(),
  status: z.enum(["pending", "dialing", "done"]),
});

export interface Contact {
  id: string;
  e164: string;
  externalRef: string | null;
  status: "pending" | "dialing" | "done";
}

function toContact(row: z.infer<typeof contactRow>): Contact {
  return {
    id: row.id,
    e164: row.e164,
    externalRef: row.external_ref,
    status: row.status,
  };
}

export async function listContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<Contact[]> {
  const result = await pool.query(
    `SELECT ct.id, ct.e164, ct.external_ref, ct.status
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2
      ORDER BY ct.created_at, ct.e164`,
    [tenantId, campaignId],
  );
  return parseRows(contactRow, result).map(toContact);
}

export async function countContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2`,
    [tenantId, campaignId],
  );
  return parseExactlyOne(z.object({ n: z.number().int() }), result).n;
}

/** Which of these numbers the campaign already holds. Used by the preview. */
export async function findExistingNumbers(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  e164s: string[],
): Promise<Set<string>> {
  if (e164s.length === 0) return new Set();
  const result = await pool.query(
    `SELECT ct.e164
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2 AND ct.e164 = ANY($3::text[])`,
    [tenantId, campaignId, e164s],
  );
  return new Set(
    parseRows(z.object({ e164: z.string() }), result).map((row) => row.e164),
  );
}

/**
 * Inserts in one statement. ON CONFLICT DO NOTHING makes a re-submitted import
 * idempotent rather than a 500, which matters because the preview the operator
 * saw may be seconds stale.
 */
export async function insertContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  rows: ParsedContact[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, external_ref)
     SELECT c.id, input.e164, input.external_ref
       FROM campaigns c
       JOIN unnest($3::text[], $4::text[]) AS input(e164, external_ref)
         ON true
      WHERE c.tenant_id = $1 AND c.id = $2
     ON CONFLICT (campaign_id, e164) DO NOTHING`,
    [
      tenantId,
      campaignId,
      rows.map((row) => row.e164),
      rows.map((row) => row.externalRef),
    ],
  );
  return result.rowCount ?? 0;
}

export async function deleteContact(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  contactId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM contacts ct
      USING campaigns c
      WHERE c.id = ct.campaign_id
        AND c.tenant_id = $1 AND ct.campaign_id = $2 AND ct.id = $3`,
    [tenantId, campaignId, contactId],
  );
  return (result.rowCount ?? 0) > 0;
}
