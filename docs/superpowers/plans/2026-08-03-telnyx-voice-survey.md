# Telnyx Voice Survey Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that drives an outbound Telnyx call through three pre-recorded questions, captures spoken answers, plays a thank-you, and hangs up — while recording the whole call.

**Architecture:** One stateless Worker. Flow position is carried in Telnyx's `client_state` (base64, echoed back on every webhook), so there is no KV and no Durable Object. The call flow is a pure function `decide()` that maps an incoming webhook to a list of outgoing Telnyx commands; all I/O lives in thin modules around it. End-of-speech detection is delegated to Telnyx's `gather_using_ai` with the `greeting` omitted so it only listens.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Vitest, Telnyx Call Control v2 API.

## Global Constraints

- TypeScript strict mode. Do not widen types to make a build pass.
- No emojis in source or docs.
- Never run `git commit` — the operator manages all commits. Where a task says
  "Commit", stage the files and **report the suggested commit command to the
  operator** instead of running it.
- Secrets never appear in `wrangler.jsonc` or any committed file. They are set
  via `wrangler secret put`.
- Telnyx command endpoint is
  `POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/{action}`
  with header `Authorization: Bearer $TELNYX_API_KEY`.
- Telnyx webhook signature: Ed25519 over the exact string
  `` `${timestamp}|${rawBody}` ``. Signature header `telnyx-signature-ed25519`
  (base64), timestamp header `telnyx-timestamp` (Unix seconds).
- Use the standard Web Crypto algorithm name `Ed25519` — not the legacy
  `NODE-ED25519`.
- The webhook handler must return HTTP 200 for any event it does not act on.
  A non-2xx makes Telnyx retry, which would re-issue commands and
  double-advance the flow.
- All work happens in `C:\Users\kipra\Documents\Projects\rtc_telnyx`, inside the
  existing empty `cf-worker/` directory.

**Deviation from plan as written (agreed with operator at execution time):**
`wrangler` is pinned to `^4.0.0`, not `^3.90.0`. Top-level `assets` config,
which Task 1 relies on to serve `/audio/*`, is not stable until 3.91+/4.x.

---

### Task 1: Project scaffold

**Files:**
- Create: `cf-worker/package.json`
- Create: `cf-worker/tsconfig.json`
- Create: `cf-worker/wrangler.jsonc`
- Create: `cf-worker/vitest.config.ts`
- Create: `cf-worker/src/index.ts`
- Create: `cf-worker/test/smoke.test.ts`
- Create: `cf-worker/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` and `npx wrangler deploy`. All later tasks
  assume Vitest runs from `cf-worker/` and that `src/` is the source root.

- [ ] **Step 1: Create `cf-worker/package.json`**

```json
{
  "name": "rtc-telnyx-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260730.1",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `cf-worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `cf-worker/wrangler.jsonc`**

