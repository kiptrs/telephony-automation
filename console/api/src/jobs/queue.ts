export type JobKind = "ingest_recording" | "transcribe";

export interface Job {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * The seam that lets the media jobs move to SQS later without touching their
 * handlers. Dispatch deliberately does not go through here - it is gated by
 * number availability, not worker capacity, so it is a scheduler and not a
 * queue.
 */
export interface JobQueue {
  enqueue(kind: JobKind, payload: unknown, runAt?: Date): Promise<string>;
  claim(limit: number, lockedBy: string): Promise<Job[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}
