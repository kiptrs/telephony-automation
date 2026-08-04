import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import { parseExactlyOne, parseRows } from "../db/rows.js";

/**
 * Longer than any possible call - 60s of ring plus ten questions at 40s each
 * is under seven minutes - so a live call can never have its number stolen.
 */
export const LEASE_MINUTES = 8;

export interface AcquiredLease {
  leaseId: string;
  phoneNumberId: string;
  e164: string;
}

const candidateIdRow = z.object({ id: z.string().uuid() });

const lockedRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  max_concurrent: z.number().int(),
});

const countRow = z.object({ active_leases: z.number().int() });

/**
 * Leases a number for one call, or returns null when none is free.
 *
 * The candidates are listed unlocked, then locked one at a time with FOR UPDATE
 * SKIP LOCKED. The lease count is re-read inside that lock, which is what makes
 * two concurrent ticks unable to both take the same number: filtering on an
 * aggregate before the lock is not re-evaluated after it under READ COMMITTED.
 *
 * Locking one row at a time rather than the whole candidate set matters. If a
 * tick locked every row it could see, a second tick arriving mid-flight would
 * skip all of them and report an empty pool while numbers were still free -
 * three free numbers would then hand out fewer than three leases.
 *
 * That makes this O(pool size) round trips in the worst case, one in the
 * common case. It is correct and obviously so for a pool in the tens. If the
 * pool ever reaches the low hundreds, replace it with a denormalised
 * active_leases counter column on phone_numbers updated in the same
 * transaction - a change confined to this file.
 */
export async function acquireNumber(
  pool: Pool,
  tenantId: string,
): Promise<AcquiredLease | null> {
  return withTransaction(pool, async (client) => {
    const candidates = await client.query(
      `SELECT pn.id
         FROM phone_numbers pn
        WHERE pn.status = 'active'
          AND (pn.tenant_id IS NULL OR pn.tenant_id = $1)
        ORDER BY pn.last_used_at NULLS FIRST, pn.id`,
      [tenantId],
    );

    for (const candidate of parseRows(candidateIdRow, candidates)) {
      const locked = await client.query(
        `SELECT pn.id, pn.e164, pn.max_concurrent
           FROM phone_numbers pn
          WHERE pn.id = $1 AND pn.status = 'active'
            FOR UPDATE SKIP LOCKED`,
        [candidate.id],
      );

      // Skipped means another tick holds it and is about to take it.
      const chosen = parseRows(lockedRow, locked)[0];
      if (!chosen) continue;

      // A separate statement, so its snapshot is taken after the row lock was
      // acquired. Counting inside the locking statement would use the snapshot
      // from before the lock and miss a lease another tick had just committed,
      // handing the same number out twice.
      const counted = await client.query(
        `SELECT count(*)::int AS active_leases
           FROM number_leases
          WHERE phone_number_id = $1
            AND released_at IS NULL
            AND expires_at > now()`,
        [chosen.id],
      );
      const { active_leases: activeLeases } = parseExactlyOne(countRow, counted);
      if (activeLeases >= chosen.max_concurrent) continue;

      const lease = await client.query(
        `INSERT INTO number_leases (phone_number_id, expires_at)
              VALUES ($1, now() + make_interval(mins => $2))
           RETURNING id`,
        [chosen.id, LEASE_MINUTES],
      );

      await client.query(
        `UPDATE phone_numbers SET last_used_at = now() WHERE id = $1`,
        [chosen.id],
      );

      return {
        leaseId: lease.rows[0].id as string,
        phoneNumberId: chosen.id,
        e164: chosen.e164,
      };
    }

    return null;
  });
}

/** Called inside the dispatcher's transaction once the call row exists. */
export async function attachLeaseToCall(
  client: PoolClient,
  leaseId: string,
  callId: string,
): Promise<void> {
  await client.query(`UPDATE number_leases SET call_id = $2 WHERE id = $1`, [
    leaseId,
    callId,
  ]);
}

export async function releaseLeaseForCall(
  pool: Pool,
  callId: string,
): Promise<void> {
  await pool.query(
    `UPDATE number_leases SET released_at = now()
      WHERE call_id = $1 AND released_at IS NULL`,
    [callId],
  );
}

export async function releaseLease(pool: Pool, leaseId: string): Promise<void> {
  await pool.query(
    `UPDATE number_leases SET released_at = now()
      WHERE id = $1 AND released_at IS NULL`,
    [leaseId],
  );
}

/**
 * Frees leases whose call never reported a hangup. Returns the call ids so the
 * dispatcher can mark them ended with an unknown outcome.
 */
export async function sweepExpiredLeases(pool: Pool): Promise<string[]> {
  const result = await pool.query(
    `UPDATE number_leases
        SET released_at = now()
      WHERE released_at IS NULL AND expires_at < now()
      RETURNING call_id`,
    [],
  );
  return parseRows(z.object({ call_id: z.string().uuid().nullable() }), result)
    .map((row) => row.call_id)
    .filter((id): id is string => id !== null);
}