Static assets in `public/` are served automatically by the Workers runtime
before the Worker script runs, so `GET /audio/q1.mp3` resolves to
`public/audio/q1.mp3` with no code. There is no `AUDIO_BASE_URL` var — the
public origin is derived from the incoming webhook request URL at runtime.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "rtc-telnyx",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",
  "assets": {
    "directory": "./public"
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 4: Create `cf-worker/vitest.config.ts`**

`flow.ts`, `state.ts`, and `verify.ts` are pure and use only standard Web APIs
that Node 20+ provides, so plain Vitest is enough. No Workers pool needed.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create `cf-worker/.gitignore`**

```
node_modules/
.wrangler/
dist/
.dev.vars
```

- [ ] **Step 6: Create a placeholder `cf-worker/src/index.ts`**

```ts
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("ok");
  },
} satisfies ExportedHandler;
```

- [ ] **Step 7: Create `cf-worker/test/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("runs tests", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Install and verify**

Run from `cf-worker/`:

```bash
npm install && npm test && npm run typecheck
```

Expected: `npm test` reports 1 passing test; `typecheck` exits 0.

- [ ] **Step 9: Stage and report the commit**

Stage the files, then give the operator this command — do not run it:

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "chore: scaffold Telnyx voice survey worker"
```

---

### Task 2: Flow state encoding

**Files:**
- Create: `cf-worker/src/state.ts`
- Create: `cf-worker/test/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Step = 1 | 2 | 3 | "done"`
  - `interface FlowState { step: Step }`
  - `encodeState(state: FlowState): string` — base64 of the JSON
  - `decodeState(raw: string | null | undefined): FlowState | null` — returns
    `null` for absent, malformed, or out-of-range input. Never throws.

  Task 3 and Task 6 both import all four.

- [ ] **Step 1: Write the failing test**

Create `cf-worker/test/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeState, encodeState, type FlowState } from "../src/state";

describe("encodeState / decodeState", () => {
  it("round-trips every valid step", () => {
    const steps: FlowState["step"][] = [1, 2, 3, "done"];
    for (const step of steps) {
      expect(decodeState(encodeState({ step }))).toEqual({ step });
    }
  });

  it("produces base64 that is not plain JSON", () => {
    expect(encodeState({ step: 1 })).not.toContain("{");
  });

  it("returns null for absent input", () => {
    expect(decodeState(null)).toBeNull();
    expect(decodeState(undefined)).toBeNull();
    expect(decodeState("")).toBeNull();
  });

  it("returns null for non-base64 garbage without throwing", () => {
    expect(decodeState("!!!not base64!!!")).toBeNull();
  });

  it("returns null for base64 that is not JSON", () => {
    expect(decodeState(btoa("hello"))).toBeNull();
  });

  it("returns null for an out-of-range step", () => {
    expect(decodeState(btoa(JSON.stringify({ step: 9 })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: "nope" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({})))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — cannot resolve `../src/state`.

- [ ] **Step 3: Write the implementation**

Create `cf-worker/src/state.ts`:

```ts
export type Step = 1 | 2 | 3 | "done";

export interface FlowState {
  step: Step;
}

const VALID_STEPS: readonly unknown[] = [1, 2, 3, "done"];

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
  if (!VALID_STEPS.includes(step)) return null;

  return { step: step as Step };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add client_state encoding for call flow"
```

---

### Task 3: The call flow state machine

This is the core of the system. It is a pure function — no network, no
environment, no clock — so the entire call flow is testable without Telnyx.

**Files:**
- Create: `cf-worker/src/flow.ts`
- Create: `cf-worker/test/flow.test.ts`

**Interfaces:**
- Consumes: `decodeState`, `encodeState`, `FlowState`, `Step` from `src/state.ts`.
- Produces:
  - `interface Command { action: string; params: Record<string, unknown> }`
  - `interface FlowInput { eventType: string; clientState: string | null | undefined; originUrl: string }`
  - `decide(input: FlowInput): Command[]` — returns `[]` for anything it does
    not handle.
  - `const ANSWER_SCHEMA` — the JSON Schema passed to `gather_using_ai`.

  Task 6 imports `decide` and `Command`. Task 5 imports `Command`.

**Design notes for the implementer:**

- `decide` returns an **array** because `call.answered` issues two commands
  (`record_start` then `playback_start`), in that order.
- Every command carries a `client_state`, including `record_start`. Do not omit
  it — a command sent without one can clear the state Telnyx echoes back.
- `call.playback.ended` is fired both by question playbacks and by the
  thank-you playback. `step === "done"` is the only thing that distinguishes
  them. Get this wrong and the call either hangs up early or asks a fourth
  question.
- `gather_using_ai` deliberately omits `greeting`. Adding one would make Telnyx
  speak with a TTS voice, defeating the point of the recorded questions.

- [ ] **Step 1: Write the failing test**

Create `cf-worker/test/flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decide } from "../src/flow";
import { decodeState, encodeState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

function run(eventType: string, clientState: string | null = null) {
  return decide({ eventType, clientState, originUrl: ORIGIN });
}

describe("decide - call start", () => {
  it("starts recording and plays question 1 on call.answered", () => {
    const commands = run("call.answered");

    expect(commands).toHaveLength(2);
    expect(commands[0]!.action).toBe("record_start");
    expect(commands[0]!.params).toMatchObject({
      format: "mp3",
      channels: "dual",
    });
    expect(commands[1]!.action).toBe("playback_start");
    expect(commands[1]!.params.audio_url).toBe(`${ORIGIN}/audio/q1.mp3`);
    expect(decodeState(commands[1]!.params.client_state as string)).toEqual({
      step: 1,
    });
  });

  it("attaches client_state to record_start too", () => {
    const commands = run("call.answered");
    expect(commands[0]!.params.client_state).toBeTypeOf("string");
  });
});

describe("decide - listening for an answer", () => {
  it.each([1, 2, 3] as const)(
    "listens with gather_using_ai after question %i finishes playing",
    (step) => {
      const commands = run("call.playback.ended", encodeState({ step }));

      expect(commands).toHaveLength(1);
      expect(commands[0]!.action).toBe("gather_using_ai");
      expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
        step,
      });
    },
  );

  it("omits greeting so Telnyx plays no TTS over the recorded question", () => {
    const commands = run("call.playback.ended", encodeState({ step: 1 }));
    expect(commands[0]!.params).not.toHaveProperty("greeting");
  });

  it("supplies the parameters schema gather_using_ai requires", () => {
    const commands = run("call.playback.ended", encodeState({ step: 1 }));
    expect(commands[0]!.params.parameters).toMatchObject({ type: "object" });
  });
});

