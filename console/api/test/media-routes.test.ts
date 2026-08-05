import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { TRANSCRIPTION_MODEL } from "../src/media/scribe.js";
import { createS3, putObject } from "../src/s3.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let campaignId: string;
let callId: string;
let recordingId: string;

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
  await pool.query("TRUNCATE phone_numbers, number_leases, calls, jobs CASCADE");
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenant.tenantId],
  );
  campaignId = campaign.rows[0].id as string;

  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')
       RETURNING id`,
    [campaignId],
  );
  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, status, outcome)
          VALUES ($1, $2, 'ended', 'completed') RETURNING id`,
    [campaignId, contact.rows[0].id],
  );
  callId = call.rows[0].id as string;

  const key = `tenants/${tenant.tenantId}/calls/${callId}/recording.mp3`;
  await putObject(createS3(config), config, {
    key,
    body: Buffer.alloc(32, 5),
    contentType: "audio/mpeg",
  });

  const recording = await pool.query(
    `INSERT INTO recordings (call_id, telnyx_recording_id, s3_key, bytes, ingested_at)
          VALUES ($1, 'rec-1', $2, 32, now()) RETURNING id`,
    [callId, key],
  );
  recordingId = recording.rows[0].id as string;
});

describe("POST /api/campaigns/:id/transcribe", () => {
  it("enqueues one job per ingested recording", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().enqueued).toBe(1);

    const jobs = await pool.query("SELECT kind FROM jobs");
    expect(jobs.rows[0].kind).toBe("transcribe");
  });

  it("creates a pending transcript row so the UI can show progress", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    const rows = await pool.query("SELECT status FROM transcripts");
    expect(rows.rows[0].status).toBe("pending");
  });

  it("skips a recording that already has a finished transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, text)
            VALUES ($1, $2, 'done', 'hello')`,
      [recordingId, TRANSCRIPTION_MODEL],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(0);
  });

  it("re-enqueues a recording transcribed by a superseded engine", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, text)
            VALUES ($1, 'whisper-1', 'done', 'hello')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(1);

    const row = await pool.query("SELECT engine, status FROM transcripts");
    expect(row.rows[0].engine).toBe(TRANSCRIPTION_MODEL);
    expect(row.rows[0].status).toBe("pending");
  });

  it("re-enqueues a recording whose transcript failed", async () => {
    // Current engine on purpose, so this tests the failed status and not the
    // superseded-engine rule that the case below covers.
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, error)
            VALUES ($1, $2, 'failed', 'rate limited')`,
      [recordingId, TRANSCRIPTION_MODEL],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(1);
  });

  it("skips a recording that has not been ingested", async () => {
    await pool.query(
      "UPDATE recordings SET ingested_at = NULL WHERE id = $1",
      [recordingId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(0);
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/calls/:id/recording", () => {
  it("returns a presigned URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/recording`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/X-Amz-Signature=/);
  });

  it("returns 404 when the recording is not ingested yet", async () => {
    await pool.query(
      "UPDATE recordings SET ingested_at = NULL, s3_key = NULL WHERE id = $1",
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/recording`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/calls/:id/transcript", () => {
  it("returns the transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, language, status, text)
            VALUES ($1, 'whisper-1', 'lt', 'done', 'labas')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.json().text).toBe("labas");
    expect(response.json().status).toBe("done");
  });

  it("returns 404 when there is none", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the failure reason for a failed transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, error)
            VALUES ($1, 'whisper-1', 'failed', 'file too large')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.json().error).toBe("file too large");
  });
});

describe("GET /api/campaigns/:id/calls", () => {
  it("reports which calls have a playable recording", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/calls`,
      headers: { cookie },
    });
    expect(response.json()[0].hasRecording).toBe(true);
    expect(response.json()[0].transcriptStatus).toBeNull();
  });
});
