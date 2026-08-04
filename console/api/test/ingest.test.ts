import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { ingestRecording, recordingKey } from "../src/media/ingest.js";
import { createS3 } from "../src/s3.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let tenantId: string;
let callId: string;
let recordingId: string;

function deps() {
  return { pool, config, s3: createS3(config) };
}

beforeAll(() => {
  pool = createPool(config);
});
afterAll(async () => {
  await pool.end();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls, jobs CASCADE");
  tenantId = (await seedTenant(pool, "acme")).tenantId;

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')
       RETURNING id`,
    [campaign.rows[0].id],
  );
  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id) VALUES ($1, $2) RETURNING id`,
    [campaign.rows[0].id, contact.rows[0].id],
  );
  callId = call.rows[0].id as string;

  const recording = await pool.query(
    `INSERT INTO recordings (call_id, telnyx_recording_id, source_url)
          VALUES ($1, 'rec-1', 'https://telnyx.example/r.mp3') RETURNING id`,
    [callId],
  );
  recordingId = recording.rows[0].id as string;
});

/** Telnyx download succeeds, delete succeeds. */
function stubTelnyx(options: { deleteStatus?: number; bytes?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "DELETE") {
        const status = options.deleteStatus ?? 200;
        return { ok: status < 400, status, text: async () => "" };
      }
      const body = new Uint8Array(options.bytes ?? 8).fill(7);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(body.byteLength) }),
        arrayBuffer: async () => body.buffer,
      };
    }),
  );
  return calls;
}

async function recordingRow() {
  const result = await pool.query("SELECT * FROM recordings WHERE id = $1", [
    recordingId,
  ]);
  return result.rows[0];
}

describe("recordingKey", () => {
  it("namespaces by tenant and call", () => {
    expect(recordingKey("t-1", "c-1")).toBe("tenants/t-1/calls/c-1/recording.mp3");
  });

  it("is stable, so a retried ingest overwrites rather than duplicating", () => {
    expect(recordingKey("t-1", "c-1")).toBe(recordingKey("t-1", "c-1"));
  });
});

describe("ingestRecording", () => {
  it("stores the S3 key and byte count", async () => {
    stubTelnyx({ bytes: 16 });
    await ingestRecording(deps(), { recordingId });

    const row = await recordingRow();
    expect(row.s3_key).toBe(`tenants/${tenantId}/calls/${callId}/recording.mp3`);
    expect(Number(row.bytes)).toBe(16);
    expect(row.ingested_at).not.toBeNull();
  });

  it("deletes at Telnyx only after the upload", async () => {
    const calls = stubTelnyx();
    await ingestRecording(deps(), { recordingId });

    const downloadIndex = calls.findIndex((call) => call.startsWith("GET"));
    const deleteIndex = calls.findIndex((call) => call.startsWith("DELETE"));
    expect(downloadIndex).toBeLessThan(deleteIndex);
    expect((await recordingRow()).telnyx_deleted_at).not.toBeNull();
  });

  it("does not delete at Telnyx when the download fails", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return { ok: false, status: 500, headers: new Headers(), text: async () => "boom" };
      }),
    );

    await expect(ingestRecording(deps(), { recordingId })).rejects.toThrow();
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(0);
    expect((await recordingRow()).ingested_at).toBeNull();
  });

  it("does not delete at Telnyx when the download is truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "999" }),
        arrayBuffer: async () => new Uint8Array(4).buffer,
      })),
    );
    await expect(ingestRecording(deps(), { recordingId })).rejects.toThrow(
      /truncated/,
    );
    expect((await recordingRow()).ingested_at).toBeNull();
  });

  it("is idempotent - a second run does not re-download", async () => {
    stubTelnyx();
    await ingestRecording(deps(), { recordingId });

    const calls = stubTelnyx();
    await ingestRecording(deps(), { recordingId });
    expect(calls).toHaveLength(0);
  });

  it("retries the Telnyx delete when a previous run uploaded but did not delete", async () => {
    stubTelnyx();
    await ingestRecording(deps(), { recordingId });
    await pool.query(
      "UPDATE recordings SET telnyx_deleted_at = NULL WHERE id = $1",
      [recordingId],
    );

    const calls = stubTelnyx();
    await ingestRecording(deps(), { recordingId });
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(0);
  });

  it("treats a 404 from Telnyx delete as done", async () => {
    stubTelnyx({ deleteStatus: 404 });
    await ingestRecording(deps(), { recordingId });
    expect((await recordingRow()).telnyx_deleted_at).not.toBeNull();
  });

  it("throws for an unknown recording id", async () => {
    await expect(
      ingestRecording(deps(), {
        recordingId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the recording has no source URL to fetch", async () => {
    await pool.query("UPDATE recordings SET source_url = NULL WHERE id = $1", [
      recordingId,
    ]);
    await expect(ingestRecording(deps(), { recordingId })).rejects.toThrow(
      /no source url/,
    );
  });
});