describe("decide - advancing between questions", () => {
  it.each([
    [1, 2],
    [2, 3],
  ] as const)("plays question %i+1 after answer %i", (from, to) => {
    const commands = run("call.ai_gather.ended", encodeState({ step: from }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("playback_start");
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/q${to}.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: to,
    });
  });

  it("plays the thank-you after the third answer", () => {
    const commands = run("call.ai_gather.ended", encodeState({ step: 3 }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("playback_start");
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/thanks.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: "done",
    });
  });
});

describe("decide - ending the call", () => {
  it("hangs up after the thank-you finishes, not asking a fourth question", () => {
    const commands = run("call.playback.ended", encodeState({ step: "done" }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("hangup");
  });
});

describe("decide - events that must not produce commands", () => {
  it.each([
    ["call.recording.saved", encodeState({ step: "done" })],
    ["call.hangup", encodeState({ step: "done" })],
    ["call.playback.started", encodeState({ step: 1 })],
    ["call.initiated", null],
    ["some.unknown.event", null],
  ])("returns no commands for %s", (eventType, clientState) => {
    expect(run(eventType, clientState)).toEqual([]);
  });

  it("returns no commands when client_state is missing on a stateful event", () => {
    expect(run("call.playback.ended", null)).toEqual([]);
    expect(run("call.ai_gather.ended", null)).toEqual([]);
  });

  it("returns no commands when client_state is malformed", () => {
    expect(run("call.playback.ended", "!!!garbage!!!")).toEqual([]);
  });
});

describe("decide - full happy path", () => {
  it("walks answered -> 3 rounds -> thanks -> hangup", () => {
    const seen: string[] = [];
    let state: string | null = null;

    const step = (eventType: string) => {
      const commands = decide({ eventType, clientState: state, originUrl: ORIGIN });
      for (const c of commands) seen.push(c.action);
      const last = commands[commands.length - 1];
      if (last) state = last.params.client_state as string;
    };

    step("call.answered");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");

    expect(seen).toEqual([
      "record_start",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "hangup",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow.test.ts`
Expected: FAIL — cannot resolve `../src/flow`.

- [ ] **Step 3: Write the implementation**

Create `cf-worker/src/flow.ts`:

```ts
import { decodeState, encodeState, type Step } from "./state";

export interface Command {
  action: string;
  params: Record<string, unknown>;
}

export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  originUrl: string;
}

export const QUESTION_COUNT = 3;

/**
 * gather_using_ai requires a `parameters` schema. Structured extraction is not
 * the goal here - the command is used for its managed end-of-speech detection -
 * but a single free-text field means the caller's answer arrives as text on
 * call.ai_gather.ended at no extra cost.
 */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "The caller's spoken answer to the question just played.",
    },
  },
  required: ["answer"],
} as const;

function audioUrl(origin: string, file: string): string {
  return `${origin}/audio/${file}`;
}

function questionCommand(origin: string, step: 1 | 2 | 3): Command {
  return {
    action: "playback_start",
    params: {
      audio_url: audioUrl(origin, `q${step}.mp3`),
      client_state: encodeState({ step }),
    },
  };
}

export function decide(input: FlowInput): Command[] {
  const { eventType, clientState, originUrl } = input;
  const state = decodeState(clientState);

  if (eventType === "call.answered") {
    return [
      {
        action: "record_start",
        params: {
          format: "mp3",
          channels: "dual",
          client_state: encodeState({ step: 1 }),
        },
      },
      questionCommand(originUrl, 1),
    ];
  }

  if (!state) return [];

  if (eventType === "call.playback.ended") {
    if (state.step === "done") {
      return [
        {
          action: "hangup",
          params: { client_state: encodeState({ step: "done" }) },
        },
      ];
    }
    return [
      {
        action: "gather_using_ai",
        params: {
          parameters: ANSWER_SCHEMA,
          client_state: encodeState({ step: state.step }),
        },
      },
    ];
  }

  if (eventType === "call.ai_gather.ended") {
    if (state.step === "done") return [];

    const next: Step = state.step < QUESTION_COUNT
      ? ((state.step + 1) as 1 | 2 | 3)
      : "done";

    if (next === "done") {
      return [
        {
          action: "playback_start",
          params: {
            audio_url: audioUrl(originUrl, "thanks.mp3"),
            client_state: encodeState({ step: "done" }),
          },
        },
      ];
    }

    return [questionCommand(originUrl, next)];
  }

  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/flow.test.ts`
Expected: PASS, all tests including the full happy path.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add pure call flow state machine"
```

---

### Task 4: Webhook signature verification

**Files:**
- Create: `cf-worker/src/verify.ts`
- Create: `cf-worker/test/verify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `verifyTelnyxSignature(args: VerifyArgs): Promise<boolean>` where
    `VerifyArgs = { rawBody: string; signature: string | null; timestamp: string | null; publicKeyB64: string; toleranceSeconds?: number; nowMs?: number }`

  Task 6 imports `verifyTelnyxSignature`.

**Design notes:** The signed string is exactly `` `${timestamp}|${rawBody}` ``.
`rawBody` must be the untouched request text — parsing and re-serializing the
JSON changes the bytes and breaks verification. `nowMs` is injectable purely so
the tests can control the clock.

- [ ] **Step 1: Write the failing test**

The test generates its own Ed25519 keypair, so there is no hardcoded fixture to
go stale. Node 20+ supports Ed25519 in `crypto.subtle`.

Create `cf-worker/test/verify.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { verifyTelnyxSignature } from "../src/verify";

let publicKeyB64: string;
let privateKey: CryptoKey;

function bytesToB64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function sign(timestamp: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${timestamp}|${body}`);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data);
  return bytesToB64(sig);
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyB64 = bytesToB64(await crypto.subtle.exportKey("raw", pair.publicKey));
});

describe("verifyTelnyxSignature", () => {
  const body = '{"data":{"event_type":"call.answered"}}';
  const nowMs = 1_700_000_000_000;
  const timestamp = String(nowMs / 1000);

  it("accepts a valid signature", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp, publicKeyB64, nowMs }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: '{"data":{"event_type":"call.hangup"}}',
        signature,
        timestamp,
        publicKeyB64,
        nowMs,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a missing signature or timestamp", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature: null, timestamp, publicKeyB64, nowMs }),
    ).resolves.toBe(false);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp: null, publicKeyB64, nowMs }),
    ).resolves.toBe(false);
  });

  it("rejects a replayed timestamp outside the tolerance", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature,
        timestamp,
        publicKeyB64,
        nowMs: nowMs + 6 * 60 * 1000,
      }),
    ).resolves.toBe(false);
  });

  it("accepts a timestamp inside the tolerance", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature,
        timestamp,
        publicKeyB64,
        nowMs: nowMs + 60 * 1000,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a non-numeric timestamp", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp: "abc", publicKeyB64, nowMs }),
    ).resolves.toBe(false);
  });

  it("rejects garbage signature bytes without throwing", async () => {
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature: "!!!not base64!!!",
        timestamp,
        publicKeyB64,
        nowMs,
      }),
    ).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/verify.test.ts`
Expected: FAIL — cannot resolve `../src/verify`.

- [ ] **Step 3: Write the implementation**

Create `cf-worker/src/verify.ts`:

```ts
export interface VerifyArgs {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKeyB64: string;
  toleranceSeconds?: number;
  nowMs?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function verifyTelnyxSignature(args: VerifyArgs): Promise<boolean> {
  const {
    rawBody,
    signature,
    timestamp,
    publicKeyB64,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    nowMs = Date.now(),
  } = args;

  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      b64ToBytes(signature),
      new TextEncoder().encode(`${timestamp}|${rawBody}`),
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/verify.test.ts`
Expected: PASS, 7 tests.

If Ed25519 is unsupported in the local Node version, the `generateKey` call
throws. Fix by upgrading to Node 20+ rather than switching to `NODE-ED25519`,
which is legacy and not what Workers should use.

- [ ] **Step 5: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add Ed25519 webhook signature verification"
```

---

### Task 5: Telnyx API client

**Files:**
- Create: `cf-worker/src/telnyx.ts`
- Create: `cf-worker/test/telnyx.test.ts`

**Interfaces:**
- Consumes: `Command` from `src/flow.ts`.
- Produces:
  - `sendCommand(callControlId: string, command: Command, apiKey: string): Promise<void>` — throws `TelnyxError` on non-2xx.
  - `createCall(args: CreateCallArgs): Promise<string>` — returns the
    `call_control_id`. `CreateCallArgs = { to: string; from: string; connectionId: string; webhookUrl: string; apiKey: string }`
  - `class TelnyxError extends Error { status: number }`

  Task 6 imports all three.

- [ ] **Step 1: Write the failing test**

Create `cf-worker/test/telnyx.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCall, sendCommand, TelnyxError } from "../src/telnyx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("sendCommand", () => {
  it("posts to the action endpoint with the bearer key", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await sendCommand(
      "call-abc",
      { action: "hangup", params: { client_state: "xyz" } },
      "KEY123",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/calls/call-abc/actions/hangup");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer KEY123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ client_state: "xyz" });
  });

  it("throws TelnyxError with the status on failure", async () => {
    stubFetch(new Response("bad request", { status: 422 }));

    await expect(
      sendCommand("call-abc", { action: "hangup", params: {} }, "KEY123"),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 422 });
  });

  it("url-encodes the call control id", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));
    await sendCommand("a/b c", { action: "hangup", params: {} }, "K");
    expect(spy.mock.calls[0]![0]).toContain("a%2Fb%20c");
  });
});

