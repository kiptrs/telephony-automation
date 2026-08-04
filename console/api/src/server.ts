import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";

const config = loadConfig(process.env);
const pool = createPool(config);
const app = buildApp({ pool, config });

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await app.listen({ port: config.port, host: "0.0.0.0" });
