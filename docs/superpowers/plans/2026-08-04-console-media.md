# Console Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull every recording out of Telnyx into S3, delete it from Telnyx, and transcribe it on demand - so the call audio and its text live in the operator's own bucket and nowhere else.

**Architecture:** A Postgres-backed job queue behind a `JobQueue` interface, drained by a runner inside the existing `worker` process. `call.recording.saved` enqueues an ingest job; ingest downloads from Telnyx, uploads to S3, verifies, and only then deletes at Telnyx. Transcription is never automatic - an operator asks for it, which enqueues one job per recording and calls the OpenAI Whisper API with the campaign's language hint.

**Tech Stack:** As Plans 1 and 2, plus the `openai` SDK.

**Spec:** `docs/superpowers/specs/2026-08-04-console-design.md`, "Plan 3 - Media".

**Depends on:** Plans 1 and 2 complete, with the `worker` process running the dispatcher and `/callbacks/worker` verifying signatures.

## Global Constraints

- Everything in Plans 1 and 2 still applies: Node **24.11.0**, TypeScript **strict** with `noUncheckedIndexedAccess`, **no ORM**, SQL only in `queries.ts` modules, every row parsed through zod, **no emojis**, **git is read-only**.
- **Delete from Telnyx only after a verified S3 upload.** A failed ingest must never destroy the only copy of a call.
- **Nothing transcribes automatically.** Every transcription is an explicit operator action, because it costs money per minute.
- **Transcripts are one blob per call.** Per-question segmentation is out of scope and stays out; a later analysis agent does its own segmentation.
- The recording is dual-channel MP3. Whisper's file limit is 25 MB; anything above 24 MB fails with an explicit message rather than a truncated transcript.

## File Structure

```
console/
  db/migrations/
    20260806*_recordings.sql
    20260806*_jobs.sql
  api/src/jobs/
    queue.ts                 JobQueue interface + Job type
    pg-queue.ts              SKIP LOCKED implementation
    runner.ts                the drain loop and handler registry
  api/src/media/
    queries.ts               recordings + transcripts SQL
    ingest.ts                Telnyx to S3, then delete at Telnyx
    transcribe.ts            S3 to Whisper
    routes.ts                on-demand transcription, presigned playback
  api/src/telnyx.ts          recordings API client
  api/src/worker.ts          MODIFIED: start the runner alongside the dispatcher
  api/src/callbacks/routes.ts  MODIFIED: recording.saved enqueues ingest
  web/src/routes/CampaignDetail.tsx  MODIFIED: player, transcript, transcribe
```

---

### Task 1: Media and job schema

**Files:**
- Create: `console/db/migrations/20260806090000_recordings.sql`
- Create: `console/db/migrations/20260806090100_jobs.sql`

**Interfaces:**
- Consumes: `calls` from Plan 2 Task 3.
- Produces: tables `recordings`, `transcripts`, `jobs`.

- [ ] **Step 1: Create the recording and transcript tables**

`console/db/migrations/20260806090000_recordings.sql`:

```sql
-- migrate:up
CREATE TABLE recordings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  -- Telnyx's own id. Unique so a replayed call.recording.saved is absorbed by
  -- the database rather than needing a dedupe table.
  telnyx_recording_id  text NOT NULL UNIQUE,
  source_url           text,
  channels             text,
  s3_key               text,
  bytes                bigint,
  duration_ms          integer,
  ingested_at          timestamptz,
  telnyx_deleted_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recordings_call_idx ON recordings (call_id);
-- Drives "transcribe everything in this campaign that is ready".
CREATE INDEX recordings_ingested_idx ON recordings (ingested_at)
  WHERE ingested_at IS NOT NULL;

CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  engine        text NOT NULL,
  language      text,
  text          text,
  raw_s3_key    text,
  status        text NOT NULL DEFAULT 'pending',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT transcripts_status_valid
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- One transcript per recording. Re-transcribing replaces it.
  CONSTRAINT transcripts_one_per_recording UNIQUE (recording_id)
);

-- migrate:down
DROP TABLE transcripts;
DROP TABLE recordings;
```

- [ ] **Step 2: Create the jobs table**

`console/db/migrations/20260806090100_jobs.sql`:

```sql
-- migrate:up
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  failed_at     timestamptz,
  CONSTRAINT jobs_kind_valid CHECK (kind IN ('ingest_recording', 'transcribe'))
);

-- The claim query's index: only unfinished jobs are ever scanned.
CREATE INDEX jobs_claimable_idx ON jobs (run_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

-- migrate:down
DROP TABLE jobs;
```

`failed_at` is separate from `completed_at` so a permanently failed job stays
visible in the UI instead of disappearing into a completed count.

- [ ] **Step 3: Run the migrations**

Run: `cd console && npm run migrate`
Expected: both applied.

- [ ] **Step 4: Verify rollback**

Run: `docker compose -f docker-compose.dev.yml run --rm dbmate down` twice,
then `npm run migrate` to restore.
Expected: clean.

---

### Task 2: The job queue

**Files:**
- Create: `console/api/src/jobs/queue.ts`
- Create: `console/api/src/jobs/pg-queue.ts`
- Test: `console/api/test/job-queue.test.ts`

