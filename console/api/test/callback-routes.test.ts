import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let callId: string;
let contactId: string;

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
  await pool.query("TRUNCATE jobs");
  const { tenantId } = await seedTenant(pool, "acme");

  const number = await pool.query(
    "INSERT INTO phone_numbers (e164) VALUES ('+37069000001') RETURNING id",
  );
  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, status)
          VALUES ($1, '+37060000001', 'dialing') RETURNING id`,
    [campaign.rows[0].id],
  );
  contactId = contact.rows[0].id as string;

  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id,
                        telnyx_call_control_id, status)
          VALUES ($1, $2, $3, 'ccid-1', 'dialing') RETURNING id`,
    [campaign.rows[0].id, contactId, number.rows[0].id],
  );
  callId = call.rows[0].id as string;

  await pool.query(
    `INSERT INTO number_leases (phone_number_id, call_id, expires_at)
          VALUES ($1, $2, now() + interval '8 minutes')`,
    [number.rows[0].id, callId],
  );
});

function send(body: unknown, options: { secret?: string } = {}) {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac(
    "sha256",
    options.secret ?? config.worker.hmacSecret,
  )
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return app.inject({
    method: "POST",
    url: "/callbacks/worker",
    headers: {
      "content-type": "application/json",
      "x-console-timestamp": timestamp,
      "x-console-signature": `sha256=${signature}`,
    },
    payload,
  });
}

const base = {
  call_control_id: "ccid-1",
  occurred_at: "2026-08-05T10:00:00.000Z",
  payload: {},
};

async function callRow() {
  const result = await pool.query("SELECT * FROM calls WHERE id = $1", [callId]);
  return result.rows[0];
}

describe("POST /callbacks/worker", () => {
  it("rejects an unsigned request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/callbacks/worker",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...base, event: "call.answered", step: null }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const response = await send(
      { ...base, event: "call.answered", step: null },
      { secret: "wrong-secret-wrong-secret-wrong!" },
    );
    expect(response.statusCode).toBe(401);
  });

  it("marks the call in progress on call.answered", async () => {
    await send({ ...base, event: "call.answered", step: null });
    const row = await callRow();
    expect(row.status).toBe("in_progress");
    expect(row.answered_at).not.toBeNull();
  });

  it("records a completed survey on hangup at step done", async () => {
    await send({ ...base, event: "call.answered", step: null });
    await send({
      ...base,
      event: "call.hangup",
      step: "done",
      payload: { hangup_cause: "normal_clearing" },
    });
    const row = await callRow();
    expect(row.status).toBe("ended");
    expect(row.outcome).toBe("completed");
    expect(row.last_step).toBe(0);
  });

  it("records abandonment with the question the caller reached", async () => {
    await send({ ...base, event: "call.answered", step: null });
    await send({ ...base, event: "call.hangup", step: 2 });
    const row = await callRow();
    expect(row.outcome).toBe("abandoned");
    expect(row.last_step).toBe(2);
  });

  it("records no_answer when the call was never answered", async () => {
    await send({
      ...base,
      event: "call.hangup",
      step: null,
      payload: { hangup_cause: "no_answer" },
    });
    expect((await callRow()).outcome).toBe("no_answer");
  });

  it("releases the number lease on hangup", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    const leases = await pool.query(
      "SELECT released_at FROM number_leases WHERE call_id = $1",
      [callId],
    );
    expect(leases.rows[0].released_at).not.toBeNull();
  });

  it("marks the contact done on hangup", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    const contact = await pool.query("SELECT status FROM contacts WHERE id = $1", [
      contactId,
    ]);
    expect(contact.rows[0].status).toBe("done");
  });

  it("ignores a replayed call.answered after the call ended", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    await send({ ...base, event: "call.answered", step: null });
    expect((await callRow()).status).toBe("ended");
  });

  it("keeps the first outcome when hangup is delivered twice", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    await send({ ...base, event: "call.hangup", step: 1 });
    expect((await callRow()).outcome).toBe("completed");
  });

  it("returns 200 for an unknown call rather than inviting a retry", async () => {
    const response = await send({
      ...base,
      call_control_id: "ccid-unknown",
      event: "call.hangup",
      step: "done",
    });
    expect(response.statusCode).toBe(200);
  });

  it("acknowledges call.recording.saved", async () => {
    const response = await send({
      ...base,
      event: "call.recording.saved",
      step: null,
      payload: { recording_id: "rec-1" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("records the recording and enqueues an ingest job", async () => {
    await send({
      ...base,
      event: "call.recording.saved",
      step: null,
      payload: {
        recording_id: "rec-1",
        channels: "dual",
        recording_urls: { mp3: "https://telnyx.example/r.mp3" },
      },
    });

    const recordings = await pool.query("SELECT * FROM recordings");
    expect(recordings.rowCount).toBe(1);
    expect(recordings.rows[0].source_url).toBe("https://telnyx.example/r.mp3");

    const jobs = await pool.query("SELECT kind, payload FROM jobs");
    expect(jobs.rows[0].kind).toBe("ingest_recording");
    expect(jobs.rows[0].payload.recordingId).toBe(recordings.rows[0].id);
  });

  it("enqueues exactly one ingest job when the event is delivered twice", async () => {
    const event = {
      ...base,
      event: "call.recording.saved",
      step: null,
      payload: {
        recording_id: "rec-1",
        recording_urls: { mp3: "https://telnyx.example/r.mp3" },
      },
    };
    await send(event);
    await send(event);

    const jobs = await pool.query("SELECT count(*)::int AS n FROM jobs");
    expect(jobs.rows[0].n).toBe(1);
  });

  it("ignores a recording event with no recording_id", async () => {
    const response = await send({
      ...base,
      event: "call.recording.saved",
      step: null,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT * FROM jobs")).rowCount).toBe(0);
  });
});
