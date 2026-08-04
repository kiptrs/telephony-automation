import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import {
  createSession,
  deleteSession,
  findUserBySession,
} from "../src/auth/sessions.js";
import { testConfig } from "./helpers.js";

const config = testConfig();

let pool: Pool;
let tenantId: string;

beforeAll(() => {
  pool = createPool(config);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
  const result = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id",
  );
  tenantId = result.rows[0].id as string;
});

async function makeUser(email: string) {
  return insertUser(pool, {
    email,
    passwordHash: await hashPassword("password"),
    role: "member",
    tenantId,
  });
}

describe("sessions", () => {
  it("resolves a live session back to its user", async () => {
    const user = await makeUser("a@acme.com");
    const session = await createSession(pool, user.id);
    const found = await findUserBySession(pool, session.id);
    expect(found?.id).toBe(user.id);
    expect(found?.tenantId).toBe(tenantId);
  });

  it("returns null for an unknown session id", async () => {
    const missing = "11111111-1111-4111-8111-111111111111";
    expect(await findUserBySession(pool, missing)).toBeNull();
  });

  it("refuses an expired session", async () => {
    const user = await makeUser("b@acme.com");
    const session = await createSession(pool, user.id);
    await pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
      [session.id],
    );
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });

  it("revokes immediately on delete, which is why this is not a JWT", async () => {
    const user = await makeUser("c@acme.com");
    const session = await createSession(pool, user.id);
    await deleteSession(pool, session.id);
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });

  it("cascades session deletion when the user is deleted", async () => {
    const user = await makeUser("d@acme.com");
    const session = await createSession(pool, user.id);
    await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });
});
