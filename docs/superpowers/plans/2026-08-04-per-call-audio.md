# Per-Call Audio Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four hardcoded static audio assets with a per-call audio manifest supplied by the caller of `POST /calls`, supporting 1 to 10 questions.

**Architecture:** The backend passes a manifest of pre-signed HTTPS URLs. The Worker validates it (structure plus SigV4 expiry, no AWS credentials needed), dials, then seeds the manifest into the call's Durable Object keyed by `call_control_id`. The DO persists it to storage so it survives ring-time eviction, and uses it to issue every playback after the first. `decide()` stops deriving URLs and receives the manifest as input.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite storage, Wrangler, Vitest, Telnyx Call Control v2 API.

**Spec:** `docs/superpowers/specs/2026-08-04-per-call-audio-design.md`

## Global Constraints

- TypeScript strict mode with `noUncheckedIndexedAccess`. **Do not widen types to make a build pass.**
- No emojis in source or docs.
- **Never run `git commit`** — the operator manages all commits. Where a task says "Stage and report the commit", stage the files and print the suggested command for the operator to run.
- All work happens in `cf-worker/`. Run all npm commands from that directory.
- `MAX_QUESTIONS = 10`. A survey holds 1 to 10 questions inclusive.
- Audio is **required** on every call. There is no fallback to the bundled `public/audio/` placeholders.
- The webhook route always returns HTTP 200. A non-2xx makes Telnyx retry and double-advance the flow.
- Only `https:` audio URLs are accepted. `http:` is rejected outright.

## Deviation from the spec

The spec places `AudioManifest` in `src/manifest.ts`. This plan places it in
`src/flow.ts` instead. Reason: `manifest.ts` needs `MAX_ANSWER_MS` to compute
required URL runway, and that constant lives in `flow.ts`. If `flow.ts` also
imported `AudioManifest` from `manifest.ts` the two would form an import cycle.
Putting the type in `flow.ts` gives a clean one-directional graph
(`index.ts` -> `manifest.ts` -> `flow.ts` -> `state.ts`) and avoids duplicating a
timing constant in two files. Nothing else about the design changes.

## File structure

| File | Responsibility |
|---|---|
| `src/state.ts` | `client_state` encode/decode. Owns `MAX_QUESTIONS`. |
| `src/flow.ts` | Pure command construction. Owns `AudioManifest` and `MAX_ANSWER_MS`. |
| `src/manifest.ts` | **New.** Pure validation of untrusted manifest input, including SigV4 expiry. |
| `src/session.ts` | Durable Object: media socket, VAD state, and now per-call manifest storage. |
| `src/index.ts` | Routing: validate, dial, seed, dispatch. |

---

### Task 1: Widen Step and introduce MAX_QUESTIONS

Variable question count means `client_state` must carry steps beyond 3. This is
the foundation every later task builds on.

**Files:**
- Modify: `cf-worker/src/state.ts`
- Modify: `cf-worker/test/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Step = number | "done"`
  - `const MAX_QUESTIONS = 10`
  - `encodeState` and `decodeState` unchanged in signature. `decodeState` now accepts `"done"` or an integer in `1..MAX_QUESTIONS`.

  Tasks 2, 3, 4 and 5 all import `MAX_QUESTIONS` or the widened `Step`.

- [ ] **Step 1: Update the test for the widened range**

Replace the two affected blocks in `cf-worker/test/state.test.ts`. Note the
import line gains `MAX_QUESTIONS`.

```ts
import { describe, expect, it } from "vitest";
import {
  decodeState,
  encodeState,
  MAX_QUESTIONS,
  type FlowState,
} from "../src/state";
```

Replace the `round-trips every valid step` test:

```ts
  it("round-trips every valid step", () => {
    const steps: FlowState["step"][] = [1, 2, 3, 9, MAX_QUESTIONS, "done"];
    for (const step of steps) {
      expect(decodeState(encodeState({ step }))).toEqual({ step });
    }
  });
```

Replace the `out-of-range step` test entirely:

```ts
  it("returns null for an out-of-range step", () => {
    expect(decodeState(btoa(JSON.stringify({ step: 0 })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: -1 })))).toBeNull();
    expect(
      decodeState(btoa(JSON.stringify({ step: MAX_QUESTIONS + 1 }))),
    ).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: 1.5 })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: "3" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: "nope" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({})))).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL. `MAX_QUESTIONS` is not exported, and step 9 currently decodes to
`null` where the test now expects `{ step: 9 }`.

- [ ] **Step 3: Widen the implementation**

Replace `cf-worker/src/state.ts` entirely:

```ts
export type Step = number | "done";

export interface FlowState {
  step: Step;
}

/** Upper bound on questions in one survey. Also bounds what client_state accepts. */
export const MAX_QUESTIONS = 10;

export function encodeState(state: FlowState): string {
  return btoa(JSON.stringify(state));
}