**Interfaces:**
- Consumes: `Pool`, `parseRows`, `parseExactlyOne` from Plan 1 Task 3.
- Produces:
  - `JobKind = "ingest_recording" | "transcribe"`
  - `Job = { id: string; kind: JobKind; payload: unknown; attempts: number; maxAttempts: number }`
  - `JobQueue` interface: `enqueue`, `claim`, `complete`, `fail`
  - `PgJobQueue` implementing it
  - `backoffSeconds(attempts: number): number`

- [ ] **Step 1: Write the failing queue test**

`console/api/test/job-queue.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- job-queue`
Expected: FAIL - cannot resolve `../src/jobs/pg-queue.js`.

- [ ] **Step 3: Define the interface**

`console/api/src/jobs/queue.ts`:

```ts
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
```

- [ ] **Step 4: Implement the Postgres queue**

`console/api/src/jobs/pg-queue.ts`:

```ts
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseRows } from "../db/rows.js";
import type { Job, JobKind, JobQueue } from "./queue.js";

/** A runner that dies mid-job holds its lock this long before it is reclaimed. */
const LOCK_TIMEOUT_MINUTES = 5;

/** 15s, 30s, 60s, 120s, ... capped at an hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 3600);
}

const jobRow = z.object({
  id: z.string().uuid(),
  kind: z.enum(["ingest_recording", "transcribe"]),
  payload: z.unknown(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
});

export class PgJobQueue implements JobQueue {
  constructor(private readonly pool: Pool) {}

  async enqueue(kind: JobKind, payload: unknown, runAt?: Date): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO jobs (kind, payload, run_at)
            VALUES ($1, $2::jsonb, COALESCE($3, now()))
         RETURNING id`,
      [kind, JSON.stringify(payload), runAt ?? null],
    );
    return parseExactlyOne(z.object({ id: z.string().uuid() }), result).id;
  }

  /**
   * Claim and lock in one statement. SKIP LOCKED inside the subquery is what
   * lets several runners drain the same table without ever colliding.
   */
  async claim(limit: number, lockedBy: string): Promise<Job[]> {
    const result = await this.pool.query(
      `UPDATE jobs
          SET locked_at = now(), locked_by = $2
        WHERE id IN (
          SELECT id FROM jobs
           WHERE completed_at IS NULL
             AND failed_at IS NULL
             AND run_at <= now()
             AND (locked_at IS NULL
                  OR locked_at < now() - make_interval(mins => $3))
           ORDER BY run_at
             FOR UPDATE SKIP LOCKED
           LIMIT $1)
        RETURNING id, kind, payload, attempts, max_attempts`,
      [limit, lockedBy, LOCK_TIMEOUT_MINUTES],
    );

    return parseRows(jobRow, result).map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET completed_at = now(), locked_at = NULL WHERE id = $1`,
      [id],
    );
  }

  /**
   * Increments the attempt count and either reschedules with backoff or gives
   * up. Giving up leaves the row visible with its error rather than deleting
   * the evidence.
   */
  async fail(id: string, error: string): Promise<void> {
    // Every expression in SET reads the pre-update row, so `attempts` here is
    // the old count. backoffSeconds(old + 1) is 15 * 2^old, which is what the
    // interval below computes - one statement, no read-back needed.
    await this.pool.query(
      `UPDATE jobs
          SET attempts = attempts + 1,
              last_error = $2,
              locked_at = NULL,
              locked_by = NULL,
              run_at = now() + make_interval(
                secs => LEAST(15 * power(2, attempts)::int, 3600)),
              failed_at = CASE WHEN attempts + 1 >= max_attempts
                               THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, error.slice(0, 2000)],
    );
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- job-queue`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 3: Telnyx client and media queries

**Files:**
- Create: `console/api/src/telnyx.ts`
- Create: `console/api/src/media/queries.ts`
- Modify: `console/api/src/config.ts` (add `telnyxApiKey`, `openaiApiKey`)
- Modify: `console/api/test/helpers.ts`, `console/api/test/config.test.ts`
- Test: `console/api/test/telnyx.test.ts`

**Interfaces:**
- Consumes: `Config` from Plan 1 Task 1.
- Produces:
  - `TelnyxError` with `status: number`
  - `pickRecordingUrl(payload: unknown): string | null`
  - `downloadRecording(url: string): Promise<Buffer>`
  - `deleteRecording(apiKey: string, recordingId: string): Promise<void>`
  - `insertRecording`, `findRecording`, `markIngested`, `markTelnyxDeleted`, `recordingsAwaitingTranscript`, `upsertTranscript`, `markTranscriptRunning`, `markTranscriptDone`, `markTranscriptFailed`, `findTranscriptForCall`, `findRecordingForCall` in `media/queries.ts`.

- [ ] **Step 1: Extend config**

In `console/api/src/config.ts`, add to `envSchema`:

```ts
  TELNYX_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
```

Add to `Config` and the returned object:

```ts
  telnyxApiKey: string;
  openaiApiKey: string;
```

```ts
    telnyxApiKey: value.TELNYX_API_KEY,
    openaiApiKey: value.OPENAI_API_KEY,
```

Add both to `.env.example`, `.env.prod.example`, `testConfig()` in
`console/api/test/helpers.ts`, and the `valid` object in `config.test.ts`:

```ts
    TELNYX_API_KEY: "telnyx-key",
    OPENAI_API_KEY: "openai-key",
