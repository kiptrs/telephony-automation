import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { backoffSeconds, PgJobQueue } from "../src/jobs/pg-queue.js";
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

describe("backoffSeconds", () => {
  it("grows exponentially", () => {
    expect(backoffSeconds(1)).toBeLessThan(backoffSeconds(2));
    expect(backoffSeconds(2)).toBeLessThan(backoffSeconds(3));
  });

  it("starts small enough that a transient blip retries quickly", () => {
    expect(backoffSeconds(1)).toBeLessThanOrEqual(30);
  });

  it("is capped so a stuck job does not schedule itself into next week", () => {
    expect(backoffSeconds(50)).toBeLessThanOrEqual(3600);
  });
});

describe("PgJobQueue", () => {
  it("claims an enqueued job", async () => {
    await queue.enqueue("transcribe", { recordingId: "r-1" });
    const claimed = await queue.claim(10, "runner-a");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe("transcribe");
    expect(claimed[0]?.payload).toEqual({ recordingId: "r-1" });
  });

  it("does not claim the same job twice", async () => {
    await queue.enqueue("transcribe", { recordingId: "r-1" });
    await queue.claim(10, "runner-a");
    expect(await queue.claim(10, "runner-a")).toHaveLength(0);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) await queue.enqueue("transcribe", { i });
    expect(await queue.claim(2, "runner-a")).toHaveLength(2);
  });

  it("does not claim a job scheduled for the future", async () => {
    await queue.enqueue("transcribe", { i: 1 }, new Date(Date.now() + 60_000));
    expect(await queue.claim(10, "runner-a")).toHaveLength(0);
  });

  it("never hands one job to two runners", async () => {
    for (let i = 0; i < 10; i++) await queue.enqueue("transcribe", { i });

    const batches = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        queue.claim(10, `runner-${index}`),
      ),
    );

    const ids = batches.flat().map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });

  it("reclaims a job whose runner died mid-flight", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    await queue.claim(10, "runner-a");
    await pool.query(
      "UPDATE jobs SET locked_at = now() - interval '10 minutes'",
    );
    expect(await queue.claim(10, "runner-b")).toHaveLength(1);
  });

  it("removes a completed job from circulation", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    const [job] = await queue.claim(10, "runner-a");
    await queue.complete(job!.id);
    await pool.query("UPDATE jobs SET locked_at = NULL");
    expect(await queue.claim(10, "runner-a")).toHaveLength(0);
  });

  it("reschedules a failed job with its error recorded", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    const [job] = await queue.claim(10, "runner-a");
    await queue.fail(job!.id, "boom");

    const row = await pool.query("SELECT * FROM jobs");
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toBe("boom");
    expect(row.rows[0].failed_at).toBeNull();
    expect(new Date(row.rows[0].run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up after max_attempts instead of retrying forever", async () => {
    await queue.enqueue("transcribe", { i: 1 });
    for (let attempt = 0; attempt < 5; attempt++) {
      await pool.query("UPDATE jobs SET locked_at = NULL, run_at = now()");
      const [job] = await queue.claim(10, "runner-a");
      await queue.fail(job!.id, `failure ${attempt}`);
    }

    const row = await pool.query("SELECT * FROM jobs");
    expect(row.rows[0].failed_at).not.toBeNull();

    await pool.query("UPDATE jobs SET locked_at = NULL, run_at = now()");
    expect(await queue.claim(10, "runner-a")).toHaveLength(0);
  });

  it("claims the oldest runnable job first", async () => {
    await queue.enqueue("transcribe", { order: 1 });
    await pool.query("UPDATE jobs SET run_at = now() - interval '1 hour'");
    await queue.enqueue("transcribe", { order: 2 });

    const [job] = await queue.claim(1, "runner-a");
    expect(job?.payload).toEqual({ order: 1 });
  });
});
