import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Pool } from "../src/db/client.js";

export const TEST_PASSWORD = "test-password-123";

export function testConfig(): Config {
  return loadConfig({
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgres://console:console@localhost:5432/console",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    S3_BUCKET: "console-dev",
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    NODE_ENV: "test",
    WORKER_BASE_URL: "https://worker.example",
    WORKER_TRIGGER_SECRET: "trigger-secret",
    WORKER_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: "https://console.example",
    DIALER: "fake",
    TELNYX_API_KEY: "telnyx-key",
    OPENAI_API_KEY: "openai-key",
  });
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
}

/** Creates a tenant plus one member, and returns both plus that member's cookie-ready credentials. */
export async function seedTenant(
  pool: Pool,
  slug: string,
): Promise<{ tenantId: string; email: string; userId: string }> {
  const tenant = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ($1, $1) RETURNING id",
    [slug],
  );
  const tenantId = tenant.rows[0].id as string;
  const email = `user@${slug}.test`;
  const user = await insertUser(pool, {
    email,
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: "member",
    tenantId,
  });
  return { tenantId, email, userId: user.id };
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${response.statusCode}`);
  }
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("no session cookie");
  return value.split(";")[0] ?? "";
}
