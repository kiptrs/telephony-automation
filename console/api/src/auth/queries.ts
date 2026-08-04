import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { parseExactlyOne, parseOne } from "../db/rows.js";

export const roleSchema = z.enum(["platform_admin", "member"]);
export type Role = z.infer<typeof roleSchema>;

export interface AuthenticatedUser {
  id: string;
  tenantId: string | null;
  email: string;
  role: Role;
}

const userRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  email: z.string(),
  role: roleSchema,
});

const userWithHashRow = userRow.extend({ password_hash: z.string() });

function toUser(row: z.infer<typeof userRow>): AuthenticatedUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
  };
}

export async function findUserByEmail(
  pool: Pool,
  email: string,
): Promise<(AuthenticatedUser & { passwordHash: string }) | null> {
  const result = await pool.query(
    `SELECT id, tenant_id, email, role, password_hash
       FROM users
      WHERE email = $1`,
    [email],
  );
  const row = parseOne(userWithHashRow, result);
  if (row === null) return null;
  return { ...toUser(row), passwordHash: row.password_hash };
}

export async function insertUser(
  client: Pool | PoolClient,
  args: {
    email: string;
    passwordHash: string;
    role: Role;
    tenantId: string | null;
  },
): Promise<AuthenticatedUser> {
  const result = await client.query(
    `INSERT INTO users (email, password_hash, role, tenant_id)
          VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, email, role`,
    [args.email, args.passwordHash, args.role, args.tenantId],
  );
  return toUser(parseExactlyOne(userRow, result));
}

export async function updatePasswordHash(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET password_hash = $2 WHERE email = $1`,
    [email, passwordHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export const sessionUserRow = userRow;
