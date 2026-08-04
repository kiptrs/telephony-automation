import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const tenantRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export type Tenant = z.infer<typeof tenantRow>;

export async function insertTenant(
  pool: Pool,
  args: { name: string; slug: string },
): Promise<Tenant> {
  const result = await pool.query(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug`,
    [args.name, args.slug],
  );
  return parseExactlyOne(tenantRow, result);
}

export async function findTenantBySlug(
  pool: Pool,
  slug: string,
): Promise<Tenant | null> {
  const result = await pool.query(
    `SELECT id, name, slug FROM tenants WHERE slug = $1`,
    [slug],
  );
  return parseOne(tenantRow, result);
}

export async function listTenants(pool: Pool): Promise<Tenant[]> {
  const result = await pool.query(
    `SELECT id, name, slug FROM tenants ORDER BY created_at`,
  );
  return parseRows(tenantRow, result);
}
