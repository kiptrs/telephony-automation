import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let tenantId: string;
let cookie: string;

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
  const seeded = await seedTenant(pool, "acme");
  tenantId = seeded.tenantId;
  cookie = await loginAs(app, seeded.email);
});

/** A finished campaign holding one done contact with one ended call. */
async function seedFinishedCall(status: "completed" | "paused") {
  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country,
                            thanks_s3_key, status, launched_at)
          VALUES ($1, 'c', 'lt', 'LT', 'tenants/t/thanks.mp3', $2, now())
       RETURNING id`,
    [tenantId, status],
  );
  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, status)
          VALUES ($1, '+37060000001', 'done') RETURNING id`,
    [campaign.rows[0].id],
  );
  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, status, outcome, ended_at)
          VALUES ($1, $2, 'ended', 'no_answer', now()) RETURNING id`,
    [campaign.rows[0].id, contact.rows[0].id],
  );
  return {
    campaignId: campaign.rows[0].id as string,
    contactId: contact.rows[0].id as string,
    callId: call.rows[0].id as string,
  };
}

async function statusOf(table: "campaigns" | "contacts", id: string) {
  const result = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return result.rows[0].status as string;
}

describe("POST /api/calls/:id/retry", () => {
  it("returns the contact to pending", async () => {
    const { callId, contactId } = await seedFinishedCall("completed");
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await statusOf("contacts", contactId)).toBe("pending");
  });

  it("revives a completed campaign so the dispatcher can see the retry", async () => {
    const { callId, campaignId } = await seedFinishedCall("completed");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(await statusOf("campaigns", campaignId)).toBe("running");
  });

  it("leaves a paused campaign paused, because pause is an operator choice", async () => {
    const { callId, campaignId } = await seedFinishedCall("paused");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(await statusOf("campaigns", campaignId)).toBe("paused");
  });

  it("gives another tenant's call a 404, not a 403", async () => {
    const { callId } = await seedFinishedCall("completed");
    const other = await seedTenant(pool, "globex");
    const otherCookie = await loginAs(app, other.email);
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