export function decodeState(raw: string | null | undefined): FlowState | null {
  if (!raw) return null;

  let json: string;
  try {
    json = atob(raw);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const step = (parsed as { step?: unknown }).step;

  if (step === "done") return { step: "done" };

  if (
    typeof step === "number" &&
    Number.isInteger(step) &&
    step >= 1 &&
    step <= MAX_QUESTIONS
  ) {
    return { step };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Stage and report the commit**

Do not run this. Print it for the operator:

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/src/state.ts cf-worker/test/state.test.ts
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: widen client_state step range for variable question count"
```

---

### Task 2: Manifest validation

Pure module. No network, no ambient clock. This is where the S3 expiry check
lives.

**Files:**
- Modify: `cf-worker/src/flow.ts` (add the `AudioManifest` type and export `MAX_ANSWER_MS` — it is already exported, confirm)
- Create: `cf-worker/src/manifest.ts`
- Create: `cf-worker/test/manifest.test.ts`

**Interfaces:**
- Consumes: `MAX_QUESTIONS` from `src/state.ts` (Task 1); `MAX_ANSWER_MS` from `src/flow.ts`.
- Produces:
  - `interface AudioManifest { questions: string[]; thanks: string }` — exported from `src/flow.ts`
  - `interface ManifestError { field: string; reason: string }`
  - `type ManifestResult = { manifest: AudioManifest } | { error: ManifestError }`
  - `parseManifest(value: unknown, nowMs?: number): ManifestResult`
  - `requiredRunwayMs(questionCount: number): number`
  - `presignedExpiryMs(url: URL): number | null`

  Task 3 imports `AudioManifest`. Task 5 imports `parseManifest`.

- [ ] **Step 1: Add the AudioManifest type to flow.ts**

Add to `cf-worker/src/flow.ts`, directly below the `Env` interface. This is the
only change to `flow.ts` in this task; Task 3 does the rest.

```ts
/** The audio for one call. Supplied per call, validated in manifest.ts. */
export interface AudioManifest {
  questions: string[];
  thanks: string;
}
```

Confirm `MAX_ANSWER_MS` is already exported from `flow.ts`. It is, at
`export const MAX_ANSWER_MS = 30000;`. Leave it alone.

- [ ] **Step 2: Write the failing test**

Create `cf-worker/test/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseManifest, presignedExpiryMs, requiredRunwayMs } from "../src/manifest";
import { MAX_QUESTIONS } from "../src/state";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

function amzDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** A SigV4 pre-signed URL signed at `signedAtMs`, valid for `ttlSeconds`. */
function presigned(ttlSeconds: number, signedAtMs = NOW): string {
  return (
    "https://bucket.s3.amazonaws.com/q.mp3" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    `&X-Amz-Date=${amzDate(signedAtMs)}` +
    `&X-Amz-Expires=${ttlSeconds}` +
    "&X-Amz-Signature=deadbeef"
  );
}

/** An hour of runway, which is the agreed signing TTL. */
function goodUrl(): string {
  return presigned(3600);
}

function manifest(overrides: Record<string, unknown> = {}) {
  return { questions: [goodUrl()], thanks: goodUrl(), ...overrides };
}

describe("requiredRunwayMs", () => {
  it("scales with the question count", () => {
    expect(requiredRunwayMs(10)).toBeGreaterThan(requiredRunwayMs(1));
  });

  it("stays well inside a 60 minute signing TTL at the maximum count", () => {
    expect(requiredRunwayMs(MAX_QUESTIONS)).toBeLessThan(60 * 60 * 1000);
  });
});

describe("presignedExpiryMs", () => {
  it("computes expiry from X-Amz-Date and X-Amz-Expires", () => {
    const url = new URL(presigned(3600));
    expect(presignedExpiryMs(url)).toBe(NOW + 3600 * 1000);
  });

  it("returns null for a URL that is not pre-signed", () => {
    expect(presignedExpiryMs(new URL("https://cdn.example/q.mp3"))).toBeNull();
  });

  it("returns null for a malformed X-Amz-Date rather than throwing", () => {
    const url = new URL(
      "https://b.s3.amazonaws.com/q.mp3?X-Amz-Date=nonsense&X-Amz-Expires=3600",
    );
    expect(presignedExpiryMs(url)).toBeNull();
  });
});

describe("parseManifest - shape", () => {
  it("accepts a valid manifest", () => {
    const result = parseManifest(manifest(), NOW);
    expect(result).toEqual({
      manifest: { questions: [goodUrl()], thanks: goodUrl() },
    });
  });

  it("accepts the maximum question count", () => {
    const questions = Array.from({ length: MAX_QUESTIONS }, () => goodUrl());
    const result = parseManifest(manifest({ questions }), NOW);
    expect("manifest" in result).toBe(true);
  });

  it.each([undefined, null, "string", 42])("rejects %s as the audio value", (bad) => {
    const result = parseManifest(bad, NOW);
    expect(result).toEqual({ error: { field: "audio", reason: "is required" } });
  });

  it("rejects questions that is not an array", () => {
    const result = parseManifest(manifest({ questions: "one" }), NOW);
    expect("error" in result && result.error.field).toBe("audio.questions");
  });

  it("rejects an empty questions array", () => {
    const result = parseManifest(manifest({ questions: [] }), NOW);
    expect("error" in result && result.error.reason).toContain("empty");
  });

  it("rejects more than MAX_QUESTIONS entries", () => {
    const questions = Array.from({ length: MAX_QUESTIONS + 1 }, () => goodUrl());
    const result = parseManifest(manifest({ questions }), NOW);
    expect("error" in result && result.error.reason).toContain("at most");
  });

  it("rejects a missing thanks", () => {
    const result = parseManifest({ questions: [goodUrl()] }, NOW);
    expect("error" in result && result.error.field).toBe("audio.thanks");
  });

  it("names the offending question by index", () => {
    const result = parseManifest(
      manifest({ questions: [goodUrl(), "not a url"] }),
      NOW,
    );
    expect("error" in result && result.error.field).toBe("audio.questions[1]");
  });
});

describe("parseManifest - URL rules", () => {
  it("rejects http", () => {
    const result = parseManifest(
      manifest({ questions: ["http://cdn.example/q.mp3"] }),
      NOW,
    );
    expect("error" in result && result.error.reason).toContain("https");
  });

  it("accepts a plain public https URL as opaque", () => {
    const result = parseManifest(
      { questions: ["https://cdn.example/q.mp3"], thanks: "https://cdn.example/t.mp3" },
      NOW,
    );
    expect("manifest" in result).toBe(true);
  });

  it("rejects an already expired pre-signed URL", () => {
    const expired = presigned(60, NOW - 10 * 60 * 1000);
    const result = parseManifest(manifest({ questions: [expired] }), NOW);
    expect("error" in result && result.error.reason).toContain("expires in");
  });

  it("rejects a pre-signed URL whose TTL is too short for the survey", () => {
    const questions = Array.from({ length: MAX_QUESTIONS }, () => presigned(300));
    const result = parseManifest(manifest({ questions }), NOW);
    expect("error" in result).toBe(true);
  });

  it("accepts a TTL just inside the required runway", () => {
    const needed = requiredRunwayMs(1);
    const ttl = Math.ceil(needed / 1000) + 10;
    const result = parseManifest(
      { questions: [presigned(ttl)], thanks: presigned(ttl) },
      NOW,
    );
    expect("manifest" in result).toBe(true);
  });

  it("rejects a TTL just outside the required runway", () => {
    const needed = requiredRunwayMs(1);
    const ttl = Math.floor(needed / 1000) - 10;
    const result = parseManifest(
      { questions: [presigned(ttl)], thanks: presigned(ttl) },
      NOW,
    );
    expect("error" in result).toBe(true);
  });

  it("checks the thanks URL too, not just the questions", () => {
    const result = parseManifest(
      { questions: [goodUrl()], thanks: presigned(60, NOW - 10 * 60 * 1000) },
      NOW,
    );
    expect("error" in result && result.error.field).toBe("audio.thanks");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/manifest`.

- [ ] **Step 4: Write the implementation**

Create `cf-worker/src/manifest.ts`:

```ts
import { MAX_ANSWER_MS, type AudioManifest } from "./flow";
import { MAX_QUESTIONS } from "./state";

export interface ManifestError {
  field: string;
  reason: string;
}

export type ManifestResult =
  | { manifest: AudioManifest }
  | { error: ManifestError };

/** Telnyx rings this long before giving up. */
const RING_ALLOWANCE_MS = 60_000;
/** Generous upper bound on how long one recording takes to play. */
const PLAYBACK_ALLOWANCE_MS = 10_000;
const MARGIN_MS = 60_000;

/**
 * How much life a pre-signed URL needs at dial time. Telnyx fetches each
 * audio_url at the moment it plays, so the thank-you is fetched last and latest.
 * Computed from the question count rather than a flat constant, so a ten
 * question survey is checked properly and a one question survey is not
 * over-rejected.
 */
export function requiredRunwayMs(questionCount: number): number {
  return (
    RING_ALLOWANCE_MS +
    questionCount * (MAX_ANSWER_MS + PLAYBACK_ALLOWANCE_MS) +
    PLAYBACK_ALLOWANCE_MS +
    MARGIN_MS
  );
}

const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Expiry of a SigV4 pre-signed URL in epoch ms, or null if the URL is not one.
 * X-Amz-Date is ISO8601 basic format, which Date.parse does not handle
 * reliably, so it is parsed by hand. No AWS credentials are involved.
 */
export function presignedExpiryMs(url: URL): number | null {
  const date = url.searchParams.get("X-Amz-Date");
  const expires = url.searchParams.get("X-Amz-Expires");
  if (!date || !expires) return null;

  const match = AMZ_DATE.exec(date);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;

  const seconds = Number(expires);
  if (!Number.isFinite(seconds)) return null;

  const signedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return signedAt + seconds * 1000;
}

function checkUrl(
  raw: unknown,
  field: string,
  runwayMs: number,
  nowMs: number,
): ManifestError | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return { field, reason: "must be a non-empty string" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { field, reason: "is not a valid URL" };
  }

  // Telnyx needs public HTTPS anyway, and a pre-signed URL sent in clear text
  // leaks its own signature.
  if (url.protocol !== "https:") {
    return { field, reason: `must use https, got ${url.protocol}` };
  }

  const expiresAt = presignedExpiryMs(url);
  if (expiresAt !== null && expiresAt - nowMs < runwayMs) {
    const remaining = Math.round((expiresAt - nowMs) / 1000);
    const needed = Math.round(runwayMs / 1000);
    return {
      field,
      reason: `pre-signed URL expires in ${remaining}s, needs at least ${needed}s`,
    };
  }

  return null;
}

/**
 * Validate untrusted manifest input. `nowMs` is injectable purely so expiry
 * tests can control the clock, matching the convention in verify.ts.
 */
export function parseManifest(value: unknown, nowMs = Date.now()): ManifestResult {
  if (typeof value !== "object" || value === null) {
    return { error: { field: "audio", reason: "is required" } };
  }

  const { questions, thanks } = value as {
    questions?: unknown;
    thanks?: unknown;
  };

  if (!Array.isArray(questions)) {
    return { error: { field: "audio.questions", reason: "must be an array" } };
  }
  if (questions.length === 0) {
    return { error: { field: "audio.questions", reason: "must not be empty" } };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      error: {
        field: "audio.questions",
        reason: `must hold at most ${MAX_QUESTIONS} entries, got ${questions.length}`,
      },
    };
  }

  const runwayMs = requiredRunwayMs(questions.length);

  for (let i = 0; i < questions.length; i++) {
    const error = checkUrl(questions[i], `audio.questions[${i}]`, runwayMs, nowMs);
    if (error) return { error };
  }

  const thanksError = checkUrl(thanks, "audio.thanks", runwayMs, nowMs);
  if (thanksError) return { error: thanksError };

  return {
    manifest: {
      questions: questions as string[],
      thanks: thanks as string,
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/manifest.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/src/manifest.ts cf-worker/src/flow.ts cf-worker/test/manifest.test.ts
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add per-call audio manifest validation"
```

---

### Task 3: Drive flow.ts from the manifest

`decide()` stops deriving audio URLs from `origin` and hardcoded filenames.

**Files:**
- Modify: `cf-worker/src/flow.ts`
- Modify: `cf-worker/test/flow.test.ts`

**Interfaces:**
- Consumes: `AudioManifest` (added to `flow.ts` in Task 2); widened `Step` from `src/state.ts`.
- Produces:
  - `question(audio: AudioManifest, step: number): Command | null`
  - `nextAfterAnswer(audio: AudioManifest, answeredStep: number): Command | null`
  - `FlowInput` gains `audio?: AudioManifest`
  - `QUESTION_COUNT` is **removed**

  Task 4 imports `nextAfterAnswer`. Task 5 imports `decide` and `FlowInput`.

**Design notes:** `question` and `nextAfterAnswer` return `Command | null` rather
than asserting. With `noUncheckedIndexedAccess`, `questions[step - 1]` is
`string | undefined`, and the global constraint forbids widening types to make
the build pass. `null` means the step is out of range.

`originUrl` stays in `FlowInput` — it is still needed to build the `ws://` stream
URL. It is simply no longer an audio concern.

- [ ] **Step 1: Update the tests**

Replace `cf-worker/test/flow.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENCE_MS,
  decide,
  nextAfterAnswer,
  normaliseSilenceMs,
  question,
  type AudioManifest,
  type FlowInput,
} from "../src/flow";
import { decodeState, encodeState, type FlowState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

const AUDIO: AudioManifest = {
  questions: [
    "https://cdn.example/a/q1.mp3",
    "https://cdn.example/a/q2.mp3",
    "https://cdn.example/a/q3.mp3",
  ],
  thanks: "https://cdn.example/a/thanks.mp3",
};

function manifestOf(count: number): AudioManifest {
  return {
    questions: Array.from({ length: count }, (_, i) => `https://cdn.example/q${i + 1}.mp3`),
    thanks: "https://cdn.example/thanks.mp3",
  };
}

function run(
  eventType: string,
  state: FlowState | null = null,
  silenceMs?: FlowInput["silenceMs"],
  audio: AudioManifest | undefined = AUDIO,
) {
  return decide({
    eventType,
    clientState: state ? encodeState(state) : null,
    originUrl: ORIGIN,
    audio,
    silenceMs,
  });
}

describe("decide - call start", () => {
  it("records, opens the media stream, and plays question 1", () => {
    const commands = run("call.answered");

    expect(commands.map((c) => c.action)).toEqual([
      "record_start",
      "streaming_start",
      "playback_start",
    ]);
  });

  it("streams only the inbound track, so our playback is never heard as speech", () => {
    const streaming = run("call.answered").find(
      (c) => c.action === "streaming_start",
    );
    expect(streaming!.params.stream_track).toBe("inbound_track");
    expect(streaming!.params.stream_codec).toBe("PCMU");
  });

  it("points the stream at a wss URL carrying the silence threshold", () => {
    const streaming = run("call.answered", null, 3000).find(
      (c) => c.action === "streaming_start",
    );
    const url = new URL(String(streaming!.params.stream_url));

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("silenceMs")).toBe("3000");
  });

  it("defaults the silence threshold when none is given", () => {
    const streaming = run("call.answered").find(
      (c) => c.action === "streaming_start",
    );
    const url = new URL(String(streaming!.params.stream_url));
    expect(url.searchParams.get("silenceMs")).toBe(String(DEFAULT_SILENCE_MS));
  });

  it("plays the manifest's first question at step 1", () => {
    const playback = run("call.answered").find((c) => c.action === "playback_start");
    expect(playback!.params.audio_url).toBe(AUDIO.questions[0]);
    expect(decodeState(playback!.params.client_state as string)).toEqual({ step: 1 });
  });

  // decide() is called directly here: run()'s `audio` parameter defaults to
  // AUDIO, so passing undefined through it would silently supply the default.
  it("does nothing at all without a manifest", () => {
    expect(
      decide({ eventType: "call.answered", clientState: null, originUrl: ORIGIN }),
    ).toEqual([]);
  });

  it("does not start recording or streaming when the manifest has no questions", () => {
    const empty: AudioManifest = { questions: [], thanks: "https://cdn.example/t.mp3" };
    expect(run("call.answered", null, undefined, empty)).toEqual([]);
  });

  it("involves no AI, speech synthesis, or transcription", () => {
    const everything = [
      ...run("call.answered"),
      ...run("call.playback.ended", { step: "done" }),
      nextAfterAnswer(AUDIO, 1),
      nextAfterAnswer(AUDIO, 3),
    ];
    for (const c of everything) {
      expect(c).not.toBeNull();
      expect(c!.action).not.toContain("ai");
      expect(c!.action).not.toContain("speak");
      expect(c!.action).not.toContain("transcription");
      expect(c!.action).not.toContain("gather");
      expect(c!.params).not.toHaveProperty("voice");
    }
  });
});

describe("question", () => {
  it("is 1-based against a 0-based array", () => {
    expect(question(AUDIO, 2)!.params.audio_url).toBe(AUDIO.questions[1]);
  });

  it.each([0, -1, 4])("returns null for out-of-range step %i", (step) => {
    expect(question(AUDIO, step)).toBeNull();
  });
});

describe("nextAfterAnswer", () => {
  it.each([
    [1, 1],
    [2, 2],
  ] as const)("plays the next question after answer %i", (from, index) => {
    const command = nextAfterAnswer(AUDIO, from)!;

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(AUDIO.questions[index]);
    expect(decodeState(command.params.client_state as string)).toEqual({
      step: from + 1,
    });
  });

  it("plays the thank-you after the last answer", () => {
    const command = nextAfterAnswer(AUDIO, 3)!;

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(AUDIO.thanks);
    expect(decodeState(command.params.client_state as string)).toEqual({
      step: "done",
    });
  });

  it("plays the thank-you immediately in a one-question survey", () => {
    const one = manifestOf(1);
    const command = nextAfterAnswer(one, 1)!;
    expect(command.params.audio_url).toBe(one.thanks);
  });

  it("walks all ten questions then the thank-you", () => {
    const ten = manifestOf(10);
    for (let step = 1; step < 10; step++) {
      expect(nextAfterAnswer(ten, step)!.params.audio_url).toBe(
        ten.questions[step],
      );
    }
    expect(nextAfterAnswer(ten, 10)!.params.audio_url).toBe(ten.thanks);
  });

  it.each([0, -1, 4])("returns null for out-of-range step %i", (step) => {
    expect(nextAfterAnswer(AUDIO, step)).toBeNull();
  });
});

describe("decide - ending the call", () => {
  it("hangs up after the thank-you finishes", () => {
    const commands = run("call.playback.ended", { step: "done" });

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("hangup");
  });

  it.each([1, 2, 3] as const)(
    "sends no command when question %i finishes - the session drives the next one",
    (step) => {
      expect(run("call.playback.ended", { step })).toEqual([]);
    },
  );
});

describe("decide - events that must not produce commands", () => {
  it.each([
    ["call.recording.saved", { step: "done" } as FlowState],
    ["call.hangup", { step: "done" } as FlowState],
    ["call.playback.started", { step: 1 } as FlowState],
    ["call.initiated", null],
    ["some.unknown.event", null],
  ])("returns no commands for %s", (eventType, state) => {
    expect(run(eventType, state)).toEqual([]);
  });

  it("returns no commands when client_state is missing or malformed", () => {
    expect(run("call.playback.ended", null)).toEqual([]);
    expect(
      decide({
        eventType: "call.playback.ended",
        clientState: "!!!garbage!!!",
        originUrl: ORIGIN,
        audio: AUDIO,
      }),
    ).toEqual([]);
  });
});

describe("normaliseSilenceMs", () => {
  it("accepts a sane value", () => {
    expect(normaliseSilenceMs(3000)).toBe(3000);
  });

  it("accepts a numeric string, since it arrives from a query param", () => {
    expect(normaliseSilenceMs("3000")).toBe(3000);
  });

  it.each([undefined, null, "abc", NaN, 0, 100, 60000, -2500])(
    "falls back to the default for %s",
    (bad) => {
      expect(normaliseSilenceMs(bad)).toBe(DEFAULT_SILENCE_MS);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — `question` is not exported with that signature, and
`nextAfterAnswer` still takes an origin string.

- [ ] **Step 3: Rewrite the audio-producing part of flow.ts**

In `cf-worker/src/flow.ts`, delete `QUESTION_COUNT`, `audioUrl()`, and the
existing `play`, `question`, and `nextAfterAnswer`. Replace them with:

```ts
function play(audioUrl: string, step: Step): Command {
  return {
    action: "playback_start",
    params: {
      audio_url: audioUrl,
      client_state: encodeState({ step }),
    },
  };
}

/** `step` is 1-based; the questions array is 0-based. Null means out of range. */
export function question(audio: AudioManifest, step: number): Command | null {
  const url = audio.questions[step - 1];
  if (!url) return null;
  return play(url, step);
}

/**
 * What to play once an answer ends. Shared with the Durable Object, which is
 * what actually detects the end of speech and issues this command.
 */
export function nextAfterAnswer(
  audio: AudioManifest,
  answeredStep: number,
): Command | null {
  if (answeredStep < 1 || answeredStep > audio.questions.length) return null;
  if (answeredStep < audio.questions.length) {
    return question(audio, answeredStep + 1);
  }
  return play(audio.thanks, "done");
}
```

Update the `FlowInput` interface to add `audio`:

```ts
export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  /** Used only to build the stream URL. No longer an audio concern. */
  originUrl: string;
  /** Required for call.answered, unused for every other event. */
  audio?: AudioManifest;
  silenceMs?: number | string | null;
}
```

Replace the `call.answered` branch of `decide()`:

```ts
  if (eventType === "call.answered") {
    if (!audio) return [];

    const first = question(audio, 1);
    // A recording and a live media stream with nothing to play is worse than
    // no call at all.
    if (!first) return [];

    const streamUrl = new URL(originUrl.replace(/^http/, "ws"));
    streamUrl.pathname = "/stream";
    streamUrl.searchParams.set("silenceMs", String(silenceMs));

    return [
      {
        action: "record_start",
        params: {
          format: "mp3",
          channels: "dual",
          client_state: encodeState({ step: 1 }),
        },
      },
      {
        action: "streaming_start",
        params: {
          // Placeholder: the Worker rewrites this with the call_control_id,
          // which decide() has no access to.
          stream_url: streamUrl.toString(),
          // The caller only. Our own playbacks are on the outbound track, so
          // they can never be mistaken for the caller speaking.
          stream_track: "inbound_track",
          stream_codec: "PCMU",
          client_state: encodeState({ step: 1 }),
        },
      },
      first,
    ];
  }
```

Update the destructure at the top of `decide()` to pull `audio`:

```ts
  const { eventType, clientState, originUrl, audio } = input;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: FAIL. `session.ts` and `index.ts` still call the old signatures. That
is expected; Tasks 4 and 5 fix them. Record the errors and move on.

- [ ] **Step 6: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/src/flow.ts cf-worker/test/flow.test.ts
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: drive call flow audio from a per-call manifest"
```

---

### Task 4: Session storage and manifest routes

The Durable Object gains persistent storage and three routes.

**Files:**
- Modify: `cf-worker/src/session.ts`

**Interfaces:**
- Consumes: `nextAfterAnswer`, `AudioManifest`, `Env`, `MAX_ANSWER_MS`, `DEFAULT_SILENCE_MS` from `src/flow.ts`.
- Produces: DO routes `POST /init`, `GET /manifest`, `POST /end`, plus the existing `/arm` and `/stream`.

**Design notes:** There are no unit tests for this file. That is a deliberate,
recorded decision in the spec — adding `@cloudflare/vitest-pool-workers` was
considered and declined. Verification is `npm run typecheck` plus the live call
in Task 6. Be correspondingly careful.

The `origin` field is deleted: its only use was building audio URLs, which the
manifest now supplies.

- [ ] **Step 1: Add storage and the manifest field**

In `cf-worker/src/session.ts`, update the imports:

```ts
import {
  DEFAULT_SILENCE_MS,
  MAX_ANSWER_MS,
  nextAfterAnswer,
  type AudioManifest,
  type Env,
} from "./flow";
```

Replace the field declarations and constructor:

```ts
export class CallSession {
  private readonly env: Env;
  private readonly storage: DurableObjectStorage;

  private manifest: AudioManifest | null = null;
  private callControlId = "";
  private config: VadConfig = {
    silenceMs: DEFAULT_SILENCE_MS,
    maxAnswerMs: MAX_ANSWER_MS,
    threshold: SPEECH_THRESHOLD,
  };

  /** Which question we are collecting an answer for; 0 means not listening. */
  private step = 0;
  private vad: VadState = armedState(0);
  /** Guards against issuing the next question twice for one answer. */
  private advancing = false;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = state.storage;
    // The Worker seeds the manifest at dial time. Ring time is long enough for
    // an idle object to be evicted, so a woken object must reload it before
    // handling anything.
    state.blockConcurrencyWhile(async () => {
      this.manifest = (await this.storage.get<AudioManifest>("manifest")) ?? null;
    });
  }
```

Note the `origin` field is gone and `step` is now `number`.

- [ ] **Step 2: Add the three new routes to fetch()**

Replace the `fetch` method:

```ts
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/manifest")) return this.handleManifest();
    if (url.pathname.endsWith("/end")) return this.handleEnd();
    if (url.pathname.endsWith("/arm")) return this.handleArm(url);
    if (url.pathname.endsWith("/stream")) return this.handleStream(request, url);

    return new Response("not found", { status: 404 });
  }
```

- [ ] **Step 3: Implement the three handlers**

Add these methods to the class, above `handleArm`:

```ts
  /** Seeded by the Worker immediately after the dial succeeds. */
  private async handleInit(request: Request): Promise<Response> {
    let manifest: AudioManifest;
    try {
      manifest = (await request.json()) as AudioManifest;
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (
      !Array.isArray(manifest.questions) ||
      manifest.questions.length === 0 ||
      typeof manifest.thanks !== "string"
    ) {
      return new Response("invalid manifest", { status: 400 });
    }

    await this.storage.put("manifest", manifest);
    this.manifest = manifest;

    console.log(
      JSON.stringify({ msg: "session_init", questions: manifest.questions.length }),
    );
    return new Response("ok");
  }

  private handleManifest(): Response {
    if (!this.manifest) return new Response("no manifest", { status: 404 });
    return new Response(JSON.stringify(this.manifest), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Called on call.hangup so per-call manifests do not accumulate forever. */
  private async handleEnd(): Promise<Response> {
    await this.storage.deleteAll();
    this.manifest = null;
    this.step = 0;
    console.log(JSON.stringify({ msg: "session_end" }));
    return new Response("ok");
  }
```

- [ ] **Step 4: Bound the arm check against the manifest**

Replace `handleArm`:

```ts
  /** Called by the Worker when a question has finished playing. */
  private handleArm(url: URL): Response {
    // Arming an object that was never seeded is a bug, not a recoverable state.
    if (!this.manifest) return new Response("no manifest", { status: 400 });

    const step = Number(url.searchParams.get("step"));
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      step > this.manifest.questions.length
    ) {
      return new Response("bad step", { status: 400 });
    }

    this.step = step;
    this.advancing = false;
    this.vad = armedState(Date.now());

    console.log(JSON.stringify({ msg: "vad_armed", step }));
    return new Response("ok");
  }
```

- [ ] **Step 5: Drop origin from handleStream**

In `handleStream`, delete the line:

```ts
    this.origin = url.searchParams.get("origin") ?? "";
```

Leave the rest of the method unchanged.

- [ ] **Step 6: Update onMessage and advance**

In `onMessage`, the `answeredStep` local is now a plain `number`. Replace the
tail of the method (from `this.advancing = true;`) with:

```ts
    this.advancing = true;
    const answeredStep = this.step;
    this.step = 0;

    console.log(
      JSON.stringify({
        msg: "answer_ended",
        step: answeredStep,
        reason: result.decision,
      }),
    );

    await this.advance(answeredStep);
  }

  private async advance(answeredStep: number): Promise<void> {
    if (!this.callControlId || !this.manifest) return;

    const command = nextAfterAnswer(this.manifest, answeredStep);
    if (!command) {
      console.log(
        JSON.stringify({ msg: "advance_skipped", step: answeredStep }),
      );
      return;
    }

    try {
      await sendCommand(this.callControlId, command, this.env.TELNYX_API_KEY);
    } catch (error) {
      console.log(
        JSON.stringify({ msg: "advance_failed", error: String(error) }),
      );
    }
  }
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: FAIL, but only with errors pointing at `src/index.ts`. If any error
points at `src/session.ts`, fix it before continuing.

- [ ] **Step 8: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/src/session.ts
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: store the per-call audio manifest in the call session"
```

---

### Task 5: Wire the Worker

Validate at the edge, seed after the dial, read back on `call.answered`, clean up
on hangup.

**Files:**
- Modify: `cf-worker/src/index.ts`
- Modify: `cf-worker/test/index.test.ts`

**Interfaces:**
- Consumes: `parseManifest` from `src/manifest.ts`; `decide`, `AudioManifest` from `src/flow.ts`; `sendCommand`, `createCall`, `TelnyxError` from `src/telnyx.ts`.
- Produces: the final `POST /calls` contract and the seeded-DO lifecycle.

- [ ] **Step 1: Update the tests**

Replace the `env()` helper and the fixtures at the top of
`cf-worker/test/index.test.ts`. The DO stub becomes richer so seeding and
read-back are observable.

Update the import line:

```ts
import worker, { type Env } from "../src/index";
import { encodeState } from "../src/state";
import type { AudioManifest } from "../src/flow";
```

Replace the `sessionCalls` declaration and `env()`:

```ts
const AUDIO: AudioManifest = {
  questions: ["https://cdn.example/q1.mp3", "https://cdn.example/q2.mp3"],
  thanks: "https://cdn.example/thanks.mp3",
};

/** Records every URL the Worker sends to a session object. */
let sessionCalls: string[] = [];
/** What the fake session object hands back from GET /manifest. */
let storedManifest: AudioManifest | null = AUDIO;
/** Whether POST /init succeeds. */
let seedOk = true;
/** What the Worker actually seeded. */
let seededManifest: AudioManifest | null = null;

function env(): Env {
  sessionCalls = [];
  storedManifest = AUDIO;
  seedOk = true;
  seededManifest = null;

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        sessionCalls.push(url);

        if (url.endsWith("/init")) {
          if (!seedOk) return new Response("boom", { status: 500 });
          seededManifest = JSON.parse(String(init?.body)) as AudioManifest;
          return new Response("ok");
        }
        if (url.endsWith("/manifest")) {
          if (!storedManifest) return new Response("no manifest", { status: 404 });
          return new Response(JSON.stringify(storedManifest), { status: 200 });
        }
        return new Response("ok");
      },
    }),
  };

  return {
    TELNYX_API_KEY: "KEY",
    TELNYX_PUBLIC_KEY: publicKeyB64,
    TELNYX_CONNECTION_ID: "conn-1",
    TELNYX_FROM_NUMBER: "+15550000000",
    TRIGGER_SECRET: "s3cret",
    CALL_SESSIONS: namespace as unknown as DurableObjectNamespace,
  };
}
```

Replace the stream-url assertion test — `origin` is gone:

```ts
  it("injects the call id into the stream url so audio and webhooks share a session", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(await answeredWebhook(), env(), ctx);

    const body = JSON.parse(spy.mock.calls[1]![1].body);
    const url = new URL(body.stream_url);
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("ccid")).toBe("ccid-1");
    expect(url.searchParams.get("origin")).toBeNull();
  });
```

Replace the audio-url test:

```ts
  it("plays the seeded manifest's first question", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(await answeredWebhook(), env(), ctx);

    const body = JSON.parse(spy.mock.calls[2]![1].body);
    expect(body.audio_url).toBe(AUDIO.questions[0]);
  });

  it("hangs up when the session has no manifest", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();
    storedManifest = null;

    const response = await worker.fetch(await answeredWebhook(), e, ctx);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("/actions/hangup");
  });

  it("wipes the session on call.hangup", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();

    const request = await signedWebhook({
      data: {
        event_type: "call.hangup",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done" }),
        },
      },
    });
    await worker.fetch(request, e, ctx);

    expect(sessionCalls.some((u) => u.endsWith("/end"))).toBe(true);
  });
```

Replace the whole `describe("POST /calls")` block:

```ts
describe("POST /calls", () => {
  function dialSpy() {
    return vi.fn(
      async (_url: string, _init: { method: string; body: string }) =>
        new Response(JSON.stringify({ data: { call_control_id: "ccid-9" } }), {
          status: 200,
        }),
    );
  }

  function callRequest(body: unknown) {
    return new Request("https://w.example.dev/calls", {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing or wrong bearer token", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const headerCases: Record<string, string>[] = [
      {},
      { Authorization: "Bearer wrong" },
    ];
    for (const headers of headerCases) {
      const response = await worker.fetch(
        new Request("https://w.example.dev/calls", {
          method: "POST",
          headers,
          body: JSON.stringify({ to: "+37060000000", audio: AUDIO }),
        }),
        env(),
        ctx,
      );
      expect(response.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("dials via Telnyx and returns the call_control_id", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({ to: "+37060000000", audio: AUDIO }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      call_control_id: "ccid-9",
      silenceMs: 2500,
    });

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toBe(
      "https://w.example.dev/webhooks/telnyx?silenceMs=2500",
    );
    expect(sent.from).toBe("+15550000000");
  });

  it("seeds the session with the manifest after dialling", async () => {
    vi.stubGlobal("fetch", dialSpy());

    await worker.fetch(callRequest({ to: "+37060000000", audio: AUDIO }), env(), ctx);

    expect(sessionCalls.some((u) => u.endsWith("/init"))).toBe(true);
    expect(seededManifest).toEqual(AUDIO);
  });

  it("hangs up and returns 502 when seeding fails", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();
    seedOk = false;

    const response = await worker.fetch(
      callRequest({ to: "+37060000000", audio: AUDIO }),
      e,
      ctx,
    );

    expect(response.status).toBe(502);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("/actions/hangup"))).toBe(
      true,
    );
  });

  it("puts a custom silenceMs on the webhook_url", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      callRequest({ to: "+37069625082", silenceMs: 3000, audio: AUDIO }),
      env(),
      ctx,
    );

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toContain("silenceMs=3000");
  });

  it("rejects a body with no `to`", async () => {
    const response = await worker.fetch(
      callRequest({ audio: AUDIO }),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a body with no audio and does not dial", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({ to: "+37060000000" }),
      env(),
      ctx,
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an http audio url and does not dial", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({
        to: "+37060000000",
        audio: { questions: ["http://cdn.example/q1.mp3"], thanks: AUDIO.thanks },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — the Worker still derives audio from `origin` and does not seed
the session.

- [ ] **Step 3: Update the imports and withCallId**

In `cf-worker/src/index.ts`, update the imports:

```ts
import { decide, normaliseSilenceMs, type AudioManifest, type Command, type Env } from "./flow";
import { parseManifest } from "./manifest";
import { decodeState } from "./state";
import { createCall, sendCommand, TelnyxError } from "./telnyx";
import { verifyTelnyxSignature } from "./verify";
```

Replace `withCallId` — `origin` is no longer needed by the session:

```ts
/**
 * decide() cannot build the stream URL alone: it needs the call_control_id so
 * the media socket lands on the same Durable Object the webhooks address.
 */
function withCallId(command: Command, callControlId: string): Command {
  if (command.action !== "streaming_start") return command;

  const url = new URL(String(command.params.stream_url));
  url.searchParams.set("ccid", callControlId);

  return { ...command, params: { ...command.params, stream_url: url.toString() } };
}
```

Add a manifest reader below `sessionFor`:

```ts
async function manifestFor(
  env: Env,
  callControlId: string,
): Promise<AudioManifest | null> {
  const response = await sessionFor(env, callControlId).fetch(
    "https://session/manifest",
  );
  if (!response.ok) return null;
  return (await response.json()) as AudioManifest;
}

async function hangUp(env: Env, callControlId: string): Promise<void> {
  try {
    await sendCommand(callControlId, { action: "hangup", params: {} }, env.TELNYX_API_KEY);
  } catch {
    // Nothing further we can do.
  }
}
```

- [ ] **Step 4: Update handleWebhook**

In `handleWebhook`, replace the block that begins at the `call.playback.ended`
comment and ends with the `decide(...)` call:

```ts
  // A question has finished playing: tell the session to start listening for
  // the answer. This is the only trigger that starts voice detection.
  if (eventType === "call.playback.ended") {
    const state = decodeState(clientState);
    if (state && state.step !== "done") {
      await sessionFor(env, callControlId).fetch(
        `https://session/arm?step=${state.step}`,
      );
    }
  }

  // Per-call manifests must not accumulate in Durable Object storage.
  if (eventType === "call.hangup") {
    await sessionFor(env, callControlId).fetch("https://session/end", {
      method: "POST",
    });
  }

  // Only call.answered needs the manifest, so only it pays for the round trip.
  let audio: AudioManifest | undefined;
  if (eventType === "call.answered") {
    audio = (await manifestFor(env, callControlId)) ?? undefined;
    if (!audio) {
      console.log(
        JSON.stringify({ msg: "manifest_missing", call_control_id: callControlId }),
      );
      await hangUp(env, callControlId);
      return json({ ok: true });
    }
  }

  const commands = decide({
    eventType,
    clientState,
    originUrl: origin,
    audio,
    silenceMs: requestUrl.searchParams.get("silenceMs"),
  });
```

Update the dispatch loop to the new `withCallId` signature and reuse `hangUp`:

```ts
  for (const command of commands) {
    const finalCommand = withCallId(command, callControlId);
    try {
      const result = await sendCommand(callControlId, finalCommand, env.TELNYX_API_KEY);
      console.log(
        JSON.stringify({
          msg: "command_sent",
          action: finalCommand.action,
          params: finalCommand.params,
          response: result.slice(0, 500),
        }),
      );
    } catch (error) {
      const status = error instanceof TelnyxError ? error.status : 0;
      console.log(
        JSON.stringify({
          msg: "command_failed",
          action: finalCommand.action,
          status,
          error: String(error),
        }),
      );
      // Do not leave the callee on a silent open line.
      if (finalCommand.action !== "hangup") {
        await hangUp(env, callControlId);
      }
      break;
    }
  }
```

- [ ] **Step 5: Update handleCreateCall**

Replace the body-parsing and dial section of `handleCreateCall`:

```ts
  let body: { to?: unknown; silenceMs?: unknown; audio?: unknown };
  try {
    body = (await request.json()) as {
      to?: unknown;
      silenceMs?: unknown;
      audio?: unknown;
    };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const to = body.to;
  if (typeof to !== "string" || to.length === 0) {
    return json({ error: "`to` is required" }, 400);
  }

  const parsed = parseManifest(body.audio);
  if ("error" in parsed) {
    return json(
      { error: `${parsed.error.field} ${parsed.error.reason}` },
      400,
    );
  }

  const silenceMs = normaliseSilenceMs(body.silenceMs);
  const origin = new URL(request.url).origin;

  const webhookUrl = new URL(`${origin}/webhooks/telnyx`);
  webhookUrl.searchParams.set("silenceMs", String(silenceMs));

  let callControlId: string;
  try {
    callControlId = await createCall({
      to,
      from: env.TELNYX_FROM_NUMBER,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: webhookUrl.toString(),
      apiKey: env.TELNYX_API_KEY,
    });
  } catch (error) {
    const status = error instanceof TelnyxError ? error.status : 502;
    return json({ error: String(error) }, status >= 400 && status < 600 ? status : 502);
  }

  // Seeding can only happen after the dial, because the call_control_id does
  // not exist until then. A live call with no audio is worse than a dropped
  // one, so a seeding failure hangs up the call we just placed.
  const seeded = await sessionFor(env, callControlId).fetch(
    "https://session/init",
    { method: "POST", body: JSON.stringify(parsed.manifest) },
  );
  if (!seeded.ok) {
    console.log(
      JSON.stringify({ msg: "seed_failed", call_control_id: callControlId }),
    );
    await hangUp(env, callControlId);
    return json({ error: "failed to seed call session" }, 502);
  }

  return json({ call_control_id: callControlId, silenceMs });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS across all 7 test files.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/src/index.ts cf-worker/test/index.test.ts
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: accept a per-call audio manifest on POST /calls"
```

---

### Task 6: Documentation and live verification

**Files:**
- Modify: `cf-worker/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the working implementation from Tasks 1-5.
- Produces: accurate docs and a verified end-to-end call.

- [ ] **Step 1: Update the README's call-placing section**

In `cf-worker/README.md`, replace the "Placing a call" PowerShell and bash
examples so both carry an `audio` object, and add this note directly beneath the
heading:

```markdown
`audio` is required. `questions` holds 1 to 10 HTTPS URLs; `thanks` is a single
HTTPS URL. Telnyx fetches each one at the moment it plays, so pre-signed URLs
must stay valid for the whole call - sign for 60 minutes. The Worker rejects the
request without dialling if a SigV4 URL has too little life left.
```

Bash example:

```bash
curl -X POST https://<worker-host>/calls \
  -H "Authorization: Bearer $TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+37060000000",
        "audio": {
          "questions": ["https://bucket.s3.amazonaws.com/q1.mp3?X-Amz-...", "https://bucket.s3.amazonaws.com/q2.mp3?X-Amz-..."],
          "thanks": "https://bucket.s3.amazonaws.com/thanks.mp3?X-Amz-..."
        }
      }'
```

- [ ] **Step 2: Replace the README's Audio section**

```markdown
## Audio

Audio is supplied per call, not bundled. The caller of `POST /calls` passes
HTTPS URLs; nothing is served from this Worker. `public/audio/` still holds the
original silent placeholders but the flow no longer reads them.

Telnyx fetches each URL over public HTTPS at the moment it plays, so the URLs
must be reachable from the internet and must outlive the call.
```

- [ ] **Step 3: Update CLAUDE.md**

Three edits in `CLAUDE.md`:

In the Architecture handoff list, replace step 5 and add a step 0 so the seeding
is described:

```markdown
0. `POST /calls` validates the audio manifest, dials, then seeds the manifest
   into `CALL_SESSIONS.idFromName(ccid)` before the call is answered. The DO
   persists it, because ring time is long enough for an idle object to be
   evicted.
```

Replace the Configuration section's first paragraph with a note that audio is
per-call, and delete the claim that the Durable Object's state is in-memory only
from "Non-obvious constraints" — it now persists the manifest. Replace that
bullet with:

```markdown
- **The Durable Object persists only the audio manifest.** VAD state stays in
  memory; the manifest goes to storage because it is seeded before the call is
  answered and must survive ring-time eviction. `/end` wipes it on hangup.
```

Update the Testing section's test count after running `npm test`, and note that
`session.ts` gained storage and three routes while remaining untested.

- [ ] **Step 4: Verify the full suite and typecheck one more time**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck exits 0. Record the exact test count for the
CLAUDE.md edit in Step 3.

- [ ] **Step 5: Deploy**

Run: `npm run deploy`

- [ ] **Step 6: Live verification**

Ask the operator to place a real call. Do not trigger one without asking — it
dials a real phone and bills their Telnyx account.

Confirm in `npx wrangler tail`:

1. **`session_init` appears before `call.answered`**, and the `call_control_id`
   in the `webhook` log line matches the one `POST /calls` returned. This is the
   assumption the whole seeding design rests on; if the two ids differ, stop and
   report it — the transport design needs rework.
2. **Let the call ring for at least 20 seconds before answering.** Confirm the
   first question still plays, proving the manifest survived eviction.
3. `vad_armed` and `answer_ended` appear once per question.
4. The thank-you plays and `call.hangup` follows, then `session_end`.
5. Confirm a survey with a question count other than 3 works end to end.

- [ ] **Step 7: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx add cf-worker/README.md CLAUDE.md
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "docs: document the per-call audio manifest"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `audio` required on `POST /calls`, no fallback | 5 |
| 1 to 10 questions, variable per call | 1, 2, 3 |
| `https:` only, `http:` rejected | 2 |
| SigV4 expiry parsed without AWS credentials | 2 |
| Computed runway rather than a flat floor | 2 |
| 400 with no dial on invalid manifest | 5 |
| Seed the DO after the dial | 5 |
| DO persists the manifest, survives eviction | 4 |
| `blockConcurrencyWhile` reload on wake | 4 |
| `GET /manifest` 404 when unseeded | 4 |
| `handleArm` bounds check, 400 on null manifest | 4 |
| `/end` wipes storage on hangup | 4, 5 |
| Seeding failure hangs up and returns 502 | 5 |
| `call.answered` with no manifest hangs up | 5 |
| `decide()` returns `[]` rather than half-starting a call | 3 |
| `Command \| null` instead of widening types | 3 |
| `origin` dropped from the stream URL | 4, 5 |
| `Step` widened, `MAX_QUESTIONS` bound | 1 |
| `QUESTION_COUNT` deleted | 3 |
| Always-200 webhook preserved | 5 |
| `session.ts` untested, accepted risk | 4 |
| Live verification of the ccid assumption | 6 |

No gaps.

**Type consistency:** `AudioManifest` is defined once in `flow.ts` (Task 2) and
imported by `manifest.ts`, `session.ts`, and `index.ts`. `parseManifest` returns
`ManifestResult`, discriminated by `"error" in result`, used that way in Task 5.
`nextAfterAnswer(audio, step)` and `question(audio, step)` both return
`Command | null` in their definition (Task 3) and are null-checked at both call
sites (Tasks 3, 4). `MAX_QUESTIONS` is defined in `state.ts` (Task 1) and
imported by `manifest.ts` (Task 2) and its tests. `withCallId` drops its third
parameter in Task 5, its only call site. `step` is `number` in `session.ts`
(Task 4), matching the widened `Step`.

**Placeholder scan:** No TBD or TODO. Every code step contains complete,
runnable code. Task 6 Step 3 describes edits to prose rather than showing the
full file, which is appropriate for documentation but is the one place the
implementer must exercise judgement.

**Import graph:** `index.ts` -> `manifest.ts` -> `flow.ts` -> `state.ts`, with
`session.ts` -> `flow.ts`. Acyclic.