describe("createCall", () => {
  it("posts the dial request and returns the call_control_id", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ data: { call_control_id: "ccid-1" } }), {
        status: 200,
      }),
    );

    const id = await createCall({
      to: "+37060000000",
      from: "+15550000000",
      connectionId: "conn-1",
      webhookUrl: "https://w.example.dev/webhooks/telnyx",
      apiKey: "KEY123",
    });

    expect(id).toBe("ccid-1");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/calls");
    expect(JSON.parse(init.body)).toEqual({
      to: "+37060000000",
      from: "+15550000000",
      connection_id: "conn-1",
      webhook_url: "https://w.example.dev/webhooks/telnyx",
      webhook_url_method: "POST",
    });
  });

  it("throws TelnyxError when the dial is rejected", async () => {
    stubFetch(new Response("nope", { status: 401 }));

    await expect(
      createCall({
        to: "+1",
        from: "+2",
        connectionId: "c",
        webhookUrl: "https://w",
        apiKey: "K",
      }),
    ).rejects.toBeInstanceOf(TelnyxError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/telnyx.test.ts`
Expected: FAIL — cannot resolve `../src/telnyx`.

- [ ] **Step 3: Write the implementation**

Create `cf-worker/src/telnyx.ts`:

```ts
import type { Command } from "./flow";

const API_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TelnyxError";
    this.status = status;
  }
}

export interface CreateCallArgs {
  to: string;
  from: string;
  connectionId: string;
  webhookUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function sendCommand(
  callControlId: string,
  command: Command,
  apiKey: string,
): Promise<void> {
  const url = `${API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${command.action}`;

  const response = await fetch(url, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(command.params),
  });

  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `${command.action} failed: ${await response.text()}`,
    );
  }
}

