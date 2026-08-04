import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let tenantId: string;
let campaignId: string;

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
  tenantId = tenant.tenantId;
  cookie = await loginAs(app, tenant.email);

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  campaignId = campaign.rows[0].id as string;
});

async function makeLaunchable(): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                     original_filename, bytes)
          VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
    [campaignId],
  );
  await pool.query(
    "UPDATE campaigns SET thanks_s3_key = 'k/thanks.mp3' WHERE id = $1",
    [campaignId],
  );
  await pool.query(
    "INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')",
    [campaignId],
  );
}

function launch() {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/launch`,
    headers: { cookie },
  });
}

describe("POST /api/campaigns/:id/launch", () => {
  it("moves a complete campaign to running", async () => {
    await makeLaunchable();
    const response = await launch();
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("running");
  });

  it("stamps launched_at", async () => {
    await makeLaunchable();
    await launch();
    const row = await pool.query("SELECT launched_at FROM campaigns WHERE id = $1", [
      campaignId,
    ]);
    expect(row.rows[0].launched_at).not.toBeNull();
  });

  it("refuses a campaign with no questions and says why", async () => {
    const response = await launch();
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers).toContain("upload at least one question");
  });

  it("refuses a campaign with no contacts", async () => {
    await pool.query(
      `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                       original_filename, bytes)
            VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
      [campaignId],
    );
    await pool.query(
      "UPDATE campaigns SET thanks_s3_key = 'k/thanks.mp3' WHERE id = $1",
      [campaignId],
    );
    expect((await launch()).json().blockers).toContain(
      "import at least one contact",
    );
  });

  it("refuses a campaign with no thank-you audio", async () => {
    await pool.query(
      `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                       original_filename, bytes)
            VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
      [campaignId],
    );
    await pool.query(
      "INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')",
      [campaignId],
    );
    expect((await launch()).json().blockers).toContain("upload the thank-you audio");
  });

  it("refuses to relaunch a campaign that is already running", async () => {
    await makeLaunchable();
    await launch();
    expect((await launch()).statusCode).toBe(409);
  });
});

describe("POST /api/campaigns/:id/pause", () => {
  it("pauses a running campaign", async () => {
    await makeLaunchable();
    await launch();
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect(response.json().status).toBe("paused");
  });

  it("resumes from paused through launch", async () => {
    await makeLaunchable();
    await launch();
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect((await launch()).json().status).toBe("running");
  });

  it("refuses to pause a draft", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("POST /api/calls/:id/retry", () => {
  async function endedCall(outcome: string): Promise<string> {
    const number = await pool.query(
      "INSERT INTO phone_numbers (e164) VALUES ('+37069000001') RETURNING id",
    );
    const contact = await pool.query(
      `INSERT INTO contacts (campaign_id, e164, status)
            VALUES ($1, '+37060000009', 'done') RETURNING id`,
      [campaignId],
    );
    const call = await pool.query(
      `INSERT INTO calls (campaign_id, contact_id, phone_number_id, status, outcome,
                          ended_at)
            VALUES ($1, $2, $3, 'ended', $4, now()) RETURNING id`,
      [campaignId, contact.rows[0].id, number.rows[0].id, outcome],
    );
    return call.rows[0].id as string;
  }

  it("returns the contact to pending so the dispatcher picks it up", async () => {
    const callId = await endedCall("no_answer");
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const contact = await pool.query(
      "SELECT status FROM contacts WHERE e164 = '+37060000009'",
    );
    expect(contact.rows[0].status).toBe("pending");
  });

  it("leaves the original call row intact as history", async () => {
    const callId = await endedCall("no_answer");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    const call = await pool.query("SELECT outcome FROM calls WHERE id = $1", [
      callId,
    ]);
    expect(call.rows[0].outcome).toBe("no_answer");
  });

  it("refuses to retry a call that has not ended", async () => {
    const callId = await endedCall("no_answer");
    await pool.query("UPDATE calls SET status = 'in_progress' WHERE id = $1", [
      callId,
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 404 for an unknown call", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/retry",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
