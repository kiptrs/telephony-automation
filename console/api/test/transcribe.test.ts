import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { transcribeRecording, type TranscriptionClient } from "../src/media/transcribe.js";
import { createS3, putObject } from "../src/s3.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let recordingId: string;
let s3Key: string;

class FakeClient implements TranscriptionClient {
  readonly seen: { filename: string; language: string | null; bytes: number }[] = [];

  constructor(private readonly behaviour: { text?: string; throws?: Error } = {}) {}

  async transcribe(args: {
    audio: Buffer;
    filename: string;
    language: string | null;
  }): Promise<{ text: string; raw: unknown }> {
    this.seen.push({
      filename: args.filename,
      language: args.language,
      bytes: args.audio.byteLength,
    });
    if (this.behaviour.throws) throw this.behaviour.throws;
    return {
      text: this.behaviour.text ?? "labas rytas",
      raw: { segments: [] },
    };
  }
}

function deps(client: TranscriptionClient) {
  return { pool, config, s3: createS3(config), client };
}

beforeAll(() => {
  pool = createPool(config);
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls, jobs CASCADE");
  const { tenantId } = await seedTenant(pool, "acme");

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

  s3Key = `tenants/${tenantId}/calls/${call.rows[0].id}/recording.mp3`;
  await putObject(createS3(config), config, {
    key: s3Key,
    body: Buffer.alloc(64, 3),
    contentType: "audio/mpeg",
  });

  const recording = await pool.query(
    `INSERT INTO recordings (call_id, telnyx_recording_id, s3_key, bytes, ingested_at)
          VALUES ($1, 'rec-1', $2, 64, now()) RETURNING id`,
    [call.rows[0].id, s3Key],
  );
  recordingId = recording.rows[0].id as string;

  await pool.query(
    `INSERT INTO transcripts (recording_id, engine, language, status)
          VALUES ($1, 'whisper-1', 'lt', 'pending')`,
    [recordingId],
  );
});

async function transcriptRow() {
  const result = await pool.query(
    "SELECT * FROM transcripts WHERE recording_id = $1",
    [recordingId],
  );
  return result.rows[0];
}

describe("transcribeRecording", () => {
  it("stores the text and marks the transcript done", async () => {
    await transcribeRecording(deps(new FakeClient()), { recordingId });
    const row = await transcriptRow();
    expect(row.status).toBe("done");
    expect(row.text).toBe("labas rytas");
    expect(row.completed_at).not.toBeNull();
  });

  it("passes the campaign's language as the hint", async () => {
    const client = new FakeClient();
    await transcribeRecording(deps(client), { recordingId });
    expect(client.seen[0]?.language).toBe("lt");
  });

  it("sends the audio it read from S3", async () => {
    const client = new FakeClient();
    await transcribeRecording(deps(client), { recordingId });
    expect(client.seen[0]?.bytes).toBe(64);
  });

  it("writes the verbose response to S3 beside the recording", async () => {
    await transcribeRecording(deps(new FakeClient()), { recordingId });
    expect((await transcriptRow()).raw_s3_key).toBe(
      s3Key.replace("recording.mp3", "transcript.json"),
    );
  });

  it("marks the transcript failed with the reason when the engine throws", async () => {
    const client = new FakeClient({ throws: new Error("rate limited") });
    await expect(
      transcribeRecording(deps(client), { recordingId }),
    ).rejects.toThrow(/rate limited/);

    const row = await transcriptRow();
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/rate limited/);
  });

  it("refuses a file above the engine's size limit rather than truncating it", async () => {
    await pool.query(
      "UPDATE recordings SET bytes = $2 WHERE id = $1",
      [recordingId, 30 * 1024 * 1024],
    );
    const client = new FakeClient();
    await expect(
      transcribeRecording(deps(client), { recordingId }),
    ).rejects.toThrow(/too large/);
    expect(client.seen).toHaveLength(0);
    expect((await transcriptRow()).status).toBe("failed");
  });

  it("refuses a recording that has not been ingested yet", async () => {
    await pool.query(
      "UPDATE recordings SET ingested_at = NULL, s3_key = NULL WHERE id = $1",
      [recordingId],
    );
    await expect(
      transcribeRecording(deps(new FakeClient()), { recordingId }),
    ).rejects.toThrow(/not been ingested/);
  });

  it("replaces the text when the same recording is transcribed twice", async () => {
    await transcribeRecording(deps(new FakeClient({ text: "first" })), {
      recordingId,
    });
    await pool.query(
      "UPDATE transcripts SET status = 'pending' WHERE recording_id = $1",
      [recordingId],
    );
    await transcribeRecording(deps(new FakeClient({ text: "second" })), {
      recordingId,
    });

    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM transcripts WHERE recording_id = $1",
      [recordingId],
    );
    expect(rows.rows[0].n).toBe(1);
    expect((await transcriptRow()).text).toBe("second");
  });

  it("marks the transcript running while the engine works", async () => {
    let statusDuringCall: string | undefined;
    const client: TranscriptionClient = {
      transcribe: async () => {
        statusDuringCall = (await transcriptRow()).status;
        return { text: "x", raw: {} };
      },
    };
    await transcribeRecording(deps(client), { recordingId });
    expect(statusDuringCall).toBe("running");
  });
});