```

`TELNYX_API_KEY` must be the same key the Worker holds; the console needs it
only to delete recordings.

- [ ] **Step 2: Write the failing Telnyx client test**

`console/api/test/telnyx.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRecording,
  downloadRecording,
  pickRecordingUrl,
  TelnyxError,
} from "../src/telnyx.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickRecordingUrl", () => {
  it("prefers mp3", () => {
    expect(
      pickRecordingUrl({
        recording_urls: { mp3: "https://t.example/a.mp3", wav: "https://t.example/a.wav" },
      }),
    ).toBe("https://t.example/a.mp3");
  });

  it("falls back to wav when there is no mp3", () => {
    expect(
      pickRecordingUrl({ recording_urls: { wav: "https://t.example/a.wav" } }),
    ).toBe("https://t.example/a.wav");
  });

  it("reads public_recording_urls when recording_urls is absent", () => {
    expect(
      pickRecordingUrl({ public_recording_urls: { mp3: "https://t.example/p.mp3" } }),
    ).toBe("https://t.example/p.mp3");
  });

  it("returns null when there is no usable URL", () => {
    expect(pickRecordingUrl({ recording_urls: {} })).toBeNull();
    expect(pickRecordingUrl({})).toBeNull();
    expect(pickRecordingUrl(null)).toBeNull();
  });

  it("ignores a non-string URL rather than trusting it", () => {
    expect(pickRecordingUrl({ recording_urls: { mp3: 42 } })).toBeNull();
  });
});

describe("downloadRecording", () => {
  it("returns the bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "4" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      })),
    );
    const buffer = await downloadRecording("https://t.example/a.mp3");
    expect(buffer.byteLength).toBe(4);
  });

  it("throws on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "gone",
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toBeInstanceOf(
      TelnyxError,
    );
  });

  it("rejects an empty body, which would otherwise be uploaded as a valid file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "0" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects a truncated download, so a short file is never treated as ingested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "100" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toThrow(
      /expected 100 bytes/,
    );
  });

  it("accepts a response with no content-length header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).resolves.toHaveLength(3);
  });
});

describe("deleteRecording", () => {
  it("issues a DELETE with the API key", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", spy);
    await deleteRecording("key-1", "rec-1");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/recordings/rec-1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
  });

  it("treats 404 as success, because the recording is already gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, text: async () => "not found" })),
    );
    await expect(deleteRecording("key-1", "rec-1")).resolves.toBeUndefined();
  });

  it("throws on any other failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    await expect(deleteRecording("key-1", "rec-1")).rejects.toBeInstanceOf(TelnyxError);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- telnyx`
Expected: FAIL - cannot resolve `../src/telnyx.js`.

- [ ] **Step 4: Implement the Telnyx client**

`console/api/src/telnyx.ts`:

```ts
const API_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TelnyxError";
    this.status = status;
  }
}

function stringAt(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * mp3 first: it is what record_start asks for and it is a quarter the size of
 * the wav, which matters against Whisper's 25 MB limit.
 */
export function pickRecordingUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  for (const key of ["recording_urls", "public_recording_urls"]) {
    const group = record[key];
    const mp3 = stringAt(group, "mp3");
    if (mp3) return mp3;
    const wav = stringAt(group, "wav");
    if (wav) return wav;
  }
  return null;
}

/**
 * Verifies the body before returning it. An empty or truncated download that
 * reached S3 would look like a successful ingest and then be deleted at
 * Telnyx, destroying the only copy.
 */
export async function downloadRecording(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `downloading the recording failed: ${await response.text()}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new TelnyxError(502, "recording download was empty");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== buffer.byteLength) {
    throw new TelnyxError(
      502,
      `recording download was truncated: expected ${declared} bytes, got ${buffer.byteLength}`,
    );
  }

  return buffer;
}

