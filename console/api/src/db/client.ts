import pg from "pg";
import type { Config } from "../config.js";

const { Pool, types } = pg;

// node-postgres returns bigint as a string to avoid precision loss. Every
// bigint column in this schema is a byte count that fits in a JS number, and
// silently receiving a string where a number is expected is worse than the
// theoretical overflow.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export type { Pool, PoolClient } from "pg";

export function createPool(config: Config): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Runs fn inside a transaction, rolling back on any throw. Callers must use
 * the supplied client, not the pool, or their statements land outside the
 * transaction and the rollback silently does nothing.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
