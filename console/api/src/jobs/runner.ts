import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { ingestRecording } from "../media/ingest.js";
import { ElevenLabsTranscriptionClient } from "../media/scribe.js";
import { transcribeRecording } from "../media/transcribe.js";
import type { S3Client } from "../s3.js";
import type { JobKind, JobQueue } from "./queue.js";

export const RUNNER_TICK_MS = 1000;
/** Small: both handlers are network-bound and one EC2 box runs them all. */
export const RUNNER_BATCH = 3;

export type JobHandlers = Record<JobKind, (payload: unknown) => Promise<void>>;

/**
 * Drains one batch. One job throwing must not abandon the rest of the batch,
 * so each is caught individually and reported to the queue.
 */
export async function runOnce(
  queue: JobQueue,
  handlers: JobHandlers,
  runnerId: string,
): Promise<{ completed: number; failed: number }> {
  const jobs = await queue.claim(RUNNER_BATCH, runnerId);
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await handlers[job.kind](job.payload);
      await queue.complete(job.id);
      completed += 1;
    } catch (error) {
      await queue.fail(job.id, String(error));
      failed += 1;
      console.error(
        JSON.stringify({
          msg: "job_failed",
          job_id: job.id,
          kind: job.kind,
          attempts: job.attempts + 1,
          error: String(error),
        }),
      );
    }
  }

  return { completed, failed };
}

export function buildHandlers(deps: {
  pool: Pool;
  config: Config;
  s3: S3Client;
}): JobHandlers {
  const client = new ElevenLabsTranscriptionClient(deps.config);

  return {
    ingest_recording: (payload) =>
      ingestRecording(deps, payload as { recordingId: string }),
    transcribe: (payload) =>
      transcribeRecording(
        { ...deps, client },
        payload as { recordingId: string },
      ),
  };
}

export function startRunner(deps: {
  queue: JobQueue;
  handlers: JobHandlers;
}): { stop: () => void } {
  const runnerId = `runner-${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runOnce(deps.queue, deps.handlers, runnerId);
      if (result.completed > 0 || result.failed > 0) {
        console.log(JSON.stringify({ msg: "job_tick", ...result }));
      }
    } catch (error) {
      console.error(
        JSON.stringify({ msg: "job_tick_failed", error: String(error) }),
      );
    }
    if (!stopped) timer = setTimeout(() => void tick(), RUNNER_TICK_MS);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