export async function deleteRecording(
  apiKey: string,
  recordingId: string,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/recordings/${encodeURIComponent(recordingId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
  );

  // Already deleted is the desired state, not a failure to retry.
  if (response.status === 404) return;

  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `deleting the recording failed: ${await response.text()}`,
    );
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- telnyx`
Expected: PASS, 13 tests.

- [ ] **Step 6: Implement the media queries**

`console/api/src/media/queries.ts`:

```ts
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
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 4: Recording ingest

The ordering here is the whole point: download, verify, upload, verify, and only
then delete at Telnyx.

**Files:**
- Create: `console/api/src/media/ingest.ts`
- Test: `console/api/test/ingest.test.ts`

**Interfaces:**
- Consumes: `downloadRecording`, `deleteRecording`, `pickRecordingUrl` from Task 3; `putObject` from Plan 1 Task 8.
- Produces:
  - `recordingKey(tenantId: string, callId: string): string`
  - `ingestRecording(deps, payload: { recordingId: string }): Promise<void>`
  - `IngestDeps = { pool: Pool; config: Config; s3: S3Client }`

- [ ] **Step 1: Write the failing ingest test**

`console/api/test/ingest.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- ingest`
Expected: FAIL - cannot resolve `../src/media/ingest.js`.

- [ ] **Step 3: Implement ingest**

`console/api/src/media/ingest.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run infra:up && npm run test --workspace @console/api -- ingest`
Expected: PASS, 11 tests. MinIO must be running.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 5: Transcription

**Files:**
- Modify: `console/api/src/s3.ts` (add `getObject`)
- Create: `console/api/src/media/transcribe.ts`
- Test: `console/api/test/transcribe.test.ts`

**Interfaces:**
- Consumes: media queries from Task 3, `getObject`/`putObject` from `s3.ts`.
- Produces:
  - `getObject(s3, config, key): Promise<Buffer>`
  - `WHISPER_MODEL = "whisper-1"`, `MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024`
  - `TranscriptionClient` interface: `transcribe(args: { audio: Buffer; filename: string; language: string | null }): Promise<{ text: string; raw: unknown }>`
  - `OpenAiTranscriptionClient` implementing it
  - `transcribeRecording(deps, payload: { recordingId: string }): Promise<void>`

- [ ] **Step 1: Add getObject to the S3 wrapper**

In `console/api/src/s3.ts`, extend the import and add:

```ts
export async function getObject(
  s3: S3Client,
  config: Config,
  key: string,
): Promise<Buffer> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`object ${key} has no body`);
  return Buffer.from(await result.Body.transformToByteArray());
}
```

- [ ] **Step 2: Add the OpenAI SDK**

Run: `cd console && npm install --workspace @console/api openai`

- [ ] **Step 3: Write the failing transcription test**

`console/api/test/transcribe.test.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- transcribe`
Expected: FAIL - cannot resolve `../src/media/transcribe.js`.

- [ ] **Step 5: Implement transcription**

`console/api/src/media/transcribe.ts`:

```ts
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
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- transcribe`
Expected: PASS, 9 tests. No OpenAI key is used - every case goes through
`FakeClient`.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 6: The job runner

**Files:**
- Create: `console/api/src/jobs/runner.ts`
- Modify: `console/api/src/worker.ts`
- Modify: `console/api/src/callbacks/routes.ts` (enqueue ingest)
- Modify: `console/api/src/app.ts` (pass the queue to the callback routes)
- Test: `console/api/test/runner.test.ts`
- Modify: `console/api/test/callback-routes.test.ts`

**Interfaces:**
- Consumes: `JobQueue` from Task 2, `ingestRecording` from Task 4, `transcribeRecording` from Task 5.
- Produces:
  - `JobHandlers = Record<JobKind, (payload: unknown) => Promise<void>>`
  - `runOnce(queue, handlers, runnerId): Promise<{ completed: number; failed: number }>`
  - `startRunner(deps): { stop(): void }`
  - `RUNNER_TICK_MS = 1000`, `RUNNER_BATCH = 3`

- [ ] **Step 1: Write the failing runner test**

`console/api/test/runner.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- runner`
Expected: FAIL - cannot resolve `../src/jobs/runner.js`.

- [ ] **Step 3: Implement the runner**

`console/api/src/jobs/runner.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { ingestRecording } from "../media/ingest.js";
import {
  OpenAiTranscriptionClient,
  transcribeRecording,
} from "../media/transcribe.js";
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
  const client = new OpenAiTranscriptionClient(deps.config);

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- runner`
Expected: PASS, 5 tests.

- [ ] **Step 5: Start the runner alongside the dispatcher**

In `console/api/src/worker.ts`, add:

```ts
import { PgJobQueue } from "./jobs/pg-queue.js";
import { buildHandlers, startRunner } from "./jobs/runner.js";
```

```ts
const s3 = createS3(config);

const dispatcher = startDispatcher({
  pool,
  config,
  s3,
  dialer: createDialer(config),
});

const runner = startRunner({
  queue: new PgJobQueue(pool),
  handlers: buildHandlers({ pool, config, s3 }),
});
```

And stop it in `shutdown`:

```ts
  dispatcher.stop();
  runner.stop();
```

- [ ] **Step 6: Enqueue ingest from the callback**

In `console/api/src/callbacks/routes.ts`, widen the deps and replace the
`call.recording.saved` branch:

```ts
import { insertRecording } from "../media/queries.js";
import type { JobQueue } from "../jobs/queue.js";
import { pickRecordingUrl } from "../telnyx.js";
```

```ts
export function registerCallbackRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; queue: JobQueue },
): void {
  const { pool, config, queue } = deps;
```

```ts
        case "call.recording.saved": {
          const telnyxRecordingId = parsed.payload.recording_id;
          if (typeof telnyxRecordingId !== "string") {
            request.log.warn(
              { ccid: parsed.call_control_id },
              "recording saved without a recording_id",
            );
            break;
          }

          const recording = await insertRecording(pool, {
            callId: call.id,
            telnyxRecordingId,
            sourceUrl: pickRecordingUrl(parsed.payload),
            channels:
              typeof parsed.payload.channels === "string"
                ? parsed.payload.channels
                : null,
          });

          // Null means the unique constraint absorbed a replay, so the ingest
          // job was already enqueued and must not be enqueued twice.
          if (recording) {
            await queue.enqueue("ingest_recording", { recordingId: recording.id });
          }
          break;
        }
```

In `console/api/src/app.ts`, construct the queue and pass it:

```ts
import { PgJobQueue } from "./jobs/pg-queue.js";
```

```ts
  const queue = new PgJobQueue(deps.pool);
```

```ts
  registerCallbackRoutes(app, { ...deps, queue });
```

- [ ] **Step 7: Extend the callback tests**

Add to `console/api/test/callback-routes.test.ts`, inside the existing
`describe("POST /callbacks/worker")` block, and add
`await pool.query("TRUNCATE jobs")` to its `beforeEach`:

```ts
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
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green. `callback-routes` is now 15 tests.

---

### Task 7: Media API routes

**Files:**
- Create: `console/api/src/media/routes.ts`
- Modify: `console/api/src/app.ts`
- Modify: `console/packages/shared/src/call.ts` (transcript schema)
- Modify: `console/api/src/calls/queries.ts` (media columns on the call list)
- Modify: `console/api/test/tenant-isolation.test.ts`
- Test: `console/api/test/media-routes.test.ts`

**Interfaces:**
- Consumes: media queries from Task 3, `PgJobQueue` from Task 2, `presignGet` from Plan 1.
- Produces:
  - `POST /api/campaigns/:id/transcribe` - enqueues one job per eligible recording, returns `{ enqueued }`
  - `GET /api/calls/:id/recording` - `{ url }`, presigned for 15 minutes
  - `GET /api/calls/:id/transcript` - the transcript or 404
  - `Call` gains `hasRecording: boolean` and `transcriptStatus: TranscriptStatus | null`

- [ ] **Step 1: Extend the shared call schema**

In `console/packages/shared/src/call.ts`:

```ts
export const transcriptStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

export const transcriptSchema = z.object({
  status: transcriptStatusSchema,
  text: z.string().nullable(),
  language: z.string().nullable(),
  engine: z.string(),
  error: z.string().nullable(),
});
export type Transcript = z.infer<typeof transcriptSchema>;
```

Add these two fields to `callSchema`:

```ts
  hasRecording: z.boolean(),
  transcriptStatus: transcriptStatusSchema.nullable(),
```

Widening `Call` breaks the fixture in `console/web/test/outcome-label.test.ts`
from the dispatch plan, which builds a complete `Call` by hand. Add both fields
to its `base` object or `npm run typecheck` fails:

```ts
  hasRecording: false,
  transcriptStatus: null,
```

- [ ] **Step 2: Surface them on the call list**

In `console/api/src/calls/queries.ts`, add to `callRow`:

```ts
  has_recording: z.boolean(),
  transcript_status: z
    .enum(["pending", "running", "done", "failed"])
    .nullable(),
```

Add to `toCall`:

```ts
    hasRecording: row.has_recording,
    transcriptStatus: row.transcript_status,
```

And to `SELECT_CALL`, before `FROM calls ca`:

```sql
         r.ingested_at IS NOT NULL AS has_recording,
         t.status AS transcript_status,
```

with the joins after the existing ones:

```sql
    LEFT JOIN recordings r ON r.call_id = ca.id
    LEFT JOIN transcripts t ON t.recording_id = r.id
```

`has_recording` is `ingested_at IS NOT NULL` rather than "a recordings row
exists", because a row that has not been ingested has nothing to play.

- [ ] **Step 3: Write the failing media route test**

`console/api/test/media-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { createS3, putObject } from "../src/s3.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let campaignId: string;
let callId: string;
let recordingId: string;

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
  await pool.query("TRUNCATE phone_numbers, number_leases, calls, jobs CASCADE");
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenant.tenantId],
  );
  campaignId = campaign.rows[0].id as string;

  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')
       RETURNING id`,
    [campaignId],
  );
  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, status, outcome)
          VALUES ($1, $2, 'ended', 'completed') RETURNING id`,
    [campaignId, contact.rows[0].id],
  );
  callId = call.rows[0].id as string;

  const key = `tenants/${tenant.tenantId}/calls/${callId}/recording.mp3`;
  await putObject(createS3(config), config, {
    key,
    body: Buffer.alloc(32, 5),
    contentType: "audio/mpeg",
  });

  const recording = await pool.query(
    `INSERT INTO recordings (call_id, telnyx_recording_id, s3_key, bytes, ingested_at)
          VALUES ($1, 'rec-1', $2, 32, now()) RETURNING id`,
    [callId, key],
  );
  recordingId = recording.rows[0].id as string;
});