export async function createCall(args: CreateCallArgs): Promise<string> {
  const response = await fetch(`${API_BASE}/calls`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify({
      to: args.to,
      from: args.from,
      connection_id: args.connectionId,
      webhook_url: args.webhookUrl,
      webhook_url_method: "POST",
    }),
  });

  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `create call failed: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    data?: { call_control_id?: string };
  };
  const id = body.data?.call_control_id;
  if (!id) throw new TelnyxError(response.status, "no call_control_id in response");
  return id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/telnyx.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add Telnyx API client"
```

---

### Task 6: Worker routing

**Files:**
- Modify: `cf-worker/src/index.ts` (replace the Task 1 placeholder entirely)
- Create: `cf-worker/test/index.test.ts`
- Delete: `cf-worker/test/smoke.test.ts`

**Interfaces:**
- Consumes: `decide`, `Command` from `src/flow.ts`; `verifyTelnyxSignature`
  from `src/verify.ts`; `createCall`, `sendCommand`, `TelnyxError` from
  `src/telnyx.ts`.
- Produces: the default `ExportedHandler` export and the `Env` interface.

**Env bindings (all secrets):** `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`,
`TELNYX_CONNECTION_ID`, `TELNYX_FROM_NUMBER`, `TRIGGER_SECRET`.

