import OpenAI, { toFile } from "openai";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { getObject, putObject, type S3Client } from "../s3.js";
import {
  campaignLanguageForRecording,
  findRecording,
  markTranscriptDone,
  markTranscriptFailed,
  markTranscriptRunning,
} from "./queries.js";

export const WHISPER_MODEL = "whisper-1";

/** The API's limit is 25 MB; stopping short of it keeps the error ours. */
export const MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024;

export interface TranscriptionClient {
  transcribe(args: {
    audio: Buffer;
    filename: string;
    language: string | null;
  }): Promise<{ text: string; raw: unknown }>;
}

export class OpenAiTranscriptionClient implements TranscriptionClient {
  private readonly client: OpenAI;

  constructor(config: Config) {
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async transcribe(args: {
    audio: Buffer;
    filename: string;
    language: string | null;
  }): Promise<{ text: string; raw: unknown }> {
    const response = await this.client.audio.transcriptions.create({
      file: await toFile(args.audio, args.filename, { type: "audio/mpeg" }),
      model: WHISPER_MODEL,
      // Whisper auto-detects without this, but the campaign already knows, and
      // a hint measurably improves accuracy on short utterances.
      ...(args.language ? { language: args.language } : {}),
      response_format: "verbose_json",
    });

    return { text: response.text, raw: response };
  }
}

export interface TranscribeDeps {
  pool: Pool;
  config: Config;
  s3: S3Client;
  client: TranscriptionClient;
}

/**
 * Only ever runs because an operator asked. Whisper is billed per minute, so
 * nothing here is triggered by a call finishing.
 */
export async function transcribeRecording(
  deps: TranscribeDeps,
  payload: { recordingId: string },
): Promise<void> {
  const { pool, config, s3, client } = deps;

  const recording = await findRecording(pool, payload.recordingId);
  if (!recording) throw new Error(`recording ${payload.recordingId} not found`);

  try {
    if (recording.ingestedAt === null || recording.s3Key === null) {
      throw new Error(`recording ${recording.id} has not been ingested yet`);
    }
    if (recording.bytes !== null && recording.bytes > MAX_TRANSCRIBE_BYTES) {
      throw new Error(
        `recording is too large to transcribe: ${recording.bytes} bytes, limit ${MAX_TRANSCRIBE_BYTES}`,
      );
    }

    await markTranscriptRunning(pool, recording.id);

    const audio = await getObject(s3, config, recording.s3Key);
    const language = await campaignLanguageForRecording(pool, recording.id);

    const result = await client.transcribe({
      audio,
      filename: "recording.mp3",
      language,
    });

    // The verbose response is kept whole in S3 for the later analysis agent;
    // only the plain text goes in Postgres.
    const rawKey = recording.s3Key.replace(/recording\.mp3$/, "transcript.json");
    await putObject(s3, config, {
      key: rawKey,
      body: Buffer.from(JSON.stringify(result.raw, null, 2)),
      contentType: "application/json",
    });

    await markTranscriptDone(pool, {
      recordingId: recording.id,
      text: result.text,
      rawS3Key: rawKey,
    });
  } catch (error) {
    // Recorded on the transcript so the operator sees why, then rethrown so
    // the job queue applies its own backoff.
    await markTranscriptFailed(pool, recording.id, String(error));
    throw error;
  }
}
