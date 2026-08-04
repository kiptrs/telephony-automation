import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import { testConfig } from "./helpers.js";

const config = testConfig();

let pool: Pool;
let app: FastifyInstance;

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
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
  const tenant = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id",
  );
  await insertUser(pool, {
    email: "a@acme.com",
    passwordHash: await hashPassword("password123"),
    role: "member",
    tenantId: tenant.rows[0].id as string,
  });
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("no session cookie was set");
  return value.split(";")[0] ?? "";
}

describe("POST /api/auth/login", () => {
  it("sets a session cookie for correct credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    expect(response.statusCode).toBe(200);
    expect(cookieFrom(response)).toMatch(/^console_session=/);
  });

  it("marks the cookie httpOnly and SameSite=Lax", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const raw = response.headers["set-cookie"];
    const value = Array.isArray(raw) ? raw[0] : String(raw);
    expect(value).toMatch(/HttpOnly/i);
    expect(value).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("gives an unknown email the same 401 and message as a wrong password", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@acme.com", password: "password123" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "wrong" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("rejects a malformed body with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the logged-in user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieFrom(login) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe("a@acme.com");
    expect(response.json().tenantId).toEqual(expect.any(String));
  });

  it("returns 401 without a cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a garbage cookie rather than failing to parse a uuid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "console_session=not-a-uuid" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the session immediately", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const cookie = cookieFrom(login);

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
