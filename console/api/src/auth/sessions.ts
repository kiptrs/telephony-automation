import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne } from "../db/rows.js";
import { roleSchema, type AuthenticatedUser } from "./queries.js";

/** Absolute expiry with no sliding renewal - see the spec's Authentication section. */
export const SESSION_TTL_DAYS = 7;

const createdRow = z.object({
  id: z.string().uuid(),
  expires_at: z.date(),
});

const sessionUserRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  email: z.string(),
  role: roleSchema,
});

export async function createSession(
  pool: Pool,
  userId: string,
): Promise<{ id: string; expiresAt: Date }> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, expires_at)
          VALUES ($1, now() + make_interval(days => $2))
       RETURNING id, expires_at`,
    [userId, SESSION_TTL_DAYS],
  );
  const row = parseExactlyOne(createdRow, result);
  return { id: row.id, expiresAt: row.expires_at };
}

/**
 * Expiry is filtered in SQL rather than compared in JS so the database clock is
 * the only clock that matters.
 */
export async function findUserBySession(
  pool: Pool,
  sessionId: string,
): Promise<AuthenticatedUser | null> {
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = parseOne(sessionUserRow, result);
  if (row === null) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
  };
}

export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

export async function deleteSessionsForUser(
  pool: Pool,
  userId: string,
): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}
