import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTenantCommand,
  createUserCommand,
  generatePassword,
  resetPasswordCommand,
} from "../src/cli/commands.js";
import { verifyPassword } from "../src/auth/passwords.js";
import { findUserByEmail } from "../src/auth/queries.js";
import { createPool, type Pool } from "../src/db/client.js";
import { testConfig } from "./helpers.js";

const config = testConfig();

let pool: Pool;

beforeAll(() => {
  pool = createPool(config);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
});

describe("generatePassword", () => {
  it("is long enough to resist offline guessing", () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(20);
  });

  it("differs every call", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("createTenantCommand", () => {
  it("creates a tenant", async () => {
    const tenant = await createTenantCommand(pool, {
      name: "Acme",
      slug: "acme",
    });
    expect(tenant.slug).toBe("acme");
  });

  it("refuses a duplicate slug with a readable message", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    await expect(
      createTenantCommand(pool, { name: "Other", slug: "acme" }),
    ).rejects.toThrow(/slug 'acme' already exists/);
  });
});

describe("createUserCommand", () => {
  it("creates a member inside a tenant and returns the password once", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    const created = await createUserCommand(pool, {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    });

    expect(created.password).toEqual(expect.any(String));
    const stored = await findUserByEmail(pool, "a@acme.com");
    expect(stored?.role).toBe("member");
    expect(await verifyPassword(stored!.passwordHash, created.password)).toBe(true);
  });

  it("creates a platform admin with no tenant", async () => {
    await createUserCommand(pool, {
      email: "ops@example.com",
      tenantSlug: null,
      platformAdmin: true,
    });
    const stored = await findUserByEmail(pool, "ops@example.com");
    expect(stored?.role).toBe("platform_admin");
    expect(stored?.tenantId).toBeNull();
  });

  it("refuses a member with no tenant, rather than letting the DB check fire", async () => {
    await expect(
      createUserCommand(pool, {
        email: "a@acme.com",
        tenantSlug: null,
        platformAdmin: false,
      }),
    ).rejects.toThrow(/--tenant is required/);
  });

  it("refuses an unknown tenant slug", async () => {
    await expect(
      createUserCommand(pool, {
        email: "a@acme.com",
        tenantSlug: "nope",
        platformAdmin: false,
      }),
    ).rejects.toThrow(/no tenant with slug 'nope'/);
  });

  it("refuses a duplicate email", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    const args = {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    };
    await createUserCommand(pool, args);
    await expect(createUserCommand(pool, args)).rejects.toThrow(/already exists/);
  });
});

describe("resetPasswordCommand", () => {
  it("replaces the hash and returns the new password", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    await createUserCommand(pool, {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    });

    const reset = await resetPasswordCommand(pool, { email: "a@acme.com" });
    const stored = await findUserByEmail(pool, "a@acme.com");
    expect(await verifyPassword(stored!.passwordHash, reset.password)).toBe(true);
  });

  it("refuses an unknown email", async () => {
    await expect(
      resetPasswordCommand(pool, { email: "nobody@acme.com" }),
    ).rejects.toThrow(/no user with email/);
  });
});
