import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { putObject, type S3Client } from "../s3.js";
import { deleteRecording, downloadRecording } from "../telnyx.js";
import {
  findRecording,
  markIngested,
  markTelnyxDeleted,
  tenantIdForRecording,
} from "./queries.js";

export interface IngestDeps {
  pool: Pool;
  config: Config;
  s3: S3Client;
}

/** Deterministic, so a retried ingest overwrites in place rather than piling up. */
export function recordingKey(tenantId: string, callId: string): string {
  return `tenants/${tenantId}/calls/${callId}/recording.mp3`;
}

/**
 * Download, verify, upload, then delete at Telnyx - strictly in that order.
 * Deleting before a verified upload would destroy the only copy of a call the
 * moment anything went wrong.
 *
 * Every stage is skipped if already done, so a job that dies between the
 * upload and the delete finishes correctly on retry.
 */
export async function ingestRecording(
  deps: IngestDeps,
  payload: { recordingId: string },
): Promise<void> {
  const { pool, config, s3 } = deps;

  const recording = await findRecording(pool, payload.recordingId);
  if (!recording) {
    throw new Error(`recording ${payload.recordingId} not found`);
  }

  if (recording.ingestedAt === null) {
    if (!recording.sourceUrl) {
      throw new Error(`recording ${recording.id} has no source url`);
    }

    const tenantId = await tenantIdForRecording(pool, recording.id);
    if (!tenantId) {
      throw new Error(`recording ${recording.id} has no owning tenant`);
    }

    const buffer = await downloadRecording(recording.sourceUrl);
    const key = recordingKey(tenantId, recording.callId);

    await putObject(s3, config, {
      key,
      body: buffer,
      contentType: "audio/mpeg",
    });

    await markIngested(pool, {
      id: recording.id,
      s3Key: key,
      bytes: buffer.byteLength,
    });
  }

  if (recording.telnyxDeletedAt === null) {
    await deleteRecording(config.telnyxApiKey, recording.telnyxRecordingId);
    await markTelnyxDeleted(pool, recording.id);
  }
}
