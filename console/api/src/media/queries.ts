import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseOne, parseRows } from "../db/rows.js";

const recordingRow = z.object({
  id: z.string().uuid(),
  call_id: z.string().uuid(),
  telnyx_recording_id: z.string(),
  source_url: z.string().nullable(),
  s3_key: z.string().nullable(),
  bytes: z.number().int().nullable(),
  ingested_at: z.date().nullable(),
  telnyx_deleted_at: z.date().nullable(),
});

export interface Recording {
  id: string;
  callId: string;
  telnyxRecordingId: string;
  sourceUrl: string | null;
  s3Key: string | null;
  bytes: number | null;
  ingestedAt: Date | null;
  telnyxDeletedAt: Date | null;
}

function toRecording(row: z.infer<typeof recordingRow>): Recording {
  return {
    id: row.id,
    callId: row.call_id,
    telnyxRecordingId: row.telnyx_recording_id,
    sourceUrl: row.source_url,
    s3Key: row.s3_key,
    bytes: row.bytes,
    ingestedAt: row.ingested_at,
    telnyxDeletedAt: row.telnyx_deleted_at,
  };
}

const SELECT_RECORDING = `
  SELECT id, call_id, telnyx_recording_id, source_url, s3_key, bytes,
         ingested_at, telnyx_deleted_at
    FROM recordings
`;

/**
 * ON CONFLICT DO NOTHING plus RETURNING means a replayed call.recording.saved
 * inserts nothing and returns nothing, so the caller knows not to re-enqueue.
 */
export async function insertRecording(
  pool: Pool,
  args: {
    callId: string;
    telnyxRecordingId: string;
    sourceUrl: string | null;
    channels: string | null;
  },
): Promise<Recording | null> {
  const result = await pool.query(
    `INSERT INTO recordings (call_id, telnyx_recording_id, source_url, channels)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (telnyx_recording_id) DO NOTHING
       RETURNING id, call_id, telnyx_recording_id, source_url, s3_key, bytes,
                 ingested_at, telnyx_deleted_at`,
    [args.callId, args.telnyxRecordingId, args.sourceUrl, args.channels],
  );
  const row = parseOne(recordingRow, result);
  return row === null ? null : toRecording(row);
}

export async function findRecording(
  pool: Pool,
  id: string,
): Promise<Recording | null> {
  const result = await pool.query(`${SELECT_RECORDING} WHERE id = $1`, [id]);
  const row = parseOne(recordingRow, result);
  return row === null ? null : toRecording(row);
}

export async function markIngested(
  pool: Pool,
  args: { id: string; s3Key: string; bytes: number },
): Promise<void> {
  await pool.query(
    `UPDATE recordings SET s3_key = $2, bytes = $3, ingested_at = now()
      WHERE id = $1`,
    [args.id, args.s3Key, args.bytes],
  );
}

export async function markTelnyxDeleted(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE recordings SET telnyx_deleted_at = now() WHERE id = $1`,
    [id],
  );
}

export async function findRecordingForCall(
  pool: Pool,
  tenantId: string,
  callId: string,
): Promise<Recording | null> {
  const result = await pool.query(
    `SELECT r.id, r.call_id, r.telnyx_recording_id, r.source_url, r.s3_key,
            r.bytes, r.ingested_at, r.telnyx_deleted_at
       FROM recordings r
       JOIN calls ca ON ca.id = r.call_id
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.tenant_id = $1 AND r.call_id = $2`,
    [tenantId, callId],
  );
  const row = parseOne(recordingRow, result);
  return row === null ? null : toRecording(row);
}

/**
 * Recordings in this campaign that are in S3 and have no finished transcript.
 * This is what the "Transcribe" button enqueues.
 */
export async function recordingsAwaitingTranscript(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT r.id
       FROM recordings r
       JOIN calls ca ON ca.id = r.call_id
       JOIN campaigns c ON c.id = ca.campaign_id
       LEFT JOIN transcripts t ON t.recording_id = r.id
      WHERE c.tenant_id = $1 AND ca.campaign_id = $2
        AND r.ingested_at IS NOT NULL
        AND (t.id IS NULL OR t.status = 'failed')`,
    [tenantId, campaignId],
  );
  return parseRows(z.object({ id: z.string().uuid() }), result).map(
    (row) => row.id,
  );
}

/** Re-transcribing replaces the previous row rather than accumulating rows. */
export async function upsertTranscript(
  pool: Pool,
  args: { recordingId: string; engine: string; language: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO transcripts (recording_id, engine, language, status)
          VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (recording_id) DO UPDATE
        SET engine = EXCLUDED.engine,
            language = EXCLUDED.language,
            status = 'pending',
            text = NULL,
            raw_s3_key = NULL,
            error = NULL,
            completed_at = NULL`,
    [args.recordingId, args.engine, args.language],
  );
}

export async function markTranscriptRunning(
  pool: Pool,
  recordingId: string,
): Promise<void> {
  await pool.query(
    `UPDATE transcripts SET status = 'running' WHERE recording_id = $1`,
    [recordingId],
  );
}

export async function markTranscriptDone(
  pool: Pool,
  args: { recordingId: string; text: string; rawS3Key: string },
): Promise<void> {
  await pool.query(
    `UPDATE transcripts
        SET status = 'done', text = $2, raw_s3_key = $3, error = NULL,
            completed_at = now()
      WHERE recording_id = $1`,
    [args.recordingId, args.text, args.rawS3Key],
  );
}

export async function markTranscriptFailed(
  pool: Pool,
  recordingId: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE transcripts SET status = 'failed', error = $2, completed_at = now()
      WHERE recording_id = $1`,
    [recordingId, error.slice(0, 2000)],
  );
}

const transcriptRow = z.object({
  status: z.enum(["pending", "running", "done", "failed"]),
  text: z.string().nullable(),
  language: z.string().nullable(),
  engine: z.string(),
  error: z.string().nullable(),
});

export type Transcript = z.infer<typeof transcriptRow>;

export async function findTranscriptForCall(
  pool: Pool,
  tenantId: string,
  callId: string,
): Promise<Transcript | null> {
  const result = await pool.query(
    `SELECT t.status, t.text, t.language, t.engine, t.error
       FROM transcripts t
       JOIN recordings r ON r.id = t.recording_id
       JOIN calls ca ON ca.id = r.call_id
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.tenant_id = $1 AND ca.id = $2`,
    [tenantId, callId],
  );
  return parseOne(transcriptRow, result);
}

export async function campaignLanguageForRecording(
  pool: Pool,
  recordingId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT c.language
       FROM recordings r
       JOIN calls ca ON ca.id = r.call_id
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE r.id = $1`,
    [recordingId],
  );
  return parseOne(z.object({ language: z.string() }), result)?.language ?? null;
}

export async function tenantIdForRecording(
  pool: Pool,
  recordingId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT c.tenant_id
       FROM recordings r
       JOIN calls ca ON ca.id = r.call_id
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE r.id = $1`,
    [recordingId],
  );
  return (
    parseOne(z.object({ tenant_id: z.string().uuid() }), result)?.tenant_id ??
    null
  );
}