describe("POST /api/campaigns/:id/transcribe", () => {
  it("enqueues one job per ingested recording", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().enqueued).toBe(1);

    const jobs = await pool.query("SELECT kind FROM jobs");
    expect(jobs.rows[0].kind).toBe("transcribe");
  });

  it("creates a pending transcript row so the UI can show progress", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    const rows = await pool.query("SELECT status FROM transcripts");
    expect(rows.rows[0].status).toBe("pending");
  });

  it("skips a recording that already has a finished transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, text)
            VALUES ($1, 'whisper-1', 'done', 'hello')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(0);
  });

  it("re-enqueues a recording whose transcript failed", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, error)
            VALUES ($1, 'whisper-1', 'failed', 'rate limited')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(1);
  });

  it("skips a recording that has not been ingested", async () => {
    await pool.query(
      "UPDATE recordings SET ingested_at = NULL WHERE id = $1",
      [recordingId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
      headers: { cookie },
    });
    expect(response.json().enqueued).toBe(0);
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/transcribe`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/calls/:id/recording", () => {
  it("returns a presigned URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/recording`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/X-Amz-Signature=/);
  });

  it("returns 404 when the recording is not ingested yet", async () => {
    await pool.query(
      "UPDATE recordings SET ingested_at = NULL, s3_key = NULL WHERE id = $1",
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/recording`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/calls/:id/transcript", () => {
  it("returns the transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, language, status, text)
            VALUES ($1, 'whisper-1', 'lt', 'done', 'labas')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.json().text).toBe("labas");
    expect(response.json().status).toBe("done");
  });

  it("returns 404 when there is none", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the failure reason for a failed transcript", async () => {
    await pool.query(
      `INSERT INTO transcripts (recording_id, engine, status, error)
            VALUES ($1, 'whisper-1', 'failed', 'file too large')`,
      [recordingId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/transcript`,
      headers: { cookie },
    });
    expect(response.json().error).toBe("file too large");
  });
});

