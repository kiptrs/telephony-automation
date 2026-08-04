import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { PgJobQueue } from "../src/jobs/pg-queue.js";
import { runOnce } from "../src/jobs/runner.js";
import { testConfig } from "./helpers.js";

let pool: Pool;
let queue: PgJobQueue;

beforeAll(() => {
  pool = createPool(testConfig());
  queue = new PgJobQueue(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE jobs");
});

describe("runOnce", () => {
  it("runs the handler for the job's kind", async () => {
    const ingest = vi.fn(async () => {});
    const transcribe = vi.fn(async () => {});
    await queue.enqueue("ingest_recording", { recordingId: "r-1" });

    await runOnce(queue, { ingest_recording: ingest, transcribe }, "runner-a");

    expect(ingest).toHaveBeenCalledWith({ recordingId: "r-1" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("completes a successful job", async () => {
    await queue.enqueue("transcribe", { recordingId: "r-1" });
    const result = await runOnce(
      queue,
      { ingest_recording: async () => {}, transcribe: async () => {} },
      "runner-a",
    );

    expect(result.completed).toBe(1);
    const row = await pool.query("SELECT completed_at FROM jobs");
    expect(row.rows[0].completed_at).not.toBeNull();
  });

  it("fails a throwing job without stopping the batch", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    await queue.enqueue("transcribe", { i: 2 });

    let seen = 0;
    const result = await runOnce(
      queue,
      {
        ingest_recording: async () => {},
        transcribe: async () => {
          seen += 1;
          if (seen === 1) throw new Error("first one fails");
        },
      },
      "runner-a",
    );

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("records the error on the failed job", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    await runOnce(
      queue,
      {
        ingest_recording: async () => {},
        transcribe: async () => {
          throw new Error("engine exploded");
        },
      },
      "runner-a",
    );

    const row = await pool.query("SELECT last_error FROM jobs");
    expect(row.rows[0].last_error).toMatch(/engine exploded/);
  });

  it("does nothing when the queue is empty", async () => {
    const result = await runOnce(
      queue,
      { ingest_recording: async () => {}, transcribe: async () => {} },
      "runner-a",
    );
    expect(result).toEqual({ completed: 0, failed: 0 });
  });
});