**Design notes:**

- Read the body once with `await request.text()` and pass that exact string to
  both the verifier and `JSON.parse`. Calling `request.json()` first and
  re-serializing will break signature verification.
- Commands are awaited before returning 200. Nothing goes in `ctx.waitUntil`.
- The bearer token on `POST /calls` is compared in constant time. A plain `!==`
  leaks length and prefix information via timing, and this endpoint is a
  billable dialer.
- The public origin for audio URLs comes from `new URL(request.url).origin` on
  the webhook request, so no extra configuration is needed.

- [ ] **Step 1: Write the failing test**

Create `cf-worker/test/index.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { encodeState } from "../src/state";

let publicKeyB64: string;
let privateKey: CryptoKey;

function bytesToB64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyB64 = bytesToB64(await crypto.subtle.exportKey("raw", pair.publicKey));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function env() {
  return {
    TELNYX_API_KEY: "KEY",
    TELNYX_PUBLIC_KEY: publicKeyB64,
    TELNYX_CONNECTION_ID: "conn-1",
    TELNYX_FROM_NUMBER: "+15550000000",
    TRIGGER_SECRET: "s3cret",
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

async function signedWebhook(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${timestamp}|${raw}`),
  );
  return new Request("https://w.example.dev/webhooks/telnyx", {
    method: "POST",
    body: raw,
    headers: {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": bytesToB64(sig),
    },
  });
}

describe("POST /webhooks/telnyx", () => {
  it("rejects an unsigned webhook with 401 and sends no commands", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const request = new Request("https://w.example.dev/webhooks/telnyx", {
      method: "POST",
      body: JSON.stringify({ data: { event_type: "call.answered" } }),
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("issues record_start and playback_start on a signed call.answered", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toContain("/actions/record_start");
    expect(spy.mock.calls[1]![0]).toContain("/actions/playback_start");
  });

  it("uses the request origin for the audio url", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    await worker.fetch(request, env(), ctx);

    const body = JSON.parse(spy.mock.calls[1]![1].body);
    expect(body.audio_url).toBe("https://w.example.dev/audio/q1.mp3");
  });

  it("returns 200 and sends nothing for an unhandled event", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.recording.saved",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done" }),
          recording_urls: { mp3: "https://rec.example/x.mp3" },
        },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still returns 200 when a Telnyx command fails", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
  });
});