describe("GET /api/campaigns/:id/calls", () => {
  it("reports which calls have a playable recording", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/calls`,
      headers: { cookie },
    });
    expect(response.json()[0].hasRecording).toBe(true);
    expect(response.json()[0].transcriptStatus).toBeNull();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- media-routes`
Expected: FAIL - 404 on the three new routes.

- [ ] **Step 5: Implement the routes**

`console/api/src/media/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import { findCampaign } from "../campaigns/queries.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import type { JobQueue } from "../jobs/queue.js";
import { presignGet, type S3Client } from "../s3.js";
import { WHISPER_MODEL } from "./transcribe.js";
import {
  findRecordingForCall,
  findTranscriptForCall,
  recordingsAwaitingTranscript,
  upsertTranscript,
} from "./queries.js";

const idSchema = z.object({ id: z.string().uuid() });
const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; s3: S3Client; queue: JobQueue },
): void {
  const { pool, config, s3, queue } = deps;

  function parseId(params: unknown, label: string): string {
    const parsed = idSchema.safeParse(params);
    if (!parsed.success) throw new HttpError(400, `invalid ${label} id`);
    return parsed.data.id;
  }

  /**
   * On demand only. Whisper is billed per minute, so nothing here runs because
   * a call finished - an operator has to ask.
   */
  app.post("/api/campaigns/:id/transcribe", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = parseId(request.params, "campaign");

    const campaign = await findCampaign(pool, tenantId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");

    const recordingIds = await recordingsAwaitingTranscript(
      pool,
      tenantId,
      campaignId,
    );

    for (const recordingId of recordingIds) {
      // The pending row exists before the job runs so the UI shows progress
      // immediately rather than after the first poll that catches it running.
      await upsertTranscript(pool, {
        recordingId,
        engine: WHISPER_MODEL,
        language: campaign.language,
      });
      await queue.enqueue("transcribe", { recordingId });
    }

    return reply.status(202).send({ enqueued: recordingIds.length });
  });

  app.get("/api/calls/:id/recording", async (request) => {
    const { tenantId } = requireTenant(request);
    const callId = parseId(request.params, "call");

    const recording = await findRecordingForCall(pool, tenantId, callId);
    if (!recording || recording.s3Key === null || recording.ingestedAt === null) {
      throw new HttpError(404, "no recording available for this call");
    }

    return {
      url: await presignGet(s3, config, recording.s3Key, PLAYBACK_URL_TTL_SECONDS),
    };
  });

  app.get("/api/calls/:id/transcript", async (request) => {
    const { tenantId } = requireTenant(request);
    const callId = parseId(request.params, "call");

    const transcript = await findTranscriptForCall(pool, tenantId, callId);
    if (!transcript) throw new HttpError(404, "no transcript for this call");
    return transcript;
  });
}
```

- [ ] **Step 6: Register the routes**

In `console/api/src/app.ts`:

```ts
import { registerMediaRoutes } from "./media/routes.js";
```

```ts
  registerMediaRoutes(app, { ...deps, s3, queue });
```

- [ ] **Step 7: Add isolation cases**

Append inside the `describe("tenant isolation")` block in
`console/api/test/tenant-isolation.test.ts`:

```ts
  it("returns 404 when transcribing another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/transcribe`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's recording URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/recording",
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's transcript", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/transcript",
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green. `media-routes` is 13 tests, `tenant-isolation` is now 18.

---

### Task 8: Recording and transcript UI

**Files:**
- Modify: `console/web/src/api/campaigns.ts`
- Create: `console/web/src/components/CallMedia.tsx`
- Modify: `console/web/src/routes/CampaignDetail.tsx`
- Test: `console/web/test/transcript-label.test.ts`

**Interfaces:**
- Consumes: the routes from Task 7.
- Produces:
  - `useTranscribeCampaign(id)`, `useTranscript(callId, enabled)`, `fetchRecordingUrl(callId)`
  - `transcriptLabel(status: TranscriptStatus | null, hasRecording: boolean): string`
  - `<CallMedia call={call} />` - expandable row content with a player and the text.

- [ ] **Step 1: Write the failing label test**

`console/web/test/transcript-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { transcriptLabel } from "../src/components/CallMedia.js";

describe("transcriptLabel", () => {
  it("says nothing is stored yet while ingest is pending", () => {
    expect(transcriptLabel(null, false)).toBe("No recording yet");
  });

  it("offers transcription once the recording is stored", () => {
    expect(transcriptLabel(null, true)).toBe("Not transcribed");
  });

  it("shows a queued transcript as queued", () => {
    expect(transcriptLabel("pending", true)).toBe("Queued");
  });

  it("shows a running transcript as transcribing", () => {
    expect(transcriptLabel("running", true)).toBe("Transcribing");
  });

  it("shows a finished transcript as ready", () => {
    expect(transcriptLabel("done", true)).toBe("Transcript ready");
  });

  it("shows a failure as failed rather than hiding it", () => {
    expect(transcriptLabel("failed", true)).toBe("Transcription failed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/web -- transcript-label`
Expected: FAIL - cannot resolve `../src/components/CallMedia.js`.

- [ ] **Step 3: Add the hooks**

Append to `console/web/src/api/campaigns.ts`:

```ts
import { transcriptSchema, type TranscriptStatus } from "@console/shared";

export function useTranscribeCampaign(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ enqueued: number }>(`/api/campaigns/${campaignId}/transcribe`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useTranscript(callId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["calls", callId, "transcript"],
    enabled,
    retry: false,
    queryFn: () =>
      apiFetch(`/api/calls/${callId}/transcript`, { schema: transcriptSchema }),
  });
}

export function fetchRecordingUrl(callId: string): Promise<{ url: string }> {
  return apiFetch(`/api/calls/${callId}/recording`);
}

export type { TranscriptStatus };
```

- [ ] **Step 4: Implement the media component**

`console/web/src/components/CallMedia.tsx`:

```tsx
import type { Call, TranscriptStatus } from "@console/shared";
import { useState } from "react";
import { fetchRecordingUrl, useTranscript } from "../api/campaigns.js";

export function transcriptLabel(
  status: TranscriptStatus | null,
  hasRecording: boolean,
): string {
  if (status === null) return hasRecording ? "Not transcribed" : "No recording yet";
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Transcribing";
    case "done":
      return "Transcript ready";
    case "failed":
      return "Transcription failed";
  }
}

export function CallMedia({ call }: { call: Call }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = useTranscript(call.id, call.transcriptStatus === "done");

  async function loadAudio() {
    setError(null);
    try {
      // Presigned on demand rather than with the row, so a list of 500 calls
      // does not mint 500 URLs nobody opens.
      setUrl((await fetchRecordingUrl(call.id)).url);
    } catch {
      setError("Could not load the recording");
    }
  }

  return (
    <div className="space-y-3 bg-slate-50 px-3 py-3 text-sm">
      <div className="flex items-center gap-3">
        {call.hasRecording ? (
          url ? (
            <audio controls src={url} className="h-8 w-full max-w-md" />
          ) : (
            <button onClick={() => void loadAudio()} className="underline text-slate-600">
              Load recording
            </button>
          )
        ) : (
          <span className="text-slate-500">No recording stored for this call.</span>
        )}
        <span className="text-slate-500">
          {transcriptLabel(call.transcriptStatus, call.hasRecording)}
        </span>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {call.transcriptStatus === "failed" && (
        <p className="rounded bg-red-50 p-2 text-red-800">
          Transcription failed. Use Transcribe again to retry it.
        </p>
      )}

      {transcript.data?.text && (
        <p className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 text-slate-800">
          {transcript.data.text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/web -- transcript-label`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire it into the detail screen**

In `console/web/src/routes/CampaignDetail.tsx`:

```tsx
import { useState } from "react";
import { useTranscribeCampaign } from "../api/campaigns.js";
import { CallMedia } from "../components/CallMedia.js";
```

```tsx
  const transcribe = useTranscribeCampaign(id);
  const [expanded, setExpanded] = useState<string | null>(null);
```

Poll while any transcript is unfinished, not only while the campaign runs -
otherwise a completed campaign's transcripts never appear without a refresh:

```tsx
  const transcribing = calls?.some(
    (call) => call.transcriptStatus === "pending" || call.transcriptStatus === "running",
  );
  const live = campaign?.status === "running" || transcribing === true;
```

Add the button beside Pause and Launch:

```tsx
          <button
            onClick={() => transcribe.mutate()}
            disabled={transcribe.isPending}
            className="rounded px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200 disabled:opacity-50"
          >
            {transcribe.isPending ? "Queueing" : "Transcribe"}
          </button>
```

Make each row expandable, replacing the `<tr>` body with a fragment:

```tsx
            <>
              <tr
                key={call.id}
                onClick={() => setExpanded(expanded === call.id ? null : call.id)}
                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                ...existing cells...
              </tr>
              {expanded === call.id && (
                <tr key={`${call.id}-media`}>
                  <td colSpan={6} className="p-0">
                    <CallMedia call={call} />
                  </td>
                </tr>
              )}
            </>
```

- [ ] **Step 7: Verify by hand**

With `DIALER=fake`, run a three-contact campaign to completion. The fake reports
`call.recording.saved` with `https://fake.invalid/recording.mp3`, so ingest jobs
will fail with a DNS error - that is correct and expected. Confirm:

- `select kind, attempts, last_error from jobs` shows `ingest_recording` retrying
  with a network error, proving the queue, runner, and backoff all work.
- The calls table shows "No recording yet" for each call.

For the media path itself, stub a recording by hand:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U console -d console -c \
  "UPDATE recordings SET s3_key = 'seed/sample.mp3', bytes = 1024, ingested_at = now(), telnyx_deleted_at = now();"
```

Upload any small mp3 to MinIO at `console-dev/seed/sample.mp3`, then reload the
campaign. Expected: rows expand, "Load recording" plays the file, and
"Transcribe" moves the status through Queued to Transcript ready - which does
call OpenAI and does cost money, so use one short file.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 9: Production configuration and documentation

**Files:**
- Modify: `console/docker-compose.prod.yml`
- Modify: `console/.env.example`, `console/.env.prod.example`
- Modify: `console/README.md`

- [ ] **Step 1: Add the two secrets to both services**

In `console/docker-compose.prod.yml`, add to the environment of both `api` and
`worker`:

```yaml
      TELNYX_API_KEY: ${TELNYX_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
```

Both processes load the same `Config`, which now requires them, so omitting
either from one service makes that container fail at boot rather than at the
first job. That is the intent.

- [ ] **Step 2: Extend the env examples**

Add to `console/.env.example` and `console/.env.prod.example`:

```
TELNYX_API_KEY=match-the-worker-TELNYX_API_KEY
OPENAI_API_KEY=sk-...
```

`TELNYX_API_KEY` must be the same key the Worker holds. The console uses it only
to delete recordings once they are safely in S3.

- [ ] **Step 3: Confirm the IAM policy covers the new keys**

The instance role already needs `s3:PutObject` and `s3:GetObject` on
`arn:aws:s3:::<bucket>/*` from Plan 1. Nothing new is required - recordings and
transcripts live under the same prefix. Verify the bucket policy does not
restrict by prefix in a way that excludes `tenants/*/calls/*`.

- [ ] **Step 4: Update the README**

Append to `console/README.md`:

```markdown
## Recordings and transcripts

Telnyx records every call dual-channel. When the Worker reports
`call.recording.saved`, the console stores a `recordings` row and enqueues an
`ingest_recording` job. That job:

1. Downloads the mp3 from Telnyx and verifies it is neither empty nor truncated.
2. Uploads it to `tenants/{tenant}/calls/{call}/recording.mp3`.
3. Only then deletes it at Telnyx.

The order matters and is tested: a failed ingest must never destroy the only
copy of a call. A job that dies between step 2 and step 3 finishes correctly on
retry, because each stage is skipped if already done.

### Transcription

Nothing transcribes automatically - Whisper is billed per minute. The
"Transcribe" button on a campaign enqueues one job per ingested recording that
has no finished transcript, using the campaign's `language` as the hint. Failed
transcripts are re-enqueued by pressing the button again.

Transcripts are one blob per call. Per-question segmentation is deliberately out
of scope; the verbose Whisper response is kept at
`tenants/{tenant}/calls/{call}/transcript.json` for whatever reads it next.

Files above 24 MB fail with an explicit message rather than being truncated. A
call long enough to hit that is itself a signal something went wrong.

### Jobs

`jobs` is a plain Postgres table drained by the `worker` process with
`SELECT ... FOR UPDATE SKIP LOCKED`. Failures retry with exponential backoff to
`max_attempts` and then stop, leaving `failed_at` and `last_error` visible:

    select kind, attempts, last_error, failed_at from jobs where completed_at is null;

The `JobQueue` interface exists so the media jobs can move to SQS when volume
justifies it. Dispatch never moves to a queue - it is gated by number
availability, not worker capacity.
```

- [ ] **Step 5: Deploy and verify the ingest path**

Deploy, then place one live call (**ask the operator first** - it dials a real
phone and bills their account). Watch `docker compose logs -f worker`.

Expected within a minute of the call ending:

```sql
select r.telnyx_recording_id, r.bytes, r.ingested_at, r.telnyx_deleted_at
  from recordings r order by r.created_at desc limit 1;
```

All four populated. Then confirm the recording is genuinely gone from Telnyx:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  https://api.telnyx.com/v2/recordings/<telnyx_recording_id>
```

Expected: `404`. A 200 means the delete did not happen and recordings are
accumulating in the Telnyx account.

- [ ] **Step 6: Verify transcription end to end**

Press Transcribe on that campaign. Expected: the job runs, the row shows
"Transcript ready", the text is readable in the expanded row, and
`transcript.json` exists in S3 beside the recording.

---

## Plan self-review

Checked against `docs/superpowers/specs/2026-08-04-console-design.md`, Plan 3
scope:

| Spec requirement | Task |
|---|---|
| `recordings`, `transcripts`, `jobs` tables | 1 |
| `JobQueue` interface with a Postgres implementation | 2 |
| `SKIP LOCKED` claim, backoff, max attempts | 2 |
| Telnyx recording download and delete | 3 |
| Ingest to S3 with deletion strictly after verified upload | 4 |
| Whisper transcription with the campaign's language hint | 5 |
| 24 MB guard rather than a truncated transcript | 5 |
| Job runner inside the `worker` process | 6 |
| `call.recording.saved` enqueues ingest, idempotently | 6 |
| On-demand transcription endpoint | 7 |
| Presigned recording playback, transcript read | 7 |
| Transcript UI in the campaign detail screen | 8 |
| Production compose and EC2 notes | 9 |

The spec's "Explicitly out of scope" list is unchanged by this plan: no
per-question segmentation, no analysis of transcript content, no automatic
transcription.

