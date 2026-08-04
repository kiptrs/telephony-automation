import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { createDialer } from "./dispatch/dialer.js";
import { startDispatcher } from "./dispatch/dispatcher.js";
import { PgJobQueue } from "./jobs/pg-queue.js";
import { buildHandlers, startRunner } from "./jobs/runner.js";
import { createS3 } from "./s3.js";

const config = loadConfig(process.env);
const pool = createPool(config);
const s3 = createS3(config);

const dispatcher = startDispatcher({
  pool,
  config,
  s3,
  dialer: createDialer(config),
});

const runner = startRunner({
  queue: new PgJobQueue(pool),
  handlers: buildHandlers({ pool, config, s3 }),
});

console.log(
  JSON.stringify({ msg: "worker_started", dialer: config.dialer }),
);

async function shutdown(): Promise<void> {
  dispatcher.stop();
  runner.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
