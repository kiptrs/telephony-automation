import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseRows } from "../db/rows.js";
import type { Job, JobKind, JobQueue } from "./queue.js";

/** A runner that dies mid-job holds its lock this long before it is reclaimed. */
const LOCK_TIMEOUT_MINUTES = 5;

/** 15s, 30s, 60s, 120s, ... capped at an hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 3600);
}

const jobRow = z.object({
  id: z.string().uuid(),
  kind: z.enum(["ingest_recording", "transcribe"]),
  payload: z.unknown(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
});

export class PgJobQueue implements JobQueue {
  constructor(private readonly pool: Pool) {}

  async enqueue(kind: JobKind, payload: unknown, runAt?: Date): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO jobs (kind, payload, run_at)
            VALUES ($1, $2::jsonb, COALESCE($3, now()))
         RETURNING id`,
      [kind, JSON.stringify(payload), runAt ?? null],
    );
    return parseExactlyOne(z.object({ id: z.string().uuid() }), result).id;
  }

  /**
   * Claim and lock in one statement. SKIP LOCKED inside the subquery is what
   * lets several runners drain the same table without ever colliding.
   */
  async claim(limit: number, lockedBy: string): Promise<Job[]> {
    const result = await this.pool.query(
      `UPDATE jobs
          SET locked_at = now(), locked_by = $2
        WHERE id IN (
          SELECT id FROM jobs
           WHERE completed_at IS NULL
             AND failed_at IS NULL
             AND run_at <= now()
             AND (locked_at IS NULL
                  OR locked_at < now() - make_interval(mins => $3))
           ORDER BY run_at
             FOR UPDATE SKIP LOCKED
           LIMIT $1)
        RETURNING id, kind, payload, attempts, max_attempts`,
      [limit, lockedBy, LOCK_TIMEOUT_MINUTES],
    );

    return parseRows(jobRow, result).map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET completed_at = now(), locked_at = NULL WHERE id = $1`,
      [id],
    );
  }

  /**
   * Increments the attempt count and either reschedules with backoff or gives
   * up. Giving up leaves the row visible with its error rather than deleting
   * the evidence.
   */
  async fail(id: string, error: string): Promise<void> {
    // Every expression in SET reads the pre-update row, so `attempts` here is
    // the old count. backoffSeconds(old + 1) is 15 * 2^old, which is what the
    // interval below computes - one statement, no read-back needed.
    await this.pool.query(
      `UPDATE jobs
          SET attempts = attempts + 1,
              last_error = $2,
              locked_at = NULL,
              locked_by = NULL,
              run_at = now() + make_interval(
                secs => LEAST(15 * power(2, attempts)::int, 3600)),
              failed_at = CASE WHEN attempts + 1 >= max_attempts
                               THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, error.slice(0, 2000)],
    );
  }
}
