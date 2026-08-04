import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import {
  acquireNumber,
  releaseLeaseForCall,
  sweepExpiredLeases,
} from "../src/numbers/pool.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let tenantId: string;
let otherTenantId: string;

beforeAll(() => {
  pool = createPool(testConfig());
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  tenantId = (await seedTenant(pool, "acme")).tenantId;
  otherTenantId = (await seedTenant(pool, "globex")).tenantId;
});

async function addNumber(
  e164: string,
  options: { tenantId?: string | null; maxConcurrent?: number; status?: string } = {},
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO phone_numbers (e164, tenant_id, max_concurrent, status)
          VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      e164,
      options.tenantId ?? null,
      options.maxConcurrent ?? 1,
      options.status ?? "active",
    ],
  );
  return result.rows[0].id as string;
}

describe("acquireNumber", () => {
  it("leases a free shared number", async () => {
    await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    expect(lease?.e164).toBe("+37069000001");
  });

  it("returns null when the pool is empty", async () => {
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("returns null when the only number is already leased", async () => {
    await addNumber("+37069000001");
    await acquireNumber(pool, tenantId);
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("skips a paused number", async () => {
    await addNumber("+37069000001", { status: "paused" });
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("will not lend another tenant's dedicated number", async () => {
    await addNumber("+37069000001", { tenantId: otherTenantId });
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("uses a number dedicated to the asking tenant", async () => {
    await addNumber("+37069000001", { tenantId });
    expect((await acquireNumber(pool, tenantId))?.e164).toBe("+37069000001");
  });

  it("honours max_concurrent above 1", async () => {
    await addNumber("+37069000001", { maxConcurrent: 2 });
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("prefers the least recently used number, spreading load across the pool", async () => {
    await addNumber("+37069000001");
    await addNumber("+37069000002");

    const first = await acquireNumber(pool, tenantId);
    await releaseLeaseForCallless(pool, first!.leaseId);
    const second = await acquireNumber(pool, tenantId);

    expect(second?.e164).not.toBe(first?.e164);
  });

  it("ignores an expired lease, so a lost callback cannot strand the pool", async () => {
    await addNumber("+37069000001");
    const first = await acquireNumber(pool, tenantId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [first!.leaseId],
    );
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  // The reason this file exists.
  it("hands one number to exactly one of twenty simultaneous callers", async () => {
    await addNumber("+37069000001");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireNumber(pool, tenantId)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });

  it("hands three numbers to exactly three of twenty simultaneous callers", async () => {
    await addNumber("+37069000001");
    await addNumber("+37069000002");
    await addNumber("+37069000003");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireNumber(pool, tenantId)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(3);
  });
});

describe("releaseLeaseForCall", () => {
  it("frees the number for the next caller", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    const callId = await makeCall(pool, numberId, lease!.leaseId);

    await releaseLeaseForCall(pool, callId);
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  it("is a no-op for a call that holds no lease", async () => {
    const numberId = await addNumber("+37069000001");
    const callId = await makeCall(pool, numberId, null);
    await expect(releaseLeaseForCall(pool, callId)).resolves.toBeUndefined();
  });
});

describe("sweepExpiredLeases", () => {
  it("releases an expired lease and reports its call", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    const callId = await makeCall(pool, numberId, lease!.leaseId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [lease!.leaseId],
    );

    expect(await sweepExpiredLeases(pool)).toEqual([callId]);
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  it("leaves a live lease alone", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    await makeCall(pool, numberId, lease!.leaseId);
    expect(await sweepExpiredLeases(pool)).toEqual([]);
  });

  it("is idempotent", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    await makeCall(pool, numberId, lease!.leaseId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [lease!.leaseId],
    );
    await sweepExpiredLeases(pool);
    expect(await sweepExpiredLeases(pool)).toEqual([]);
  });
});

/** Creates a campaign, contact, and call so a lease has something to point at. */
async function makeCall(
  db: Pool,
  phoneNumberId: string,
  leaseId: string | null,
): Promise<string> {
  const campaign = await db.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  const contact = await db.query(
    `INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')
       RETURNING id`,
    [campaign.rows[0].id],
  );
  const call = await db.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id)
          VALUES ($1, $2, $3) RETURNING id`,
    [campaign.rows[0].id, contact.rows[0].id, phoneNumberId],
  );
  const callId = call.rows[0].id as string;
  if (leaseId) {
    await db.query("UPDATE number_leases SET call_id = $2 WHERE id = $1", [
      leaseId,
      callId,
    ]);
  }
  return callId;
}

/** Releases by lease id, for the cases that never create a call row. */
async function releaseLeaseForCallless(db: Pool, leaseId: string): Promise<void> {
  await db.query(
    "UPDATE number_leases SET released_at = now() WHERE id = $1",
    [leaseId],
  );
}
