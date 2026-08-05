import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.js";
import {
  findUserByEmail,
  insertUser,
  updatePasswordHash,
} from "../auth/queries.js";
import { deleteSessionsForUser } from "../auth/sessions.js";
import type { Pool } from "../db/client.js";
import { insertNumber, type PhoneNumber } from "../numbers/queries.js";
import {
  findTenantBySlug,
  insertTenant,
  type Tenant,
} from "../tenants/queries.js";

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** 24 base64url characters, roughly 144 bits. Shown once and never stored. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function createTenantCommand(
  pool: Pool,
  args: { name: string; slug: string },
): Promise<Tenant> {
  const existing = await findTenantBySlug(pool, args.slug);
  if (existing) throw new Error(`slug '${args.slug}' already exists`);
  return insertTenant(pool, args);
}

export async function createUserCommand(
  pool: Pool,
  args: { email: string; tenantSlug: string | null; platformAdmin: boolean },
): Promise<{ email: string; role: string; password: string }> {
  if (!args.platformAdmin && args.tenantSlug === null) {
    throw new Error("--tenant is required unless --platform-admin is given");
  }
  if (args.platformAdmin && args.tenantSlug !== null) {
    throw new Error("a platform admin cannot belong to a tenant");
  }

  const existing = await findUserByEmail(pool, args.email);
  if (existing) throw new Error(`a user with email ${args.email} already exists`);

  let tenantId: string | null = null;
  if (args.tenantSlug !== null) {
    const tenant = await findTenantBySlug(pool, args.tenantSlug);
    if (!tenant) throw new Error(`no tenant with slug '${args.tenantSlug}'`);
    tenantId = tenant.id;
  }

  const password = generatePassword();
  const user = await insertUser(pool, {
    email: args.email,
    passwordHash: await hashPassword(password),
    role: args.platformAdmin ? "platform_admin" : "member",
    tenantId,
  });

  return { email: user.email, role: user.role, password };
}

export async function resetPasswordCommand(
  pool: Pool,
  args: { email: string },
): Promise<{ email: string; password: string }> {
  const user = await findUserByEmail(pool, args.email);
  if (!user) throw new Error(`no user with email ${args.email}`);

  const password = generatePassword();
  const updated = await updatePasswordHash(
    pool,
    args.email,
    await hashPassword(password),
  );
  if (!updated) throw new Error(`no user with email ${args.email}`);

  // The whole reason sessions live in Postgres: a reset revokes immediately.
  await deleteSessionsForUser(pool, user.id);

  return { email: args.email, password };
}

export async function addNumberCommand(
  pool: Pool,
  args: { e164: string; telnyxId: string | null; tenantSlug: string | null },
): Promise<PhoneNumber> {
  if (!E164.test(args.e164)) {
    throw new Error(`${args.e164} is not an E.164 number`);
  }

  let tenantId: string | null = null;
  if (args.tenantSlug !== null) {
    const tenant = await findTenantBySlug(pool, args.tenantSlug);
    if (!tenant) throw new Error(`no tenant with slug '${args.tenantSlug}'`);
    tenantId = tenant.id;
  }

  return insertNumber(pool, {
    e164: args.e164,
    telnyxNumberId: args.telnyxId,
    tenantId,
    maxConcurrent: 1,
  });
}