describe("POST /calls", () => {
  it("rejects a missing or wrong bearer token", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const response = await worker.fetch(
        new Request("https://w.example.dev/calls", {
          method: "POST",
          headers,
          body: JSON.stringify({ to: "+37060000000" }),
        }),
        env(),
        ctx,
      );
      expect(response.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("dials via Telnyx and returns the call_control_id", async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { call_control_id: "ccid-9" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      new Request("https://w.example.dev/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37060000000" }),
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ call_control_id: "ccid-9" });

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toBe("https://w.example.dev/webhooks/telnyx");
    expect(sent.from).toBe("+15550000000");
  });

  it("rejects a body with no `to`", async () => {
    const response = await worker.fetch(
      new Request("https://w.example.dev/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({}),
      }),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const response = await worker.fetch(
      new Request("https://w.example.dev/nope"),
      env(),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Delete the scaffold smoke test**

```bash
rm cf-worker/test/smoke.test.ts
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — the placeholder handler returns "ok" for everything.

- [ ] **Step 4: Write the implementation**

Replace `cf-worker/src/index.ts` entirely:

```ts
import { decide } from "./flow";
import { createCall, sendCommand, TelnyxError } from "./telnyx";
import { verifyTelnyxSignature } from "./verify";

export interface Env {
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_CONNECTION_ID: string;
  TELNYX_FROM_NUMBER: string;
  TRIGGER_SECRET: string;
}

interface TelnyxWebhook {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      client_state?: string | null;
      [key: string]: unknown;
    };
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Length-safe constant-time comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const valid = await verifyTelnyxSignature({
    rawBody,
    signature: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
    publicKeyB64: env.TELNYX_PUBLIC_KEY,
  });
  if (!valid) return json({ error: "invalid signature" }, 401);

  let webhook: TelnyxWebhook;
  try {
    webhook = JSON.parse(rawBody) as TelnyxWebhook;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const eventType = webhook.data?.event_type;
  const callControlId = webhook.data?.payload?.call_control_id;
  if (!eventType || !callControlId) return json({ ok: true });

  console.log(
    JSON.stringify({
      msg: "webhook",
      event_type: eventType,
      call_control_id: callControlId,
      payload: webhook.data?.payload,
    }),
  );

  const commands = decide({
    eventType,
    clientState: webhook.data?.payload?.client_state,
    originUrl: new URL(request.url).origin,
  });

  for (const command of commands) {
    try {
      await sendCommand(callControlId, command, env.TELNYX_API_KEY);
    } catch (error) {
      const status = error instanceof TelnyxError ? error.status : 0;
      console.log(
        JSON.stringify({
          msg: "command_failed",
          action: command.action,
          status,
          error: String(error),
        }),
      );
      // Do not leave the callee on a silent open line.
      if (command.action !== "hangup") {
        try {
          await sendCommand(
            callControlId,
            { action: "hangup", params: {} },
            env.TELNYX_API_KEY,
          );
        } catch {
          // Nothing further we can do.
        }
      }
      break;
    }
  }

  // Always 200: a non-2xx makes Telnyx retry and double-advance the flow.
  return json({ ok: true });
}

async function handleCreateCall(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(token, env.TRIGGER_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { to?: unknown };
  try {
    body = (await request.json()) as { to?: unknown };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const to = body.to;
  if (typeof to !== "string" || to.length === 0) {
    return json({ error: "`to` is required" }, 400);
  }

  const origin = new URL(request.url).origin;

  try {
    const callControlId = await createCall({
      to,
      from: env.TELNYX_FROM_NUMBER,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: `${origin}/webhooks/telnyx`,
      apiKey: env.TELNYX_API_KEY,
    });
    return json({ call_control_id: callControlId });
  } catch (error) {
    const status = error instanceof TelnyxError ? error.status : 502;
    return json({ error: String(error) }, status >= 400 && status < 600 ? status : 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/webhooks/telnyx") {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && pathname === "/calls") {
      return handleCreateCall(request, env);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all tests across all four test files pass; typecheck exits 0.

- [ ] **Step 6: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: wire Telnyx webhook and call trigger routes"
```

---

### Task 7: Audio assets, deploy, and live verification

**Files:**
- Create: `cf-worker/public/audio/q1.mp3`
- Create: `cf-worker/public/audio/q2.mp3`
- Create: `cf-worker/public/audio/q3.mp3`
- Create: `cf-worker/public/audio/thanks.mp3`
- Create: `cf-worker/README.md`

**Interfaces:**
- Consumes: the deployed Worker from Task 6.
- Produces: a verified end-to-end call.

- [ ] **Step 1: Generate placeholder audio**

The operator records the real files later. Placeholders make the flow testable
now. Each is three seconds of silence, which is long enough to observe
`call.playback.ended` firing.

Requires ffmpeg. Run from `cf-worker/`:

```bash
mkdir -p public/audio && for f in q1 q2 q3 thanks; do ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 3 -q:a 9 -acodec libmp3lame "public/audio/$f.mp3" -y; done
```

If ffmpeg is unavailable, ask the operator to drop any four short mp3 files at
those paths instead. Do not skip this step — Telnyx returns an error if
`audio_url` 404s.

- [ ] **Step 2: Write `cf-worker/README.md`**

```markdown
# rtc-telnyx

Cloudflare Worker driving a three-question voice survey over a Telnyx number.

## Flow

Outbound call answered -> start dual-channel recording -> play `q1.mp3` ->
listen via `gather_using_ai` -> `q2.mp3` -> listen -> `q3.mp3` -> listen ->
`thanks.mp3` -> hangup.

Flow position lives in Telnyx's `client_state`, so the Worker is stateless.

## Setup

Set the secrets:

    npx wrangler secret put TELNYX_API_KEY
    npx wrangler secret put TELNYX_PUBLIC_KEY
    npx wrangler secret put TELNYX_CONNECTION_ID
    npx wrangler secret put TELNYX_FROM_NUMBER
    npx wrangler secret put TRIGGER_SECRET

`TELNYX_PUBLIC_KEY` is the base64 Ed25519 public key from the Telnyx portal.
`TELNYX_CONNECTION_ID` is the Voice API application id.
`TRIGGER_SECRET` is any long random string you choose.

Deploy:

    npm run deploy

In the Telnyx portal, set the Voice API application's webhook URL to
`https://<worker-host>/webhooks/telnyx`. The Worker also passes `webhook_url`
per call, but setting it in the portal keeps the two consistent.

## Placing a call

    curl -X POST https://<worker-host>/calls \
      -H "Authorization: Bearer $TRIGGER_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"to":"+37060000000"}'

## Audio

Replace the silent placeholders in `public/audio/` with real recordings.
Because audio ships as Worker assets, changing a recording requires a redeploy.

## Tests

    npm test
```

- [ ] **Step 3: Verify assets are served**

```bash
npx wrangler deploy
```

Then confirm the audio is publicly reachable — Telnyx must be able to GET it:

```bash
curl -sI https://<worker-host>/audio/q1.mp3
```

Expected: `HTTP/2 200` with an audio content-type.

- [ ] **Step 4: Set the secrets**

Run each of the five `wrangler secret put` commands from the README. Report to
the operator that these need real values from the Telnyx portal; do not invent
them.

- [ ] **Step 5: Live call verification**

Ask the operator to run the curl from the README against their own phone
number. Confirm by watching `npx wrangler tail`:

- `call.answered` arrives, followed by `record_start` and `playback_start`.
- Three `call.ai_gather.ended` events arrive, each logging an `answer`.
- The thank-you plays and `call.hangup` follows.
- `call.recording.saved` arrives; the logged `recording_urls.mp3` downloads and
  contains both sides of the conversation on separate channels.

This step requires the operator to place a real call. Do not attempt to trigger
it without asking.

- [ ] **Step 6: Stage and report the commit**

```bash
git -C C:/Users/kipra/Documents/Projects/rtc_telnyx commit -m "feat: add audio assets and deployment docs"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `POST /calls` CLI trigger, bearer-guarded | 6 |
| `POST /webhooks/telnyx`, Ed25519-verified | 4, 6 |
| `GET /audio/*` static assets | 1 (config), 7 (files) |
| Stateless via `client_state` | 2, 3 |
| `record_start` dual channel mp3 | 3 |
| Three questions as recorded audio | 3, 7 |
| `gather_using_ai` with greeting omitted | 3 |
| `step:"done"` discriminates thank-you playback | 3 |
| Thank-you then hangup | 3 |
| Pure `decide()` boundary | 3 |
| 200 on unhandled events | 3, 6 |
| Best-effort hangup on command failure | 6 |
| Replay tolerance on timestamps | 4 |
| Secrets only via `wrangler secret put` | 1, 7 |
| Answers and recording URL logged | 6 |

No gaps.

**Type consistency:** `Command` is defined in `flow.ts` and imported by
`telnyx.ts` and `index.ts`. `FlowState`/`Step` are defined in `state.ts` and
imported by `flow.ts`. `TelnyxError` is defined in `telnyx.ts` and imported by
`index.ts`. `decide` takes a single `FlowInput` object in both its definition
(Task 3) and its call site (Task 6). `verifyTelnyxSignature` takes a single
`VerifyArgs` object in both Task 4 and Task 6. Consistent.

**Placeholder scan:** No TBD/TODO. Every code step contains complete runnable
code. The only intentionally deferred artifacts are the four audio recordings,
which Task 7 Step 1 fills with real generated silent files rather than leaving
empty.
