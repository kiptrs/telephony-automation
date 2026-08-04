import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import {
  loginAs,
  resetDatabase,
  seedTenant,
  testConfig,
  TEST_PASSWORD,
} from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  pool = createPool(config);
  app = buildApp({ pool, config });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  const tenant = await seedTenant(pool, "acme");
  memberCookie = await loginAs(app, tenant.email);

  await insertUser(pool, {
    email: "ops@example.com",
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: "platform_admin",
    tenantId: null,
  });
  adminCookie = await loginAs(app, "ops@example.com");
});

function addNumber(body: object, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/admin/numbers",
    headers: { cookie },
    payload: body,
  });
}

describe("admin numbers", () => {
  it("adds a number to the shared pool", async () => {
    const response = await addNumber({ e164: "+37069000001" });
    expect(response.statusCode).toBe(201);
    expect(response.json().tenantId).toBeNull();
    expect(response.json().maxConcurrent).toBe(1);
  });

  it("refuses a duplicate number", async () => {
    await addNumber({ e164: "+37069000001" });
    expect((await addNumber({ e164: "+37069000001" })).statusCode).toBe(409);
  });

  it("refuses a number that is not E.164", async () => {
    expect((await addNumber({ e164: "069000001" })).statusCode).toBe(400);
  });

  it("reports live lease usage", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    await pool.query(
      `INSERT INTO number_leases (phone_number_id, expires_at)
            VALUES ($1, now() + interval '8 minutes')`,
      [created.id],
    );
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/numbers",
      headers: { cookie: adminCookie },
    });
    expect(list.json()[0].activeLeases).toBe(1);
  });

  it("assigns a number to a tenant and back to the shared pool", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    const tenants = await app.inject({
      method: "GET",
      url: "/api/admin/tenants",
      headers: { cookie: adminCookie },
    });
    const tenantId = tenants.json()[0].id;

    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { tenantId },
    });
    expect(assigned.json().tenantId).toBe(tenantId);

    const shared = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { tenantId: null },
    });
    expect(shared.json().tenantId).toBeNull();
  });

  it("pauses a number", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "paused" },
    });
    expect(response.json().status).toBe("paused");
  });

  it("refuses a tenant member with 403, not 404", async () => {
    // The pool is platform infrastructure, so its existence is not a secret
    // from a signed-in operator - only its contents are off limits.
    expect((await addNumber({ e164: "+37069000002" }, memberCookie)).statusCode).toBe(
      403,
    );
  });

  it("refuses a member reading the pool", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/numbers",
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses an anonymous request with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/numbers" });
    expect(response.statusCode).toBe(401);
  });
});
