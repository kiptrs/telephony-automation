# Console Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make campaigns place real calls - a shared caller-ID pool leased per call, a dispatcher that paces dialling against number availability, and a callback path that turns Telnyx events into recorded outcomes.

**Architecture:** The Cloudflare Worker gains two optional inputs (`from`, `callbackUrl`) and starts reporting three events back to the console over HMAC-signed HTTP. The console gains a `worker` process running a 2-second dispatcher loop that leases a number, presigns the campaign audio, and posts to the Worker's `/calls`. A `DialerProvider` seam lets local development run the whole loop against a fake that synthesises the callback sequence, because neither Telnyx nor a Cloudflare Worker can reach a laptop.

**Tech Stack:** As Plan 1, plus `@aws-sdk/s3-request-presigner` (already present) and the Workers `crypto.subtle` HMAC API.

**Spec:** `docs/superpowers/specs/2026-08-04-console-design.md`, "Plan 2 - Dispatch".

**Depends on:** `docs/superpowers/plans/2026-08-04-console-foundation.md` complete and its 134 tests green.

## Global Constraints

- Everything in Plan 1's Global Constraints still applies: Node **24.11.0**, TypeScript **strict** with `noUncheckedIndexedAccess`, **no ORM**, SQL only in `queries.ts` modules, every row parsed through zod, **no emojis**, **git is read-only** so tasks end in verification rather than a commit.
- Work in `cf-worker/` follows that package's own conventions, which differ: no zod, no `pg`, pure functions in their own modules with a matching `test/*.test.ts`.
- **The Telnyx webhook route must always return 200.** A non-2xx makes Telnyx retry, which re-issues commands and double-advances the flow. A console outage must never change that.
- **Verify Telnyx signatures against the raw body string.** Parsing and re-serialising changes the bytes and breaks Ed25519 verification.
- **Never place a real call without asking the operator.** It dials a real phone and bills their Telnyx account. Every task here is verifiable against `FakeDialer` instead; only Task 12 asks.
- The Worker's `MAX_QUESTIONS` is 10 and `client_state` encodes `{ step: 1..10 | "done" }`. The console must not invent a different vocabulary.

## File Structure

```
cf-worker/
  src/callback.ts              signing + notify. New.
  src/index.ts                 MODIFIED: from, callbackUrl, notify calls
  src/flow.ts                  MODIFIED: Env gains CONSOLE_HMAC_SECRET
  test/callback.test.ts        New.
  test/index.test.ts           MODIFIED: new cases

console/
  db/migrations/
    20260805*_phone_numbers.sql
    20260805*_calls.sql
  api/src/numbers/
    pool.ts                    acquire + release + sweep. The risky code.
    queries.ts  routes.ts
  api/src/calls/
    queries.ts                 call rows and their state transitions
    outcome.ts                 pure outcome derivation
    routes.ts                  retry, list
  api/src/callbacks/
    verify.ts                  pure HMAC verification
    routes.ts                  POST /callbacks/worker
  api/src/dispatch/
    dialer.ts                  DialerProvider, CfWorkerDialer, FakeDialer
    dispatcher.ts              the loop
  api/src/worker.ts            the worker process entrypoint
  web/src/routes/CampaignDetail.tsx
  web/src/routes/AdminNumbers.tsx
```

---

### Task 1: Worker callback signing

Pure functions first, in the style `cf-worker/src/verify.ts` already uses.

**Files:**
- Create: `cf-worker/src/callback.ts`
- Test: `cf-worker/test/callback.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `signCallback(secret: string, timestamp: string, rawBody: string): Promise<string>` - lower-case hex HMAC-SHA256 of `${timestamp}.${rawBody}`.
  - `CallbackEvent = { event: string; call_control_id: string; occurred_at: string; step: number | "done" | null; payload: Record<string, unknown> }`
  - `buildCallbackBody(event: CallbackEvent): string`
  - `notify(args: { url: string; secret: string; event: CallbackEvent }): Promise<void>` - never throws.

- [ ] **Step 1: Write the failing signing test**

`cf-worker/test/callback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCallbackBody, signCallback, type CallbackEvent } from "../src/callback";

const SECRET = "a-long-shared-secret-value";

const event: CallbackEvent = {
  event: "call.hangup",
  call_control_id: "ccid-1",
  occurred_at: "2026-08-05T10:00:00.000Z",
  step: 2,
  payload: { hangup_cause: "normal_clearing" },
};

describe("signCallback", () => {
  it("produces lower-case hex", async () => {
    const signature = await signCallback(SECRET, "1000", "{}");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same inputs", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1000", "{}");
    expect(a).toBe(b);
  });

  it("changes when the body changes", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1000", '{"a":1}');
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes, so a capture cannot be replayed later", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1001", "{}");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback("different", "1000", "{}");
    expect(a).not.toBe(b);
  });

  it("binds the timestamp to the body rather than concatenating loosely", async () => {
    // Without a separator, ("10", "00{}") and ("1000", "{}") would sign the
    // same bytes and a timestamp could be shifted without detection.
    const a = await signCallback(SECRET, "10", "00{}");
    const b = await signCallback(SECRET, "1000", "{}");
    expect(a).not.toBe(b);
  });
});

describe("buildCallbackBody", () => {
  it("round-trips through JSON", () => {
    expect(JSON.parse(buildCallbackBody(event))).toEqual(event);
  });

  it("orders keys deterministically so the signed bytes are reproducible", () => {
    expect(buildCallbackBody(event)).toBe(
      buildCallbackBody({ ...event, payload: { hangup_cause: "normal_clearing" } }),
    );
  });

  it("keeps a null step, which is what an unanswered call reports", () => {
    const body = buildCallbackBody({ ...event, step: null });
    expect(JSON.parse(body).step).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cf-worker && npx vitest run test/callback.test.ts`
Expected: FAIL - cannot resolve `../src/callback`.

- [ ] **Step 3: Implement callback.ts**

`cf-worker/src/callback.ts`:

```ts
export interface CallbackEvent {
  event: string;
  call_control_id: string;
  occurred_at: string;
  /** The flow step decoded from client_state, or null when there was none. */
  step: number | "done" | null;
  payload: Record<string, unknown>;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC-SHA256 over `${timestamp}.${rawBody}`. The dot is not decoration: it
 * binds the timestamp to the body so the two cannot be re-split, which would
 * let a captured request be replayed under a different timestamp.
 */
export async function signCallback(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return toHex(signature);
}

/** Fixed key order, because the receiver verifies the bytes we send. */
export function buildCallbackBody(event: CallbackEvent): string {
  return JSON.stringify({
    event: event.event,
    call_control_id: event.call_control_id,
    occurred_at: event.occurred_at,
    step: event.step,
    payload: event.payload,
  });
}

/**
 * Fire and forget. A console that is down, slow, or misconfigured must never
 * turn the Telnyx webhook response into a non-2xx, because Telnyx would retry
 * and the flow would advance twice.
 */
export async function notify(args: {
  url: string;
  secret: string;
  event: CallbackEvent;
}): Promise<void> {
  try {
    const body = buildCallbackBody(args.event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signCallback(args.secret, timestamp, body);

    const response = await fetch(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-console-timestamp": timestamp,
        "x-console-signature": `sha256=${signature}`,
      },
      body,
    });

    if (!response.ok) {
      console.log(
        JSON.stringify({
          msg: "callback_rejected",
          status: response.status,
          event: args.event.event,
          call_control_id: args.event.call_control_id,
        }),
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        msg: "callback_failed",
        event: args.event.event,
        call_control_id: args.event.call_control_id,
        error: String(error),
      }),
    );
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd cf-worker && npx vitest run test/callback.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run: `cd cf-worker && npm run typecheck`
Expected: no errors.

---

### Task 2: Worker accepts `from` and `callbackUrl`, and reports events

**Files:**
- Modify: `cf-worker/src/flow.ts` (Env gains `CONSOLE_HMAC_SECRET`)
- Modify: `cf-worker/src/index.ts`
- Modify: `cf-worker/test/index.test.ts`
- Modify: `cf-worker/README.md`

**Interfaces:**
- Consumes: `notify`, `CallbackEvent` from Task 1.
- Produces: the wire contract the console depends on in Tasks 7 and 8:
  - `POST /calls` body gains optional `from` (E.164) and `callbackUrl` (https).
  - Callbacks fire for `call.answered`, `call.hangup`, and `call.recording.saved`, carrying `step` decoded from `client_state`.

- [ ] **Step 1: Add the secret to Env**

In `cf-worker/src/flow.ts`, add to the `Env` interface:

```ts
  CONSOLE_HMAC_SECRET: string;
```

- [ ] **Step 2: Write the failing tests**

In `cf-worker/test/index.test.ts`, add `CONSOLE_HMAC_SECRET: "hmac-secret"` to the
object returned by `env()`, then replace the shared `ctx` with one that collects
its promises so callbacks can be awaited:

```ts
let pending: Promise<unknown>[] = [];

const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function settle(): Promise<void> {
  await Promise.all(pending);
  pending = [];
}
```

Add `pending = [];` to the top of `env()` so each test starts clean. Then append
these suites:

```ts
describe("POST /calls with from and callbackUrl", () => {
  it("dials from the supplied number instead of the env default", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      new Request("https://worker.example/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37060000001", from: "+37069999999", audio: AUDIO }),
      }),
      env(),
      ctx,
    );

    const body = JSON.parse(spy.mock.calls[0]![1].body) as { from: string };
    expect(body.from).toBe("+37069999999");
  });

  it("falls back to TELNYX_FROM_NUMBER when from is omitted", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      new Request("https://worker.example/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37060000001", audio: AUDIO }),
      }),
      env(),
      ctx,
    );

    const body = JSON.parse(spy.mock.calls[0]![1].body) as { from: string };
    expect(body.from).toBe("+15550000000");
  });

  it("rejects a from that is not E.164 rather than letting Telnyx fail", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37060000001", from: "060000001", audio: AUDIO }),
      }),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("puts the callback URL on the webhook query string", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      new Request("https://worker.example/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({
          to: "+37060000001",
          audio: AUDIO,
          callbackUrl: "https://console.example/callbacks/worker",
        }),
      }),
      env(),
      ctx,
    );

    const body = JSON.parse(spy.mock.calls[0]![1].body) as { webhook_url: string };
    const url = new URL(body.webhook_url);
    expect(url.searchParams.get("cb")).toBe(
      "https://console.example/callbacks/worker",
    );
    expect(url.searchParams.get("silenceMs")).toBe("2500");
  });

  it("rejects an http callback URL, which would leak the signature", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({
          to: "+37060000001",
          audio: AUDIO,
          callbackUrl: "http://console.example/callbacks/worker",
        }),
      }),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe("callbacks", () => {
  const CB = "https://console.example/callbacks/worker";

  async function deliverWebhook(
    eventType: string,
    payload: Record<string, unknown>,
    spy: ReturnType<typeof fetchSpy>,
  ) {
    const body = JSON.stringify({
      data: { event_type: eventType, payload: { call_control_id: "ccid-1", ...payload } },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = bytesToB64(
      (await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        new TextEncoder().encode(`${timestamp}|${body}`),
      )) as ArrayBuffer,
    );

    vi.stubGlobal("fetch", spy);
    const response = await worker.fetch(
      new Request(`https://worker.example/webhooks/telnyx?silenceMs=2500&cb=${encodeURIComponent(CB)}`, {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
        body,
      }),
      env(),
      ctx,
    );
    await settle();
    return response;
  }

  function callbackCalls(spy: ReturnType<typeof fetchSpy>) {
    return spy.mock.calls.filter(([url]) => String(url) === CB);
  }

  it("reports call.answered", async () => {
    const spy = fetchSpy();
    await deliverWebhook("call.answered", {}, spy);
    const calls = callbackCalls(spy);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]![1].body).event).toBe("call.answered");
  });

  it("reports call.hangup with the step from client_state", async () => {
    const spy = fetchSpy();
    await deliverWebhook(
      "call.hangup",
      { client_state: encodeState({ step: 2 }), hangup_cause: "normal_clearing" },
      spy,
    );
    const body = JSON.parse(callbackCalls(spy)[0]![1].body);
    expect(body.step).toBe(2);
    expect(body.payload.hangup_cause).toBe("normal_clearing");
  });

  it("reports step done when the thank-you finished, which means completed", async () => {
    const spy = fetchSpy();
    await deliverWebhook("call.hangup", { client_state: encodeState({ step: "done" }) }, spy);
    expect(JSON.parse(callbackCalls(spy)[0]![1].body).step).toBe("done");
  });

  it("reports a null step for a call that was never answered", async () => {
    const spy = fetchSpy();
    await deliverWebhook("call.hangup", { hangup_cause: "no_answer" }, spy);
    expect(JSON.parse(callbackCalls(spy)[0]![1].body).step).toBeNull();
  });

  it("reports call.recording.saved, which nothing handled before", async () => {
    const spy = fetchSpy();
    await deliverWebhook(
      "call.recording.saved",
      { recording_id: "rec-1", recording_urls: { mp3: "https://telnyx.example/r.mp3" } },
      spy,
    );
    const body = JSON.parse(callbackCalls(spy)[0]![1].body);
    expect(body.event).toBe("call.recording.saved");
    expect(body.payload.recording_id).toBe("rec-1");
  });

  it("signs the callback with a timestamp and a sha256 header", async () => {
    const spy = fetchSpy();
    await deliverWebhook("call.answered", {}, spy);
    const headers = callbackCalls(spy)[0]![1].headers as Record<string, string>;
    expect(headers["x-console-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-console-timestamp"]).toMatch(/^\d+$/);
  });

  it("sends no callback when the request carries no cb parameter", async () => {
    const spy = fetchSpy();
    const body = JSON.stringify({
      data: { event_type: "call.answered", payload: { call_control_id: "ccid-1" } },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = bytesToB64(
      (await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        new TextEncoder().encode(`${timestamp}|${body}`),
      )) as ArrayBuffer,
    );
    vi.stubGlobal("fetch", spy);
    await worker.fetch(
      new Request("https://worker.example/webhooks/telnyx?silenceMs=2500", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
        body,
      }),
      env(),
      ctx,
    );
    await settle();
    expect(callbackCalls(spy)).toHaveLength(0);
  });

  it("still returns 200 when the console rejects the callback", async () => {
    const spy = vi.fn(async (url: string) =>
      String(url) === CB
        ? new Response("nope", { status: 500 })
        : new Response("{}", { status: 200 }),
    ) as unknown as ReturnType<typeof fetchSpy>;
    const response = await deliverWebhook("call.answered", {}, spy);
    // A non-2xx here would make Telnyx retry and double-advance the flow.
    expect(response.status).toBe(200);
  });

  it("still returns 200 when the callback throws outright", async () => {
    const spy = vi.fn(async (url: string) => {
      if (String(url) === CB) throw new Error("network down");
      return new Response("{}", { status: 200 });
    }) as unknown as ReturnType<typeof fetchSpy>;
    const response = await deliverWebhook("call.answered", {}, spy);
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd cf-worker && npx vitest run test/index.test.ts`
Expected: FAIL - `from` is ignored, no `cb` parameter, no callbacks sent.

- [ ] **Step 4: Modify index.ts**

Add the import:

```ts
import { notify, type CallbackEvent } from "./callback";
```

Add these helpers above `handleWebhook`:

```ts
/** Telnyx will reject a bad number anyway; catching it here saves a billed dial. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

const CALLBACK_EVENTS = new Set([
  "call.answered",
  "call.hangup",
  "call.recording.saved",
]);
```

In `handleWebhook`, after `clientState` is read and before the commands loop,
add the callback dispatch:

```ts
  const callbackUrl = requestUrl.searchParams.get("cb");
  if (callbackUrl && CALLBACK_EVENTS.has(eventType)) {
    const state = decodeState(clientState);
    const event: CallbackEvent = {
      event: eventType,
      call_control_id: callControlId,
      occurred_at: new Date().toISOString(),
      step: state?.step ?? null,
      payload: webhook.data?.payload ?? {},
    };
    // waitUntil, not await: the console must never be able to delay or fail
    // this handler's 200.
    ctx.waitUntil(
      notify({ url: callbackUrl, secret: env.CONSOLE_HMAC_SECRET, event }),
    );
  }
```

`handleWebhook` therefore needs `ctx`. Change its signature to
`handleWebhook(request: Request, env: Env, ctx: ExecutionContext)` and update the
call site in `fetch` to pass `_ctx`, renaming that parameter to `ctx`.

In `handleCreateCall`, widen the body type and validate the two new fields:

```ts
  let body: {
    to?: unknown;
    from?: unknown;
    silenceMs?: unknown;
    audio?: unknown;
    callbackUrl?: unknown;
  };
```

After the existing `to` check:

```ts
  const from = body.from ?? env.TELNYX_FROM_NUMBER;
  if (typeof from !== "string" || !E164.test(from)) {
    return json({ error: "`from` must be an E.164 number" }, 400);
  }

  let callbackUrl: string | null = null;
  if (body.callbackUrl !== undefined) {
    if (typeof body.callbackUrl !== "string") {
      return json({ error: "`callbackUrl` must be a string" }, 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(body.callbackUrl);
    } catch {
      return json({ error: "`callbackUrl` is not a valid URL" }, 400);
    }
    // A signed callback sent in clear text leaks its own signature.
    if (parsed.protocol !== "https:") {
      return json({ error: "`callbackUrl` must use https" }, 400);
    }
    callbackUrl = parsed.toString();
  }
```

Attach it to the webhook URL beside `silenceMs`, then dial with `from`:

```ts
  webhookUrl.searchParams.set("silenceMs", String(silenceMs));
  if (callbackUrl) webhookUrl.searchParams.set("cb", callbackUrl);
```

```ts
    callControlId = await createCall({
      to,
      from,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: webhookUrl.toString(),
      apiKey: env.TELNYX_API_KEY,
    });
```

- [ ] **Step 5: Run the whole worker suite**

Run: `cd cf-worker && npm test`
Expected: PASS. The existing 117 tests still pass, plus 9 from Task 1 and 14
added here - 140 total.

- [ ] **Step 6: Typecheck**

Run: `cd cf-worker && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Document the new inputs**

In `cf-worker/README.md`, under "Placing a call", add:

```markdown
### from and callbackUrl

`from` is optional and overrides `TELNYX_FROM_NUMBER` for one call, which is how
a caller-ID pool is driven from outside. It must be E.164.

`callbackUrl` is optional and must be https. When present, the Worker POSTs
`call.answered`, `call.hangup`, and `call.recording.saved` to it, signed with
`CONSOLE_HMAC_SECRET`:

    x-console-timestamp: <unix seconds>
    x-console-signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`>

    { "event": "call.hangup", "call_control_id": "...",
      "occurred_at": "...", "step": 2, "payload": { ... } }

`step` is decoded from `client_state`: a number means the caller was on that
question, `"done"` means the thank-you had played, and `null` means the call was
never answered. Delivery is fire and forget through `ctx.waitUntil` - a console
that is down can never stop this Worker returning 200 to Telnyx.
```

Add `CONSOLE_HMAC_SECRET` to the secrets list in the Setup section:

```
    npx wrangler secret put CONSOLE_HMAC_SECRET
```

- [ ] **Step 8: Deploy the Worker**

Run: `cd cf-worker && npx wrangler secret put CONSOLE_HMAC_SECRET` then
`npm run deploy`.

Both changes are backward compatible - omitting `from` and `callbackUrl`
behaves exactly as before, so deploying now cannot break anything.

---

### Task 3: Number pool and call schema

**Files:**
- Create: `console/db/migrations/20260805090000_phone_numbers.sql`
- Create: `console/db/migrations/20260805090100_calls.sql`

**Interfaces:**
- Consumes: `tenants`, `campaigns`, `contacts` from Plan 1.
- Produces: tables `phone_numbers`, `number_leases`, `calls`.

- [ ] **Step 1: Create the pool tables**

`console/db/migrations/20260805090000_phone_numbers.sql`:

```sql
-- migrate:up
CREATE TABLE phone_numbers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164              text NOT NULL UNIQUE,
  telnyx_number_id  text,
  -- NULL means the number is in the shared pool. Set it to dedicate the number
  -- to one tenant; the allocator already honours it.
  tenant_id         uuid REFERENCES tenants (id) ON DELETE SET NULL,
  max_concurrent    integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'active',
  last_used_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_numbers_status_valid
    CHECK (status IN ('active', 'paused', 'released')),
  CONSTRAINT phone_numbers_max_concurrent_valid CHECK (max_concurrent >= 1),
  CONSTRAINT phone_numbers_e164_format CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$')
);

CREATE INDEX phone_numbers_available_idx
  ON phone_numbers (last_used_at NULLS FIRST) WHERE status = 'active';

CREATE TABLE number_leases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_id  uuid NOT NULL REFERENCES phone_numbers (id) ON DELETE CASCADE,
  -- Set once the call row exists. The lease is taken first, in the same
  -- transaction, so this is filled in immediately after.
  call_id          uuid,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  released_at      timestamptz
);

-- The allocator counts unreleased, unexpired leases per number, so this index
-- is what keeps that count cheap.
CREATE INDEX number_leases_active_idx
  ON number_leases (phone_number_id) WHERE released_at IS NULL;

CREATE INDEX number_leases_call_id_idx ON number_leases (call_id);

-- migrate:down
DROP TABLE number_leases;
DROP TABLE phone_numbers;
```

- [ ] **Step 2: Create the calls table**

`console/db/migrations/20260805090100_calls.sql`:

```sql
-- migrate:up
CREATE TABLE calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  phone_number_id          uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  attempt                  integer NOT NULL DEFAULT 1,
  telnyx_call_control_id   text UNIQUE,
  status                   text NOT NULL DEFAULT 'queued',
  outcome                  text,
  -- The flow step the caller reached, copied from the Worker's client_state.
  -- 0 encodes "done"; a positive number is the question they were on.
  last_step                integer,
  hangup_cause             text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  dialed_at                timestamptz,
  answered_at              timestamptz,
  ended_at                 timestamptz,
  CONSTRAINT calls_status_valid
    CHECK (status IN ('queued', 'dialing', 'in_progress', 'ended', 'failed')),
  CONSTRAINT calls_outcome_valid
    CHECK (outcome IS NULL OR outcome IN
      ('completed', 'abandoned', 'no_answer', 'busy', 'failed', 'unknown'))
);

CREATE INDEX calls_campaign_idx ON calls (campaign_id, created_at DESC);
CREATE INDEX calls_contact_idx ON calls (contact_id);

-- Finding the call a callback belongs to is the hottest lookup in the system.
CREATE INDEX calls_ccid_idx ON calls (telnyx_call_control_id)
  WHERE telnyx_call_control_id IS NOT NULL;

ALTER TABLE number_leases
  ADD CONSTRAINT number_leases_call_id_fkey
  FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE number_leases DROP CONSTRAINT number_leases_call_id_fkey;
DROP TABLE calls;
```

`last_step` is an integer with 0 meaning `"done"` rather than a text column,
because the Worker's own vocabulary is `1..10 | "done"` and encoding it once at
the boundary beats a nullable text column every query has to interpret.

- [ ] **Step 3: Run the migrations**

Run: `cd console && npm run migrate`
Expected: both applied with no errors.

- [ ] **Step 4: Verify rollback**

Run: `docker compose -f docker-compose.dev.yml run --rm dbmate down` twice, then
`npm run migrate` to restore.
Expected: clean down and up. The `number_leases` foreign key is added and
dropped in the `calls` migration precisely so the two roll back in order.

---

### Task 4: The number pool

This is the highest-risk function in the codebase. Two dispatcher ticks racing
for one number must not both win, and the test that proves it is the reason this
task exists.

**Files:**
- Create: `console/api/src/numbers/queries.ts`
- Create: `console/api/src/numbers/pool.ts`
- Test: `console/api/test/number-pool.test.ts`

**Interfaces:**
- Consumes: `withTransaction`, `parseRows`, `parseOne` from Plan 1 Task 3.
- Produces:
  - `PhoneNumber = { id: string; e164: string; tenantId: string | null; maxConcurrent: number; status: "active" | "paused" | "released"; activeLeases: number }`
  - `acquireNumber(pool, tenantId): Promise<{ leaseId: string; phoneNumberId: string; e164: string } | null>`
  - `attachLeaseToCall(client, leaseId, callId): Promise<void>`
  - `releaseLeaseForCall(pool, callId): Promise<void>`
  - `sweepExpiredLeases(pool): Promise<string[]>` - returns the call ids whose leases expired.
  - `LEASE_MINUTES = 8`
  - `listNumbers`, `insertNumber`, `updateNumber` in `numbers/queries.ts`.

- [ ] **Step 1: Write the failing pool test**

`console/api/test/number-pool.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import {
  acquireNumber,
  releaseLeaseForCall,
  sweepExpiredLeases,
} from "../src/numbers/pool.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let tenantId: string;
let otherTenantId: string;

beforeAll(() => {
  pool = createPool(testConfig());
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  tenantId = (await seedTenant(pool, "acme")).tenantId;
  otherTenantId = (await seedTenant(pool, "globex")).tenantId;
});

async function addNumber(
  e164: string,
  options: { tenantId?: string | null; maxConcurrent?: number; status?: string } = {},
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO phone_numbers (e164, tenant_id, max_concurrent, status)
          VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      e164,
      options.tenantId ?? null,
      options.maxConcurrent ?? 1,
      options.status ?? "active",
    ],
  );
  return result.rows[0].id as string;
}

describe("acquireNumber", () => {
  it("leases a free shared number", async () => {
    await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    expect(lease?.e164).toBe("+37069000001");
  });

  it("returns null when the pool is empty", async () => {
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("returns null when the only number is already leased", async () => {
    await addNumber("+37069000001");
    await acquireNumber(pool, tenantId);
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("skips a paused number", async () => {
    await addNumber("+37069000001", { status: "paused" });
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("will not lend another tenant's dedicated number", async () => {
    await addNumber("+37069000001", { tenantId: otherTenantId });
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("uses a number dedicated to the asking tenant", async () => {
    await addNumber("+37069000001", { tenantId });
    expect((await acquireNumber(pool, tenantId))?.e164).toBe("+37069000001");
  });

  it("honours max_concurrent above 1", async () => {
    await addNumber("+37069000001", { maxConcurrent: 2 });
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
    expect(await acquireNumber(pool, tenantId)).toBeNull();
  });

  it("prefers the least recently used number, spreading load across the pool", async () => {
    await addNumber("+37069000001");
    await addNumber("+37069000002");

    const first = await acquireNumber(pool, tenantId);
    await releaseLeaseForCallless(pool, first!.leaseId);
    const second = await acquireNumber(pool, tenantId);

    expect(second?.e164).not.toBe(first?.e164);
  });

  it("ignores an expired lease, so a lost callback cannot strand the pool", async () => {
    await addNumber("+37069000001");
    const first = await acquireNumber(pool, tenantId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [first!.leaseId],
    );
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  // The reason this file exists.
  it("hands one number to exactly one of twenty simultaneous callers", async () => {
    await addNumber("+37069000001");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireNumber(pool, tenantId)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });

  it("hands three numbers to exactly three of twenty simultaneous callers", async () => {
    await addNumber("+37069000001");
    await addNumber("+37069000002");
    await addNumber("+37069000003");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireNumber(pool, tenantId)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(3);
  });
});

describe("releaseLeaseForCall", () => {
  it("frees the number for the next caller", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    const callId = await makeCall(pool, numberId, lease!.leaseId);

    await releaseLeaseForCall(pool, callId);
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  it("is a no-op for a call that holds no lease", async () => {
    const numberId = await addNumber("+37069000001");
    const callId = await makeCall(pool, numberId, null);
    await expect(releaseLeaseForCall(pool, callId)).resolves.toBeUndefined();
  });
});

describe("sweepExpiredLeases", () => {
  it("releases an expired lease and reports its call", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    const callId = await makeCall(pool, numberId, lease!.leaseId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [lease!.leaseId],
    );

    expect(await sweepExpiredLeases(pool)).toEqual([callId]);
    expect(await acquireNumber(pool, tenantId)).not.toBeNull();
  });

  it("leaves a live lease alone", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    await makeCall(pool, numberId, lease!.leaseId);
    expect(await sweepExpiredLeases(pool)).toEqual([]);
  });

  it("is idempotent", async () => {
    const numberId = await addNumber("+37069000001");
    const lease = await acquireNumber(pool, tenantId);
    await makeCall(pool, numberId, lease!.leaseId);
    await pool.query(
      "UPDATE number_leases SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [lease!.leaseId],
    );
    await sweepExpiredLeases(pool);
    expect(await sweepExpiredLeases(pool)).toEqual([]);
  });
});

/** Creates a campaign, contact, and call so a lease has something to point at. */
async function makeCall(
  db: Pool,
  phoneNumberId: string,
  leaseId: string | null,
): Promise<string> {
  const campaign = await db.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  const contact = await db.query(
    `INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')
       RETURNING id`,
    [campaign.rows[0].id],
  );
  const call = await db.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id)
          VALUES ($1, $2, $3) RETURNING id`,
    [campaign.rows[0].id, contact.rows[0].id, phoneNumberId],
  );
  const callId = call.rows[0].id as string;
  if (leaseId) {
    await db.query("UPDATE number_leases SET call_id = $2 WHERE id = $1", [
      leaseId,
      callId,
    ]);
  }
  return callId;
}

/** Releases by lease id, for the cases that never create a call row. */
async function releaseLeaseForCallless(db: Pool, leaseId: string): Promise<void> {
  await db.query(
    "UPDATE number_leases SET released_at = now() WHERE id = $1",
    [leaseId],
  );
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- number-pool`
Expected: FAIL - cannot resolve `../src/numbers/pool.js`.

- [ ] **Step 3: Implement the pool**

`console/api/src/numbers/pool.ts`:

```ts
import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import { parseRows } from "../db/rows.js";

/**
 * Longer than any possible call - 60s of ring plus ten questions at 40s each
 * is under seven minutes - so a live call can never have its number stolen.
 */
export const LEASE_MINUTES = 8;

export interface AcquiredLease {
  leaseId: string;
  phoneNumberId: string;
  e164: string;
}

const candidateRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  max_concurrent: z.number().int(),
  active_leases: z.number().int(),
});

/**
 * Leases a number for one call, or returns null when none is free.
 *
 * The candidate rows are locked with FOR UPDATE SKIP LOCKED before their lease
 * counts are trusted, which is what makes two concurrent ticks unable to both
 * take the same number. It locks every lockable row rather than just one,
 * because filtering on an aggregate in the WHERE clause is not re-evaluated
 * after the lock is taken under READ COMMITTED.
 *
 * That makes this O(pool size). It is correct and obviously so for a pool in
 * the tens. If the pool ever reaches the low hundreds, replace it with a
 * denormalised active_leases counter column on phone_numbers updated in the
 * same transaction - a change confined to this file.
 */
export async function acquireNumber(
  pool: Pool,
  tenantId: string,
): Promise<AcquiredLease | null> {
  return withTransaction(pool, async (client) => {
    const candidates = await client.query(
      `SELECT pn.id, pn.e164, pn.max_concurrent,
              (SELECT count(*)::int
                 FROM number_leases nl
                WHERE nl.phone_number_id = pn.id
                  AND nl.released_at IS NULL
                  AND nl.expires_at > now()) AS active_leases
         FROM phone_numbers pn
        WHERE pn.status = 'active'
          AND (pn.tenant_id IS NULL OR pn.tenant_id = $1)
        ORDER BY pn.last_used_at NULLS FIRST, pn.id
          FOR UPDATE OF pn SKIP LOCKED`,
      [tenantId],
    );

    const chosen = parseRows(candidateRow, candidates).find(
      (row) => row.active_leases < row.max_concurrent,
    );
    if (!chosen) return null;

    const lease = await client.query(
      `INSERT INTO number_leases (phone_number_id, expires_at)
            VALUES ($1, now() + make_interval(mins => $2))
         RETURNING id`,
      [chosen.id, LEASE_MINUTES],
    );

    await client.query(
      `UPDATE phone_numbers SET last_used_at = now() WHERE id = $1`,
      [chosen.id],
    );

    return {
      leaseId: lease.rows[0].id as string,
      phoneNumberId: chosen.id,
      e164: chosen.e164,
    };
  });
}

/** Called inside the dispatcher's transaction once the call row exists. */
export async function attachLeaseToCall(
  client: PoolClient,
  leaseId: string,
  callId: string,
): Promise<void> {
  await client.query(`UPDATE number_leases SET call_id = $2 WHERE id = $1`, [
    leaseId,
    callId,
  ]);
}

export async function releaseLeaseForCall(
  pool: Pool,
  callId: string,
): Promise<void> {
  await pool.query(
    `UPDATE number_leases SET released_at = now()
      WHERE call_id = $1 AND released_at IS NULL`,
    [callId],
  );
}

export async function releaseLease(pool: Pool, leaseId: string): Promise<void> {
  await pool.query(
    `UPDATE number_leases SET released_at = now()
      WHERE id = $1 AND released_at IS NULL`,
    [leaseId],
  );
}

/**
 * Frees leases whose call never reported a hangup. Returns the call ids so the
 * dispatcher can mark them ended with an unknown outcome.
 */
export async function sweepExpiredLeases(pool: Pool): Promise<string[]> {
  const result = await pool.query(
    `UPDATE number_leases
        SET released_at = now()
      WHERE released_at IS NULL AND expires_at < now()
      RETURNING call_id`,
    [],
  );
  return parseRows(z.object({ call_id: z.string().uuid().nullable() }), result)
    .map((row) => row.call_id)
    .filter((id): id is string => id !== null);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- number-pool`
Expected: PASS, 16 tests. The two concurrency cases are the ones that matter;
if either is flaky, the locking is wrong and must not be papered over with a
retry.

- [ ] **Step 5: Implement the admin queries**

`console/api/src/numbers/queries.ts`:

```ts
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const numberRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  telnyx_number_id: z.string().nullable(),
  tenant_id: z.string().uuid().nullable(),
  tenant_slug: z.string().nullable(),
  max_concurrent: z.number().int(),
  status: z.enum(["active", "paused", "released"]),
  active_leases: z.number().int(),
  last_used_at: z.date().nullable(),
});

export interface PhoneNumber {
  id: string;
  e164: string;
  telnyxNumberId: string | null;
  tenantId: string | null;
  tenantSlug: string | null;
  maxConcurrent: number;
  status: "active" | "paused" | "released";
  activeLeases: number;
  lastUsedAt: string | null;
}

function toNumber(row: z.infer<typeof numberRow>): PhoneNumber {
  return {
    id: row.id,
    e164: row.e164,
    telnyxNumberId: row.telnyx_number_id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    maxConcurrent: row.max_concurrent,
    status: row.status,
    activeLeases: row.active_leases,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

const SELECT_NUMBER = `
  SELECT pn.id, pn.e164, pn.telnyx_number_id, pn.tenant_id, t.slug AS tenant_slug,
         pn.max_concurrent, pn.status, pn.last_used_at,
         (SELECT count(*)::int FROM number_leases nl
           WHERE nl.phone_number_id = pn.id
             AND nl.released_at IS NULL AND nl.expires_at > now()) AS active_leases
    FROM phone_numbers pn
    LEFT JOIN tenants t ON t.id = pn.tenant_id
`;

export async function listNumbers(pool: Pool): Promise<PhoneNumber[]> {
  const result = await pool.query(`${SELECT_NUMBER} ORDER BY pn.e164`);
  return parseRows(numberRow, result).map(toNumber);
}

export async function insertNumber(
  pool: Pool,
  args: {
    e164: string;
    telnyxNumberId: string | null;
    tenantId: string | null;
    maxConcurrent: number;
  },
): Promise<PhoneNumber> {
  const inserted = await pool.query(
    `INSERT INTO phone_numbers (e164, telnyx_number_id, tenant_id, max_concurrent)
          VALUES ($1, $2, $3, $4) RETURNING id`,
    [args.e164, args.telnyxNumberId, args.tenantId, args.maxConcurrent],
  );
  const { id } = parseExactlyOne(z.object({ id: z.string().uuid() }), inserted);
  const found = await findNumber(pool, id);
  if (!found) throw new Error("number vanished after insert");
  return found;
}

export async function findNumber(
  pool: Pool,
  id: string,
): Promise<PhoneNumber | null> {
  const result = await pool.query(`${SELECT_NUMBER} WHERE pn.id = $1`, [id]);
  const row = parseOne(numberRow, result);
  return row === null ? null : toNumber(row);
}

export async function updateNumber(
  pool: Pool,
  id: string,
  args: {
    status?: "active" | "paused" | "released";
    tenantId?: string | null;
    maxConcurrent?: number;
  },
): Promise<PhoneNumber | null> {
  const result = await pool.query(
    `UPDATE phone_numbers
        SET status = COALESCE($2, status),
            max_concurrent = COALESCE($3, max_concurrent),
            tenant_id = CASE WHEN $4 THEN $5 ELSE tenant_id END
      WHERE id = $1
      RETURNING id`,
    [
      id,
      args.status ?? null,
      args.maxConcurrent ?? null,
      // A separate flag, because null is a meaningful value here: it moves the
      // number back into the shared pool.
      Object.prototype.hasOwnProperty.call(args, "tenantId"),
      args.tenantId ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return findNumber(pool, id);
}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 5: Call state and outcome derivation

Outcome derivation is pure, so every combination is testable without a call.

**Files:**
- Create: `console/packages/shared/src/call.ts`
- Modify: `console/packages/shared/src/index.ts`
- Create: `console/api/src/calls/outcome.ts`
- Create: `console/api/src/calls/queries.ts`
- Test: `console/api/test/call-outcome.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `deriveOutcome(input: { step: number | "done" | null; answered: boolean; hangupCause: string | null }): CallOutcome`
  - `encodeStep(step: number | "done" | null): number | null` and `decodeStep(value: number | null): number | "done" | null`
  - `CallOutcome = "completed" | "abandoned" | "no_answer" | "busy" | "failed" | "unknown"`
  - `insertQueuedCall`, `markDialing`, `markAnswered`, `markEnded`, `markFailed`, `findCallByCcid`, `listCallsForCampaign`, `nextAttemptNumber` in `calls/queries.ts`.

- [ ] **Step 1: Add the shared call schemas**

`console/packages/shared/src/call.ts`:

```ts
import { z } from "zod";

export const callStatusSchema = z.enum([
  "queued",
  "dialing",
  "in_progress",
  "ended",
  "failed",
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

export const callOutcomeSchema = z.enum([
  "completed",
  "abandoned",
  "no_answer",
  "busy",
  "failed",
  "unknown",
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

export const callSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  e164: z.string(),
  externalRef: z.string().nullable(),
  fromE164: z.string().nullable(),
  attempt: z.number().int(),
  status: callStatusSchema,
  outcome: callOutcomeSchema.nullable(),
  lastStep: z.union([z.number().int(), z.literal("done")]).nullable(),
  hangupCause: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Call = z.infer<typeof callSchema>;

export const campaignProgressSchema = z.object({
  pending: z.number().int(),
  dialing: z.number().int(),
  done: z.number().int(),
  total: z.number().int(),
});
export type CampaignProgress = z.infer<typeof campaignProgressSchema>;
```

Add to `console/packages/shared/src/index.ts`:

```ts
export * from "./call.js";
```

- [ ] **Step 2: Write the failing outcome test**

`console/api/test/call-outcome.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeStep, deriveOutcome, encodeStep } from "../src/calls/outcome.js";

describe("deriveOutcome", () => {
  it("calls a finished thank-you a completed survey", () => {
    expect(
      deriveOutcome({ step: "done", answered: true, hangupCause: "normal_clearing" }),
    ).toBe("completed");
  });

  it("calls a hangup mid-survey abandoned", () => {
    expect(
      deriveOutcome({ step: 2, answered: true, hangupCause: "normal_clearing" }),
    ).toBe("abandoned");
  });

  it("calls an answered call with no step abandoned, not completed", () => {
    // Answered but nothing played is still the caller leaving early.
    expect(
      deriveOutcome({ step: null, answered: true, hangupCause: "normal_clearing" }),
    ).toBe("abandoned");
  });

  it("reads user_busy as busy", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "user_busy" }),
    ).toBe("busy");
  });

  it("reads an unanswered call as no_answer", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "no_answer" }),
    ).toBe("no_answer");
  });

  it("reads a timeout as no_answer", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "timeout" }),
    ).toBe("no_answer");
  });

  it("reads an unanswered call with no cause at all as no_answer", () => {
    expect(deriveOutcome({ step: null, answered: false, hangupCause: null })).toBe(
      "no_answer",
    );
  });

  it("reads call_rejected as busy, because the callee actively declined", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "call_rejected" }),
    ).toBe("busy");
  });

  it("trusts the step over the answered flag when they disagree", () => {
    // A step can only exist if audio played, which can only happen after answer.
    expect(
      deriveOutcome({ step: "done", answered: false, hangupCause: null }),
    ).toBe("completed");
  });
});

describe("step encoding", () => {
  it("stores done as 0, because the column is an integer", () => {
    expect(encodeStep("done")).toBe(0);
  });

  it("stores a question number as itself", () => {
    expect(encodeStep(3)).toBe(3);
  });

  it("stores no step as null", () => {
    expect(encodeStep(null)).toBeNull();
  });

  it("round-trips done", () => {
    expect(decodeStep(encodeStep("done"))).toBe("done");
  });

  it("round-trips a question number", () => {
    expect(decodeStep(encodeStep(7))).toBe(7);
  });

  it("round-trips null", () => {
    expect(decodeStep(encodeStep(null))).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- call-outcome`
Expected: FAIL - cannot resolve `../src/calls/outcome.js`.

- [ ] **Step 4: Implement outcome.ts**

`console/api/src/calls/outcome.ts`:

```ts
import type { CallOutcome } from "@console/shared";

/** Telnyx causes that mean the callee actively refused rather than missed it. */
const REJECTED_CAUSES = new Set(["user_busy", "call_rejected", "busy"]);

/**
 * The Worker's step is the authority. It only exists if audio actually played,
 * which can only happen after the call was answered - so a step present with
 * answered false means the answered webhook was lost, not that the call failed.
 */
export function deriveOutcome(input: {
  step: number | "done" | null;
  answered: boolean;
  hangupCause: string | null;
}): CallOutcome {
  if (input.step === "done") return "completed";
  if (input.step !== null) return "abandoned";
  if (input.answered) return "abandoned";
  if (input.hangupCause && REJECTED_CAUSES.has(input.hangupCause)) return "busy";
  return "no_answer";
}

/** "done" becomes 0 so calls.last_step can stay a plain integer column. */
export function encodeStep(step: number | "done" | null): number | null {
  if (step === null) return null;
  return step === "done" ? 0 : step;
}

export function decodeStep(value: number | null): number | "done" | null {
  if (value === null) return null;
  return value === 0 ? "done" : value;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- call-outcome`
Expected: PASS, 15 tests.

- [ ] **Step 6: Implement the call queries**

`console/api/src/calls/queries.ts`:

```ts
import type { Call, CallOutcome, CampaignProgress } from "@console/shared";
import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";
import { decodeStep } from "./outcome.js";

const callRow = z.object({
  id: z.string().uuid(),
  contact_id: z.string().uuid(),
  e164: z.string(),
  external_ref: z.string().nullable(),
  from_e164: z.string().nullable(),
  attempt: z.number().int(),
  status: z.enum(["queued", "dialing", "in_progress", "ended", "failed"]),
  outcome: z
    .enum(["completed", "abandoned", "no_answer", "busy", "failed", "unknown"])
    .nullable(),
  last_step: z.number().int().nullable(),
  hangup_cause: z.string().nullable(),
  created_at: z.date(),
  answered_at: z.date().nullable(),
  ended_at: z.date().nullable(),
});

function toCall(row: z.infer<typeof callRow>): Call {
  return {
    id: row.id,
    contactId: row.contact_id,
    e164: row.e164,
    externalRef: row.external_ref,
    fromE164: row.from_e164,
    attempt: row.attempt,
    status: row.status,
    outcome: row.outcome,
    lastStep: decodeStep(row.last_step),
    hangupCause: row.hangup_cause,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

const SELECT_CALL = `
  SELECT ca.id, ca.contact_id, ct.e164, ct.external_ref, pn.e164 AS from_e164,
         ca.attempt, ca.status, ca.outcome, ca.last_step, ca.hangup_cause,
         ca.created_at, ca.answered_at, ca.ended_at
    FROM calls ca
    JOIN contacts ct ON ct.id = ca.contact_id
    LEFT JOIN phone_numbers pn ON pn.id = ca.phone_number_id
`;

export async function listCallsForCampaign(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<Call[]> {
  const result = await pool.query(
    `${SELECT_CALL}
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.tenant_id = $1 AND ca.campaign_id = $2
      ORDER BY ca.created_at DESC`,
    [tenantId, campaignId],
  );
  return parseRows(callRow, result).map(toCall);
}

export async function campaignProgress(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<CampaignProgress> {
  const result = await pool.query(
    `SELECT count(*) FILTER (WHERE ct.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE ct.status = 'dialing')::int AS dialing,
            count(*) FILTER (WHERE ct.status = 'done')::int    AS done,
            count(*)::int                                      AS total
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2`,
    [tenantId, campaignId],
  );
  return parseExactlyOne(
    z.object({
      pending: z.number().int(),
      dialing: z.number().int(),
      done: z.number().int(),
      total: z.number().int(),
    }),
    result,
  );
}

/** Attempt numbers count per contact, which is what manual retry increments. */
export async function insertQueuedCall(
  client: PoolClient,
  args: { campaignId: string; contactId: string; phoneNumberId: string },
): Promise<string> {
  const result = await client.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id, attempt)
     SELECT $1, $2, $3,
            COALESCE((SELECT max(attempt) FROM calls WHERE contact_id = $2), 0) + 1
       RETURNING id`,
    [args.campaignId, args.contactId, args.phoneNumberId],
  );
  return parseExactlyOne(z.object({ id: z.string().uuid() }), result).id;
}

export async function markDialing(
  pool: Pool,
  callId: string,
  callControlId: string,
): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'dialing', telnyx_call_control_id = $2,
            dialed_at = now()
      WHERE id = $1`,
    [callId, callControlId],
  );
}

export async function markFailed(pool: Pool, callId: string): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'failed', outcome = 'failed', ended_at = now()
      WHERE id = $1`,
    [callId],
  );
}

export async function findCallByCcid(
  pool: Pool,
  callControlId: string,
): Promise<{ id: string; answered: boolean; status: string } | null> {
  const result = await pool.query(
    `SELECT id, answered_at IS NOT NULL AS answered, status
       FROM calls WHERE telnyx_call_control_id = $1`,
    [callControlId],
  );
  return parseOne(
    z.object({
      id: z.string().uuid(),
      answered: z.boolean(),
      status: z.string(),
    }),
    result,
  );
}

/**
 * Forward-only: a replayed call.answered after the call has ended must not
 * reopen it. This is what makes callback delivery idempotent without a
 * separate dedupe table.
 */
export async function markAnswered(pool: Pool, callId: string): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'in_progress', answered_at = COALESCE(answered_at, now())
      WHERE id = $1 AND status IN ('queued', 'dialing')`,
    [callId],
  );
}

export async function markEnded(
  pool: Pool,
  args: {
    callId: string;
    outcome: CallOutcome;
    lastStep: number | null;
    hangupCause: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE calls
        SET status = 'ended', outcome = $2, last_step = $3, hangup_cause = $4,
            ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND status <> 'ended'`,
    [args.callId, args.outcome, args.lastStep, args.hangupCause],
  );
}

export async function markContactDone(
  pool: Pool,
  callId: string,
): Promise<void> {
  await pool.query(
    `UPDATE contacts SET status = 'done'
      WHERE id = (SELECT contact_id FROM calls WHERE id = $1)`,
    [callId],
  );
}
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 6: The callback endpoint

**Files:**
- Create: `console/api/src/callbacks/verify.ts`
- Create: `console/api/src/callbacks/routes.ts`
- Modify: `console/api/src/app.ts`
- Modify: `console/api/src/config.ts` (add `workerHmacSecret`, `workerBaseUrl`, `workerTriggerSecret`, `publicBaseUrl`)
- Modify: `console/api/test/helpers.ts` (supply the new config values)
- Test: `console/api/test/callback-verify.test.ts`
- Test: `console/api/test/callback-routes.test.ts`

**Interfaces:**
- Consumes: `deriveOutcome`, `encodeStep`, call queries from Task 5; `releaseLeaseForCall` from Task 4.
- Produces:
  - `verifyCallbackSignature(args: { secret, timestamp, signature, rawBody, nowMs? }): boolean`
  - `POST /callbacks/worker`, which always returns 200 for a well-signed request.

- [ ] **Step 1: Extend config**

In `console/api/src/config.ts`, add to `envSchema`:

```ts
  WORKER_BASE_URL: z.string().url(),
  WORKER_TRIGGER_SECRET: z.string().min(8),
  WORKER_HMAC_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url(),
  DIALER: z.enum(["cf-worker", "fake"]).default("cf-worker"),
```

Add to `Config`:

```ts
  worker: {
    baseUrl: string;
    triggerSecret: string;
    hmacSecret: string;
  };
  /** Where the Cloudflare Worker reaches this console. Must be public https. */
  publicBaseUrl: string;
  dialer: "cf-worker" | "fake";
```

And to the returned object:

```ts
    worker: {
      baseUrl: value.WORKER_BASE_URL,
      triggerSecret: value.WORKER_TRIGGER_SECRET,
      hmacSecret: value.WORKER_HMAC_SECRET,
    },
    publicBaseUrl: value.PUBLIC_BASE_URL,
    dialer: value.DIALER,
```

Add matching entries to `.env.example` and `.env.prod.example`, and add all five
to the `testConfig()` helper in `console/api/test/helpers.ts`:

```ts
    WORKER_BASE_URL: "https://worker.example",
    WORKER_TRIGGER_SECRET: "trigger-secret",
    WORKER_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: "https://console.example",
    DIALER: "fake",
```

The existing `config.test.ts` cases must be updated with the same five values,
since `loadConfig` now requires them.

- [ ] **Step 2: Write the failing verification test**

`console/api/test/callback-verify.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCallbackSignature } from "../src/callbacks/verify.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = '{"event":"call.answered"}';
const NOW_MS = 1_800_000_000_000;
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));

function sign(timestamp: string, body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

describe("verifyCallbackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a body that was altered in flight", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY),
        rawBody: '{"event":"call.hangup"}',
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY, "wrong-secret-wrong-secret-wrong!"),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a replay from six minutes ago", () => {
    const old = String(Math.floor(NOW_MS / 1000) - 360);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: old,
        signature: sign(old, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("accepts a request four minutes old, allowing for clock drift", () => {
    const recent = String(Math.floor(NOW_MS / 1000) - 240);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: recent,
        signature: sign(recent, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a timestamp from the future beyond the tolerance", () => {
    const future = String(Math.floor(NOW_MS / 1000) + 360);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: future,
        signature: sign(future, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: null,
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature without the sha256 prefix", () => {
    const bare = sign(TIMESTAMP, BODY).slice("sha256=".length);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: bare,
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: "not-a-number",
        signature: sign("not-a-number", BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: "sha256=abcd",
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- callback-verify`
Expected: FAIL - cannot resolve `../src/callbacks/verify.js`.

- [ ] **Step 4: Implement verify.ts**

`console/api/src/callbacks/verify.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** Generous enough for clock drift, tight enough that a capture goes stale. */
const MAX_SKEW_SECONDS = 300;

export function verifyCallbackSignature(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody } = args;
  const nowMs = args.nowMs ?? Date.now();

  if (!timestamp || !signature) return false;
  if (!signature.startsWith("sha256=")) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(nowMs / 1000 - sent) > MAX_SKEW_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");

  // timingSafeEqual throws on a length mismatch, which an attacker controls.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- callback-verify`
Expected: PASS, 10 tests.

- [ ] **Step 6: Implement the callback route**

`console/api/src/callbacks/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  findCallByCcid,
  markAnswered,
  markContactDone,
  markEnded,
} from "../calls/queries.js";
import { deriveOutcome, encodeStep } from "../calls/outcome.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { releaseLeaseForCall } from "../numbers/pool.js";
import { verifyCallbackSignature } from "./verify.js";

const bodySchema = z.object({
  event: z.string(),
  call_control_id: z.string().min(1),
  occurred_at: z.string(),
  step: z.union([z.number().int(), z.literal("done")]).nullable(),
  payload: z.record(z.unknown()).default({}),
});

export function registerCallbackRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config },
): void {
  const { pool, config } = deps;

  // The raw body is needed for HMAC verification, so this route opts out of
  // Fastify's JSON parsing rather than re-serialising and changing the bytes.
  app.post(
    "/callbacks/worker",
    { config: { rawBody: true } },
    async (request, reply) => {
      const rawBody =
        typeof request.body === "string" ? request.body : String(request.body);

      const ok = verifyCallbackSignature({
        secret: config.worker.hmacSecret,
        timestamp: request.headers["x-console-timestamp"] as string | undefined ?? null,
        signature: request.headers["x-console-signature"] as string | undefined ?? null,
        rawBody,
      });
      if (!ok) return reply.status(401).send({ error: "invalid signature" });

      let parsed: z.infer<typeof bodySchema>;
      try {
        parsed = bodySchema.parse(JSON.parse(rawBody));
      } catch {
        return reply.status(400).send({ error: "invalid callback body" });
      }

      const call = await findCallByCcid(pool, parsed.call_control_id);
      // A callback for a call we never recorded is not an error worth retrying.
      if (!call) {
        request.log.warn(
          { ccid: parsed.call_control_id, event: parsed.event },
          "callback for unknown call",
        );
        return { ok: true };
      }

      switch (parsed.event) {
        case "call.answered":
          await markAnswered(pool, call.id);
          break;

        case "call.hangup": {
          const hangupCause =
            typeof parsed.payload.hangup_cause === "string"
              ? parsed.payload.hangup_cause
              : null;

          await markEnded(pool, {
            callId: call.id,
            outcome: deriveOutcome({
              step: parsed.step,
              answered: call.answered,
              hangupCause,
            }),
            lastStep: encodeStep(parsed.step),
            hangupCause,
          });
          await markContactDone(pool, call.id);
          // Freeing the number promptly is the whole reason this endpoint
          // exists rather than a polling loop.
          await releaseLeaseForCall(pool, call.id);
          break;
        }

        case "call.recording.saved":
          // Plan 3 inserts the recording row and enqueues ingest here. For now
          // the event is acknowledged so the Worker does not log a rejection.
          request.log.info(
            { ccid: parsed.call_control_id },
            "recording saved, ingest arrives in the media plan",
          );
          break;

        default:
          break;
      }

      return { ok: true };
    },
  );
}
```

- [ ] **Step 7: Wire it up**

Run: `cd console && npm install --workspace @console/api fastify-raw-body`

In `console/api/src/app.ts`:

```ts
import rawBody from "fastify-raw-body";
import { registerCallbackRoutes } from "./callbacks/routes.js";
```

Register the plugin after `cookie`, and the routes with the others:

```ts
  app.register(rawBody, { field: "rawBody", global: false, runFirst: true });
```

```ts
  registerContactRoutes(app, deps);
  registerCallbackRoutes(app, deps);
```

Because `runFirst` is set and the route opts in with `config: { rawBody: true }`,
`request.body` for that route is the untouched string the Worker signed.

- [ ] **Step 8: Write the callback route test**

`console/api/test/callback-routes.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let callId: string;
let contactId: string;

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
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  const { tenantId } = await seedTenant(pool, "acme");

  const number = await pool.query(
    "INSERT INTO phone_numbers (e164) VALUES ('+37069000001') RETURNING id",
  );
  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, status)
          VALUES ($1, '+37060000001', 'dialing') RETURNING id`,
    [campaign.rows[0].id],
  );
  contactId = contact.rows[0].id as string;

  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id,
                        telnyx_call_control_id, status)
          VALUES ($1, $2, $3, 'ccid-1', 'dialing') RETURNING id`,
    [campaign.rows[0].id, contactId, number.rows[0].id],
  );
  callId = call.rows[0].id as string;

  await pool.query(
    `INSERT INTO number_leases (phone_number_id, call_id, expires_at)
          VALUES ($1, $2, now() + interval '8 minutes')`,
    [number.rows[0].id, callId],
  );
});

function send(body: unknown, options: { secret?: string } = {}) {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac(
    "sha256",
    options.secret ?? config.worker.hmacSecret,
  )
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return app.inject({
    method: "POST",
    url: "/callbacks/worker",
    headers: {
      "content-type": "application/json",
      "x-console-timestamp": timestamp,
      "x-console-signature": `sha256=${signature}`,
    },
    payload,
  });
}

const base = {
  call_control_id: "ccid-1",
  occurred_at: "2026-08-05T10:00:00.000Z",
  payload: {},
};

async function callRow() {
  const result = await pool.query("SELECT * FROM calls WHERE id = $1", [callId]);
  return result.rows[0];
}

describe("POST /callbacks/worker", () => {
  it("rejects an unsigned request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/callbacks/worker",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...base, event: "call.answered", step: null }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const response = await send(
      { ...base, event: "call.answered", step: null },
      { secret: "wrong-secret-wrong-secret-wrong!" },
    );
    expect(response.statusCode).toBe(401);
  });

  it("marks the call in progress on call.answered", async () => {
    await send({ ...base, event: "call.answered", step: null });
    const row = await callRow();
    expect(row.status).toBe("in_progress");
    expect(row.answered_at).not.toBeNull();
  });

  it("records a completed survey on hangup at step done", async () => {
    await send({ ...base, event: "call.answered", step: null });
    await send({
      ...base,
      event: "call.hangup",
      step: "done",
      payload: { hangup_cause: "normal_clearing" },
    });
    const row = await callRow();
    expect(row.status).toBe("ended");
    expect(row.outcome).toBe("completed");
    expect(row.last_step).toBe(0);
  });

  it("records abandonment with the question the caller reached", async () => {
    await send({ ...base, event: "call.answered", step: null });
    await send({ ...base, event: "call.hangup", step: 2 });
    const row = await callRow();
    expect(row.outcome).toBe("abandoned");
    expect(row.last_step).toBe(2);
  });

  it("records no_answer when the call was never answered", async () => {
    await send({
      ...base,
      event: "call.hangup",
      step: null,
      payload: { hangup_cause: "no_answer" },
    });
    expect((await callRow()).outcome).toBe("no_answer");
  });

  it("releases the number lease on hangup", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    const leases = await pool.query(
      "SELECT released_at FROM number_leases WHERE call_id = $1",
      [callId],
    );
    expect(leases.rows[0].released_at).not.toBeNull();
  });

  it("marks the contact done on hangup", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    const contact = await pool.query("SELECT status FROM contacts WHERE id = $1", [
      contactId,
    ]);
    expect(contact.rows[0].status).toBe("done");
  });

  it("ignores a replayed call.answered after the call ended", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    await send({ ...base, event: "call.answered", step: null });
    expect((await callRow()).status).toBe("ended");
  });

  it("keeps the first outcome when hangup is delivered twice", async () => {
    await send({ ...base, event: "call.hangup", step: "done" });
    await send({ ...base, event: "call.hangup", step: 1 });
    expect((await callRow()).outcome).toBe("completed");
  });

  it("returns 200 for an unknown call rather than inviting a retry", async () => {
    const response = await send({
      ...base,
      call_control_id: "ccid-unknown",
      event: "call.hangup",
      step: "done",
    });
    expect(response.statusCode).toBe(200);
  });

  it("acknowledges call.recording.saved", async () => {
    const response = await send({
      ...base,
      event: "call.recording.saved",
      step: null,
      payload: { recording_id: "rec-1" },
    });
    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 9: Run the callback route tests**

Run: `cd console && npm run test --workspace @console/api -- callback-routes`
Expected: PASS, 12 tests.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 7: The dialer seam

Telnyx cannot fetch audio from MinIO on localhost, and a Cloudflare Worker
cannot POST a callback to a laptop. `FakeDialer` is what makes every path below
the dial testable without either.

**Files:**
- Create: `console/api/src/dispatch/dialer.ts`
- Test: `console/api/test/dialer.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 6.
- Produces:
  - `DialArgs = { to: string; from: string; silenceMs: number; audio: { questions: string[]; thanks: string }; callbackUrl: string }`
  - `DialerProvider = { dial(args: DialArgs): Promise<{ callControlId: string }> }`
  - `DialError` with `status: number`
  - `createDialer(config: Config): DialerProvider`
  - `CfWorkerDialer`, `FakeDialer` (exported for tests and for the fake's event pump)

- [ ] **Step 1: Write the failing dialer test**

`console/api/test/dialer.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfWorkerDialer, DialError, createDialer } from "../src/dispatch/dialer.js";
import { testConfig } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const args = {
  to: "+37060000001",
  from: "+37069000001",
  silenceMs: 2500,
  audio: {
    questions: ["https://s3.example/q1.mp3?X-Amz-Signature=x"],
    thanks: "https://s3.example/thanks.mp3?X-Amz-Signature=x",
  },
  callbackUrl: "https://console.example/callbacks/worker",
};

function stub(response: { ok: boolean; status: number; body: unknown }) {
  const spy = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("CfWorkerDialer", () => {
  it("returns the call control id the Worker issued", async () => {
    stub({ ok: true, status: 200, body: { call_control_id: "ccid-9" } });
    const dialer = new CfWorkerDialer(testConfig());
    expect(await dialer.dial(args)).toEqual({ callControlId: "ccid-9" });
  });

  it("posts to the Worker's /calls with the trigger secret", async () => {
    const spy = stub({ ok: true, status: 200, body: { call_control_id: "x" } });
    await new CfWorkerDialer(testConfig()).dial(args);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://worker.example/calls");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer trigger-secret",
    );
  });

  it("sends every field the Worker needs", async () => {
    const spy = stub({ ok: true, status: 200, body: { call_control_id: "x" } });
    await new CfWorkerDialer(testConfig()).dial(args);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      to: args.to,
      from: args.from,
      silenceMs: args.silenceMs,
      audio: args.audio,
      callbackUrl: args.callbackUrl,
    });
  });

  it("throws DialError carrying the status on a rejection", async () => {
    stub({ ok: false, status: 400, body: { error: "audio.questions[0] expired" } });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("puts the Worker's message in the error, so a failed dial is diagnosable", async () => {
    stub({ ok: false, status: 400, body: { error: "audio.questions[0] expired" } });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toThrow(
      /expired/,
    );
  });

  it("throws DialError when the Worker returns no call_control_id", async () => {
    stub({ ok: true, status: 200, body: {} });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toBeInstanceOf(
      DialError,
    );
  });
});

describe("createDialer", () => {
  it("returns the fake when DIALER is fake", async () => {
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    const result = await dialer.dial(args);
    expect(result.callControlId).toMatch(/^fake-/);
  });

  it("returns the real dialer when DIALER is cf-worker", () => {
    const dialer = createDialer({ ...testConfig(), dialer: "cf-worker" });
    expect(dialer).toBeInstanceOf(CfWorkerDialer);
  });
});

describe("FakeDialer", () => {
  it("delivers answered then hangup for each dial", async () => {
    const delivered: string[] = [];
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        delivered.push(JSON.parse(String(init.body)).event);
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await dialer.dial(args);
    await vi.waitFor(() => expect(delivered).toContain("call.hangup"), {
      timeout: 5000,
    });

    expect(delivered).toEqual([
      "call.answered",
      "call.recording.saved",
      "call.hangup",
    ]);
  });

  it("signs its callbacks the same way the Worker does", async () => {
    const headers: Record<string, string>[] = [];
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await dialer.dial(args);
    await vi.waitFor(() => expect(headers.length).toBeGreaterThan(0));
    expect(headers[0]!["x-console-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- dialer`
Expected: FAIL - cannot resolve `../src/dispatch/dialer.js`.

- [ ] **Step 3: Implement the dialer**

`console/api/src/dispatch/dialer.ts`:

```ts
import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../config.js";

export interface DialArgs {
  to: string;
  from: string;
  silenceMs: number;
  audio: { questions: string[]; thanks: string };
  callbackUrl: string;
}

export interface DialerProvider {
  dial(args: DialArgs): Promise<{ callControlId: string }>;
}

export class DialError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DialError";
    this.status = status;
  }
}

export class CfWorkerDialer implements DialerProvider {
  constructor(private readonly config: Config) {}

  async dial(args: DialArgs): Promise<{ callControlId: string }> {
    const response = await fetch(`${this.config.worker.baseUrl}/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.worker.triggerSecret}`,
      },
      body: JSON.stringify({
        to: args.to,
        from: args.from,
        silenceMs: args.silenceMs,
        audio: args.audio,
        callbackUrl: args.callbackUrl,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      call_control_id?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new DialError(
        response.status,
        body.error ?? `worker rejected the call with ${response.status}`,
      );
    }
    if (!body.call_control_id) {
      throw new DialError(502, "worker returned no call_control_id");
    }
    return { callControlId: body.call_control_id };
  }
}

/**
 * Stands in for the Worker during local development, where nothing external can
 * reach the console. It plays the same callback sequence a real call produces,
 * signed with the same secret, so the callback route and everything downstream
 * of it run unchanged.
 */
export class FakeDialer implements DialerProvider {
  constructor(private readonly config: Config) {}

  async dial(args: DialArgs): Promise<{ callControlId: string }> {
    const callControlId = `fake-${randomUUID()}`;
    void this.playSequence(callControlId, args);
    return { callControlId };
  }

  private async playSequence(
    callControlId: string,
    args: DialArgs,
  ): Promise<void> {
    const questions = args.audio.questions.length;

    await this.deliver(callControlId, "call.answered", null, {});
    await sleep(50);
    await this.deliver(callControlId, "call.recording.saved", null, {
      recording_id: `fake-rec-${randomUUID()}`,
      channels: "dual",
      recording_urls: { mp3: "https://fake.invalid/recording.mp3" },
    });
    await sleep(50);
    // Most fake calls complete; every fifth abandons partway, so the abandoned
    // path is exercised in development rather than only in production.
    const abandons = Math.random() < 0.2 && questions > 1;
    await this.deliver(
      callControlId,
      "call.hangup",
      abandons ? Math.max(1, questions - 1) : "done",
      { hangup_cause: "normal_clearing" },
    );
  }

  private async deliver(
    callControlId: string,
    event: string,
    step: number | "done" | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      call_control_id: callControlId,
      occurred_at: new Date().toISOString(),
      step,
      payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", this.config.worker.hmacSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    try {
      await fetch(`${this.config.publicBaseUrl}/callbacks/worker`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-console-timestamp": timestamp,
          "x-console-signature": `sha256=${signature}`,
        },
        body,
      });
    } catch {
      // The fake must not be able to crash the dispatcher.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDialer(config: Config): DialerProvider {
  return config.dialer === "fake"
    ? new FakeDialer(config)
    : new CfWorkerDialer(config);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- dialer`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `cd console && npm run typecheck`
Expected: no errors.

---

### Task 8: The dispatcher

**Files:**
- Create: `console/api/src/dispatch/queries.ts`
- Create: `console/api/src/dispatch/dispatcher.ts`
- Create: `console/api/src/worker.ts`
- Modify: `console/api/package.json` (add the `worker` script)
- Test: `console/api/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `acquireNumber`, `attachLeaseToCall`, `releaseLease`, `sweepExpiredLeases` from Task 4; `insertQueuedCall`, `markDialing`, `markFailed`, `markEnded` from Task 5; `DialerProvider` from Task 7; `presignGet` from Plan 1 Task 8.
- Produces:
  - `PRESIGN_TTL_SECONDS = 3600`
  - `claimNextContact(client, campaignId): Promise<{ contactId: string; e164: string } | null>`
  - `runnableCampaigns(pool): Promise<RunnableCampaign[]>`
  - `dispatchOnce(deps): Promise<{ dialled: number; swept: number }>`
  - `startDispatcher(deps): { stop(): void }`

- [ ] **Step 1: Implement the dispatch queries**

`console/api/src/dispatch/queries.ts`:

```ts
import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { parseOne, parseRows } from "../db/rows.js";

const runnableRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  silence_ms: z.number().int(),
  thanks_s3_key: z.string(),
});

export interface RunnableCampaign {
  id: string;
  tenantId: string;
  silenceMs: number;
  thanksS3Key: string;
}

/**
 * Running campaigns that still have somebody to call. A campaign with no
 * thanks audio cannot dial, so it is filtered out here rather than failing at
 * the Worker.
 */
export async function runnableCampaigns(pool: Pool): Promise<RunnableCampaign[]> {
  const result = await pool.query(
    `SELECT c.id, c.tenant_id, c.silence_ms, c.thanks_s3_key
       FROM campaigns c
      WHERE c.status = 'running'
        AND c.thanks_s3_key IS NOT NULL
        AND EXISTS (SELECT 1 FROM campaign_questions q WHERE q.campaign_id = c.id)
        AND EXISTS (SELECT 1 FROM contacts ct
                     WHERE ct.campaign_id = c.id AND ct.status = 'pending')
      ORDER BY c.launched_at NULLS FIRST, c.created_at`,
  );
  return parseRows(runnableRow, result).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    silenceMs: row.silence_ms,
    thanksS3Key: row.thanks_s3_key,
  }));
}

/**
 * Takes one pending contact and marks it dialing in the same statement.
 * SKIP LOCKED means two dispatcher instances never claim the same contact.
 */
export async function claimNextContact(
  client: PoolClient,
  campaignId: string,
): Promise<{ contactId: string; e164: string } | null> {
  const result = await client.query(
    `UPDATE contacts SET status = 'dialing'
      WHERE id = (
        SELECT id FROM contacts
         WHERE campaign_id = $1 AND status = 'pending'
         ORDER BY created_at
           FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, e164`,
    [campaignId],
  );
  const row = parseOne(
    z.object({ id: z.string().uuid(), e164: z.string() }),
    result,
  );
  return row === null ? null : { contactId: row.id, e164: row.e164 };
}

export async function releaseContact(
  pool: Pool,
  contactId: string,
): Promise<void> {
  await pool.query(
    `UPDATE contacts SET status = 'pending' WHERE id = $1 AND status = 'dialing'`,
    [contactId],
  );
}

export async function questionKeysFor(
  pool: Pool,
  campaignId: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT s3_key FROM campaign_questions
      WHERE campaign_id = $1 ORDER BY position`,
    [campaignId],
  );
  return parseRows(z.object({ s3_key: z.string() }), result).map(
    (row) => row.s3_key,
  );
}

/** A campaign with nothing pending and nothing in flight is finished. */
export async function completeFinishedCampaigns(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE campaigns SET status = 'completed'
      WHERE status = 'running'
        AND NOT EXISTS (SELECT 1 FROM contacts ct
                         WHERE ct.campaign_id = campaigns.id
                           AND ct.status IN ('pending', 'dialing'))`,
  );
  return result.rowCount ?? 0;
}
```

- [ ] **Step 2: Write the failing dispatcher test**

`console/api/test/dispatcher.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import type { DialArgs, DialerProvider } from "../src/dispatch/dialer.js";
import { DialError } from "../src/dispatch/dialer.js";
import { dispatchOnce } from "../src/dispatch/dispatcher.js";
import { createS3 } from "../src/s3.js";
import { resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let tenantId: string;
let campaignId: string;

const dialled: DialArgs[] = [];

class RecordingDialer implements DialerProvider {
  constructor(private readonly failWith?: DialError) {}

  async dial(args: DialArgs): Promise<{ callControlId: string }> {
    dialled.push(args);
    if (this.failWith) throw this.failWith;
    return { callControlId: `ccid-${dialled.length}` };
  }
}

function deps(dialer: DialerProvider) {
  return { pool, config, s3: createS3(config), dialer };
}

beforeAll(() => {
  pool = createPool(config);
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  dialled.length = 0;
  await resetDatabase(pool);
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  tenantId = (await seedTenant(pool, "acme")).tenantId;

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country,
                            silence_ms, thanks_s3_key, status, launched_at)
          VALUES ($1, 'c', 'lt', 'LT', 3000, 'tenants/t/thanks.mp3', 'running', now())
       RETURNING id`,
    [tenantId],
  );
  campaignId = campaign.rows[0].id as string;

  await pool.query(
    `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                     original_filename, bytes)
          VALUES ($1, 1, 'tenants/t/q1.mp3', 'q1.mp3', 10)`,
    [campaignId],
  );
});

async function addContacts(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO contacts (campaign_id, e164)
     SELECT $1, '+3706000' || lpad(g::text, 4, '0')
       FROM generate_series(1, $2) AS g`,
    [campaignId, count],
  );
}

async function addNumbers(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO phone_numbers (e164)
     SELECT '+3706900' || lpad(g::text, 4, '0') FROM generate_series(1, $1) AS g`,
    [count],
  );
}

describe("dispatchOnce", () => {
  it("dials one contact when one number is free", async () => {
    await addContacts(3);
    await addNumbers(1);

    const result = await dispatchOnce(deps(new RecordingDialer()));
    expect(result.dialled).toBe(1);
    expect(dialled).toHaveLength(1);
  });

  it("dials nothing when the pool is empty", async () => {
    await addContacts(3);
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });

  it("dials nothing when the campaign is a draft", async () => {
    await addContacts(3);
    await addNumbers(1);
    await pool.query("UPDATE campaigns SET status = 'draft' WHERE id = $1", [
      campaignId,
    ]);
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });

  it("dials nothing when the campaign is paused", async () => {
    await addContacts(3);
    await addNumbers(1);
    await pool.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [
      campaignId,
    ]);
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });

  it("dials up to the number of free numbers in one tick", async () => {
    await addContacts(5);
    await addNumbers(3);
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(3);
  });

  it("passes the campaign's silenceMs through to the dialer", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));
    expect(dialled[0]?.silenceMs).toBe(3000);
  });

  it("presigns the question and thanks audio", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));
    expect(dialled[0]?.audio.questions[0]).toMatch(/X-Amz-Signature=/);
    expect(dialled[0]?.audio.thanks).toMatch(/X-Amz-Signature=/);
  });

  it("points the callback at this console's public base URL", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));
    expect(dialled[0]?.callbackUrl).toBe(
      "https://console.example/callbacks/worker",
    );
  });

  it("records the call as dialing with its control id", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));

    const call = await pool.query("SELECT * FROM calls");
    expect(call.rows[0].status).toBe("dialing");
    expect(call.rows[0].telnyx_call_control_id).toBe("ccid-1");
    expect(call.rows[0].attempt).toBe(1);
  });

  it("holds the number until the call reports back", async () => {
    await addContacts(2);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });

  it("returns the contact to pending when the dial fails", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer(new DialError(400, "bad audio"))));

    const contact = await pool.query("SELECT status FROM contacts");
    expect(contact.rows[0].status).toBe("pending");
  });

  it("frees the number when the dial fails", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer(new DialError(400, "bad audio"))));

    const leases = await pool.query(
      "SELECT released_at FROM number_leases WHERE released_at IS NULL",
    );
    expect(leases.rowCount).toBe(0);
  });

  it("records a failed call so the operator can see what happened", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer(new DialError(400, "bad audio"))));

    const call = await pool.query("SELECT status, outcome FROM calls");
    expect(call.rows[0].status).toBe("failed");
    expect(call.rows[0].outcome).toBe("failed");
  });

  it("sweeps an expired lease and ends its call as unknown", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));
    await pool.query("UPDATE number_leases SET expires_at = now() - interval '1 min'");

    const result = await dispatchOnce(deps(new RecordingDialer()));
    expect(result.swept).toBe(1);

    const call = await pool.query("SELECT status, outcome FROM calls ORDER BY created_at");
    expect(call.rows[0].outcome).toBe("unknown");
  });

  it("marks a campaign completed once every contact is done", async () => {
    await addContacts(1);
    await pool.query("UPDATE contacts SET status = 'done'");
    await dispatchOnce(deps(new RecordingDialer()));

    const campaign = await pool.query("SELECT status FROM campaigns WHERE id = $1", [
      campaignId,
    ]);
    expect(campaign.rows[0].status).toBe("completed");
  });

  it("skips a campaign that has no thanks audio rather than failing at the Worker", async () => {
    await addContacts(1);
    await addNumbers(1);
    await pool.query("UPDATE campaigns SET thanks_s3_key = NULL WHERE id = $1", [
      campaignId,
    ]);
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });

  it("does not lend a number dedicated to another tenant", async () => {
    const other = await seedTenant(pool, "globex");
    await addContacts(1);
    await pool.query(
      "INSERT INTO phone_numbers (e164, tenant_id) VALUES ('+37069000099', $1)",
      [other.tenantId],
    );
    expect((await dispatchOnce(deps(new RecordingDialer()))).dialled).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: FAIL - cannot resolve `../src/dispatch/dispatcher.js`.

- [ ] **Step 4: Implement the dispatcher**

`console/api/src/dispatch/dispatcher.ts`:

```ts
import {
  insertQueuedCall,
  markDialing,
  markEnded,
  markFailed,
} from "../calls/queries.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import {
  acquireNumber,
  attachLeaseToCall,
  releaseLease,
  sweepExpiredLeases,
} from "../numbers/pool.js";
import { presignGet, type S3Client } from "../s3.js";
import type { DialerProvider } from "./dialer.js";
import {
  claimNextContact,
  completeFinishedCampaigns,
  questionKeysFor,
  releaseContact,
  runnableCampaigns,
} from "./queries.js";

/**
 * One hour. The Worker computes the runway it needs from the question count
 * and refuses a URL that expires too soon; an hour clears the ten-question
 * worst case with room to spare.
 */
export const PRESIGN_TTL_SECONDS = 3600;

export const TICK_MS = 2000;

export interface DispatchDeps {
  pool: Pool;
  config: Config;
  s3: S3Client;
  dialer: DialerProvider;
}

/**
 * One pass of the loop. Kept separate from the timer so the whole behaviour is
 * testable without waiting on real time.
 */
export async function dispatchOnce(
  deps: DispatchDeps,
): Promise<{ dialled: number; swept: number }> {
  const { pool, config, s3, dialer } = deps;

  // A lease that outlived its call would otherwise hold a number forever.
  const strandedCallIds = await sweepExpiredLeases(pool);
  for (const callId of strandedCallIds) {
    await markEnded(pool, {
      callId,
      outcome: "unknown",
      lastStep: null,
      hangupCause: null,
    });
  }

  let dialled = 0;

  for (const campaign of await runnableCampaigns(pool)) {
    // Keep taking numbers for this campaign until the pool says no.
    for (;;) {
      const lease = await acquireNumber(pool, campaign.tenantId);
      if (!lease) break;

      const claimed = await withTransaction(pool, async (client) => {
        const contact = await claimNextContact(client, campaign.id);
        if (!contact) return null;

        const callId = await insertQueuedCall(client, {
          campaignId: campaign.id,
          contactId: contact.contactId,
          phoneNumberId: lease.phoneNumberId,
        });
        await attachLeaseToCall(client, lease.leaseId, callId);
        return { ...contact, callId };
      });

      if (!claimed) {
        // Somebody else took the last contact between the two statements.
        await releaseLease(pool, lease.leaseId);
        break;
      }

      const keys = await questionKeysFor(pool, campaign.id);
      const audio = {
        questions: await Promise.all(
          keys.map((key) => presignGet(s3, config, key, PRESIGN_TTL_SECONDS)),
        ),
        thanks: await presignGet(
          s3,
          config,
          campaign.thanksS3Key,
          PRESIGN_TTL_SECONDS,
        ),
      };

      try {
        const { callControlId } = await dialer.dial({
          to: claimed.e164,
          from: lease.e164,
          silenceMs: campaign.silenceMs,
          audio,
          callbackUrl: `${config.publicBaseUrl}/callbacks/worker`,
        });
        await markDialing(pool, claimed.callId, callControlId);
        dialled += 1;
      } catch (error) {
        // A failed dial must not consume the contact or the number. The call
        // row stays as history so the operator can see why it failed.
        await markFailed(pool, claimed.callId);
        await releaseLease(pool, lease.leaseId);
        await releaseContact(pool, claimed.contactId);
        console.error(
          JSON.stringify({
            msg: "dial_failed",
            call_id: claimed.callId,
            to: claimed.e164,
            error: String(error),
          }),
        );
        break;
      }
    }
  }

  await completeFinishedCampaigns(pool);

  return { dialled, swept: strandedCallIds.length };
}

export function startDispatcher(deps: DispatchDeps): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await dispatchOnce(deps);
      if (result.dialled > 0 || result.swept > 0) {
        console.log(JSON.stringify({ msg: "dispatch_tick", ...result }));
      }
    } catch (error) {
      // One bad tick must not end the loop.
      console.error(JSON.stringify({ msg: "dispatch_tick_failed", error: String(error) }));
    }
    if (!stopped) timer = setTimeout(() => void tick(), TICK_MS);
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

- [ ] **Step 5: Run the dispatcher tests**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: PASS, 17 tests.

- [ ] **Step 6: Implement the worker process**

`console/api/src/worker.ts`:

```ts
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { createDialer } from "./dispatch/dialer.js";
import { startDispatcher } from "./dispatch/dispatcher.js";
import { createS3 } from "./s3.js";

const config = loadConfig(process.env);
const pool = createPool(config);

const dispatcher = startDispatcher({
  pool,
  config,
  s3: createS3(config),
  dialer: createDialer(config),
});

console.log(
  JSON.stringify({ msg: "worker_started", dialer: config.dialer }),
);

async function shutdown(): Promise<void> {
  dispatcher.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
```

Add to `console/api/package.json` scripts:

```json
"worker": "node --experimental-strip-types --env-file=.env src/worker.ts",
"worker:dev": "node --watch --experimental-strip-types --env-file=.env src/worker.ts"
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 9: Launch, pause, retry, and the admin number routes

**Files:**
- Create: `console/api/src/calls/routes.ts`
- Create: `console/api/src/numbers/routes.ts`
- Modify: `console/api/src/campaigns/service.ts` (new file: launch validation)
- Modify: `console/api/src/campaigns/routes.ts`
- Modify: `console/api/src/campaigns/queries.ts` (status transitions)
- Modify: `console/api/src/cli/commands.ts` and `console/api/src/cli/index.ts` (add-number)
- Modify: `console/api/src/app.ts`
- Modify: `console/api/test/tenant-isolation.test.ts`
- Test: `console/api/test/campaign-launch.test.ts`
- Test: `console/api/test/admin-numbers.test.ts`

**Interfaces:**
- Consumes: `requireTenant`, `requirePlatformAdmin` from Plan 1 Task 5; call and number queries from Tasks 4 and 5.
- Produces:
  - `POST /api/campaigns/:id/launch`, `POST /api/campaigns/:id/pause`
  - `GET /api/campaigns/:id/calls`, `GET /api/campaigns/:id/progress`
  - `POST /api/calls/:id/retry`
  - `GET|POST /api/admin/numbers`, `PATCH /api/admin/numbers/:id`, `GET /api/admin/tenants`
  - `launchBlockers(pool, tenantId, campaignId): Promise<string[]>`

- [ ] **Step 1: Add the campaign status transitions**

Append to `console/api/src/campaigns/queries.ts`:

```ts
export async function setCampaignStatus(
  pool: Pool,
  tenantId: string,
  id: string,
  from: readonly string[],
  to: "running" | "paused",
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE campaigns
        SET status = $4,
            launched_at = CASE WHEN $4 = 'running' AND launched_at IS NULL
                               THEN now() ELSE launched_at END
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[])`,
    [tenantId, id, from, to],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 2: Implement launch validation**

`console/api/src/campaigns/service.ts`:

```ts
import { MAX_QUESTIONS } from "@console/shared";
import type { Pool } from "../db/client.js";
import { findCampaign } from "./queries.js";

/**
 * The server's definition of a launchable campaign. The web wizard has its own
 * `campaignReadiness` for the same rules; this is the one that is authoritative,
 * because the client can be edited and the server cannot.
 */
export async function launchBlockers(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<string[]> {
  const campaign = await findCampaign(pool, tenantId, campaignId);
  if (!campaign) return ["campaign not found"];

  const blockers: string[] = [];
  if (campaign.questionCount === 0) blockers.push("upload at least one question");
  if (campaign.questionCount > MAX_QUESTIONS) {
    blockers.push(`a campaign holds at most ${MAX_QUESTIONS} questions`);
  }
  if (!campaign.thanksUploaded) blockers.push("upload the thank-you audio");
  if (campaign.contactCount === 0) blockers.push("import at least one contact");

  // Positions must be contiguous from 1, because the Worker indexes
  // questions[step - 1] and a gap would play the wrong file or nothing.
  const positions = await pool.query(
    `SELECT position FROM campaign_questions
      WHERE campaign_id = $1 ORDER BY position`,
    [campaignId],
  );
  const expected = positions.rows.map((_row, index) => index + 1);
  const actual = positions.rows.map((row) => Number(row.position));
  if (actual.join(",") !== expected.join(",")) {
    blockers.push("question positions must run from 1 with no gaps");
  }

  return blockers;
}
```

- [ ] **Step 3: Write the failing launch test**

`console/api/test/campaign-launch.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let tenantId: string;
let campaignId: string;

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
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  const tenant = await seedTenant(pool, "acme");
  tenantId = tenant.tenantId;
  cookie = await loginAs(app, tenant.email);

  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country)
          VALUES ($1, 'c', 'lt', 'LT') RETURNING id`,
    [tenantId],
  );
  campaignId = campaign.rows[0].id as string;
});

async function makeLaunchable(): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                     original_filename, bytes)
          VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
    [campaignId],
  );
  await pool.query(
    "UPDATE campaigns SET thanks_s3_key = 'k/thanks.mp3' WHERE id = $1",
    [campaignId],
  );
  await pool.query(
    "INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')",
    [campaignId],
  );
}

function launch() {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/launch`,
    headers: { cookie },
  });
}

describe("POST /api/campaigns/:id/launch", () => {
  it("moves a complete campaign to running", async () => {
    await makeLaunchable();
    const response = await launch();
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("running");
  });

  it("stamps launched_at", async () => {
    await makeLaunchable();
    await launch();
    const row = await pool.query("SELECT launched_at FROM campaigns WHERE id = $1", [
      campaignId,
    ]);
    expect(row.rows[0].launched_at).not.toBeNull();
  });

  it("refuses a campaign with no questions and says why", async () => {
    const response = await launch();
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers).toContain("upload at least one question");
  });

  it("refuses a campaign with no contacts", async () => {
    await pool.query(
      `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                       original_filename, bytes)
            VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
      [campaignId],
    );
    await pool.query(
      "UPDATE campaigns SET thanks_s3_key = 'k/thanks.mp3' WHERE id = $1",
      [campaignId],
    );
    expect((await launch()).json().blockers).toContain(
      "import at least one contact",
    );
  });

  it("refuses a campaign with no thank-you audio", async () => {
    await pool.query(
      `INSERT INTO campaign_questions (campaign_id, position, s3_key,
                                       original_filename, bytes)
            VALUES ($1, 1, 'k/q1.mp3', 'q1.mp3', 10)`,
      [campaignId],
    );
    await pool.query(
      "INSERT INTO contacts (campaign_id, e164) VALUES ($1, '+37060000001')",
      [campaignId],
    );
    expect((await launch()).json().blockers).toContain("upload the thank-you audio");
  });

  it("refuses to relaunch a campaign that is already running", async () => {
    await makeLaunchable();
    await launch();
    expect((await launch()).statusCode).toBe(409);
  });
});

describe("POST /api/campaigns/:id/pause", () => {
  it("pauses a running campaign", async () => {
    await makeLaunchable();
    await launch();
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect(response.json().status).toBe("paused");
  });

  it("resumes from paused through launch", async () => {
    await makeLaunchable();
    await launch();
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect((await launch()).json().status).toBe("running");
  });

  it("refuses to pause a draft", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/pause`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("POST /api/calls/:id/retry", () => {
  async function endedCall(outcome: string): Promise<string> {
    const number = await pool.query(
      "INSERT INTO phone_numbers (e164) VALUES ('+37069000001') RETURNING id",
    );
    const contact = await pool.query(
      `INSERT INTO contacts (campaign_id, e164, status)
            VALUES ($1, '+37060000009', 'done') RETURNING id`,
      [campaignId],
    );
    const call = await pool.query(
      `INSERT INTO calls (campaign_id, contact_id, phone_number_id, status, outcome,
                          ended_at)
            VALUES ($1, $2, $3, 'ended', $4, now()) RETURNING id`,
      [campaignId, contact.rows[0].id, number.rows[0].id, outcome],
    );
    return call.rows[0].id as string;
  }

  it("returns the contact to pending so the dispatcher picks it up", async () => {
    const callId = await endedCall("no_answer");
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const contact = await pool.query(
      "SELECT status FROM contacts WHERE e164 = '+37060000009'",
    );
    expect(contact.rows[0].status).toBe("pending");
  });

  it("leaves the original call row intact as history", async () => {
    const callId = await endedCall("no_answer");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    const call = await pool.query("SELECT outcome FROM calls WHERE id = $1", [
      callId,
    ]);
    expect(call.rows[0].outcome).toBe("no_answer");
  });

  it("refuses to retry a call that has not ended", async () => {
    const callId = await endedCall("no_answer");
    await pool.query("UPDATE calls SET status = 'in_progress' WHERE id = $1", [
      callId,
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 404 for an unknown call", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/retry",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- campaign-launch`
Expected: FAIL - 404 on every route.

- [ ] **Step 5: Implement the call routes**

`console/api/src/calls/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import type { Pool } from "../db/client.js";
import { parseOne } from "../db/rows.js";
import { campaignProgress, listCallsForCampaign } from "./queries.js";

const idSchema = z.object({ id: z.string().uuid() });

export function registerCallRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  app.get("/api/campaigns/:id/calls", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid campaign id");
    return listCallsForCampaign(pool, tenantId, parsed.data.id);
  });

  app.get("/api/campaigns/:id/progress", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid campaign id");
    return campaignProgress(pool, tenantId, parsed.data.id);
  });

  app.post("/api/calls/:id/retry", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid call id");

    // Joined through campaigns so another tenant's call id is simply not found.
    const found = await pool.query(
      `SELECT ca.id, ca.status, ca.contact_id
         FROM calls ca
         JOIN campaigns c ON c.id = ca.campaign_id
        WHERE c.tenant_id = $1 AND ca.id = $2`,
      [tenantId, parsed.data.id],
    );
    const call = parseOne(
      z.object({
        id: z.string().uuid(),
        status: z.string(),
        contact_id: z.string().uuid(),
      }),
      found,
    );
    if (!call) throw new HttpError(404, "call not found");
    if (call.status !== "ended" && call.status !== "failed") {
      throw new HttpError(409, "only a finished call can be retried");
    }

    // The old call row stays as history; the dispatcher creates a new one with
    // the next attempt number.
    await pool.query(`UPDATE contacts SET status = 'pending' WHERE id = $1`, [
      call.contact_id,
    ]);

    return { ok: true };
  });
}
```

- [ ] **Step 6: Add launch and pause to the campaign routes**

Append inside `registerCampaignRoutes` in `console/api/src/campaigns/routes.ts`:

```ts
  app.post("/api/campaigns/:id/launch", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);

    const blockers = await launchBlockers(pool, tenantId, id);
    if (blockers.includes("campaign not found")) {
      throw new HttpError(404, "campaign not found");
    }
    if (blockers.length > 0) {
      return reply.status(409).send({ error: "campaign is not ready", blockers });
    }

    // Only draft and paused may start; relaunching a running campaign would
    // double-dial nothing but is still a mistake worth refusing.
    const moved = await setCampaignStatus(
      pool,
      tenantId,
      id,
      ["draft", "paused"],
      "running",
    );
    if (!moved) throw new HttpError(409, "campaign is not in a launchable state");

    return findCampaign(pool, tenantId, id);
  });

  app.post("/api/campaigns/:id/pause", async (request) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);

    const moved = await setCampaignStatus(pool, tenantId, id, ["running"], "paused");
    if (!moved) throw new HttpError(409, "only a running campaign can be paused");

    return findCampaign(pool, tenantId, id);
  });
```

Add the imports at the top of that file:

```ts
import { launchBlockers } from "./service.js";
import { setCampaignStatus } from "./queries.js";
```

- [ ] **Step 7: Implement the admin number routes**

`console/api/src/numbers/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requirePlatformAdmin } from "../auth/middleware.js";
import type { Pool } from "../db/client.js";
import { listTenants } from "../tenants/queries.js";
import { findNumber, insertNumber, listNumbers, updateNumber } from "./queries.js";

const createSchema = z.object({
  e164: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  telnyxNumberId: z.string().min(1).nullable().default(null),
  tenantId: z.string().uuid().nullable().default(null),
  maxConcurrent: z.number().int().min(1).max(10).default(1),
});

const updateSchema = z.object({
  status: z.enum(["active", "paused", "released"]).optional(),
  tenantId: z.string().uuid().nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(10).optional(),
});

const idSchema = z.object({ id: z.string().uuid() });

export function registerNumberRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  app.get("/api/admin/numbers", async (request) => {
    requirePlatformAdmin(request);
    return listNumbers(pool);
  });

  app.post("/api/admin/numbers", async (request, reply) => {
    requirePlatformAdmin(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid number payload");

    try {
      const number = await insertNumber(pool, parsed.data);
      return reply.status(201).send(number);
    } catch (error) {
      if (String(error).includes("phone_numbers_e164_key")) {
        throw new HttpError(409, `${parsed.data.e164} is already in the pool`);
      }
      throw error;
    }
  });

  app.patch("/api/admin/numbers/:id", async (request) => {
    requirePlatformAdmin(request);
    const params = idSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, "invalid number id");
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid number payload");

    const number = await updateNumber(pool, params.data.id, parsed.data);
    if (!number) throw new HttpError(404, "number not found");
    return number;
  });

  app.get("/api/admin/tenants", async (request) => {
    requirePlatformAdmin(request);
    return listTenants(pool);
  });
}
```

- [ ] **Step 8: Write the admin number test**

`console/api/test/admin-numbers.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import {
  loginAs,
  resetDatabase,
  seedTenant,
  testConfig,
  TEST_PASSWORD,
} from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

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
  await pool.query("TRUNCATE phone_numbers, number_leases, calls CASCADE");
  const tenant = await seedTenant(pool, "acme");
  memberCookie = await loginAs(app, tenant.email);

  await insertUser(pool, {
    email: "ops@example.com",
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: "platform_admin",
    tenantId: null,
  });
  adminCookie = await loginAs(app, "ops@example.com");
});

function addNumber(body: unknown, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/admin/numbers",
    headers: { cookie },
    payload: body,
  });
}

describe("admin numbers", () => {
  it("adds a number to the shared pool", async () => {
    const response = await addNumber({ e164: "+37069000001" });
    expect(response.statusCode).toBe(201);
    expect(response.json().tenantId).toBeNull();
    expect(response.json().maxConcurrent).toBe(1);
  });

  it("refuses a duplicate number", async () => {
    await addNumber({ e164: "+37069000001" });
    expect((await addNumber({ e164: "+37069000001" })).statusCode).toBe(409);
  });

  it("refuses a number that is not E.164", async () => {
    expect((await addNumber({ e164: "069000001" })).statusCode).toBe(400);
  });

  it("reports live lease usage", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    await pool.query(
      `INSERT INTO number_leases (phone_number_id, expires_at)
            VALUES ($1, now() + interval '8 minutes')`,
      [created.id],
    );
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/numbers",
      headers: { cookie: adminCookie },
    });
    expect(list.json()[0].activeLeases).toBe(1);
  });

  it("assigns a number to a tenant and back to the shared pool", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    const tenants = await app.inject({
      method: "GET",
      url: "/api/admin/tenants",
      headers: { cookie: adminCookie },
    });
    const tenantId = tenants.json()[0].id;

    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { tenantId },
    });
    expect(assigned.json().tenantId).toBe(tenantId);

    const shared = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { tenantId: null },
    });
    expect(shared.json().tenantId).toBeNull();
  });

  it("pauses a number", async () => {
    const created = (await addNumber({ e164: "+37069000001" })).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/numbers/${created.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "paused" },
    });
    expect(response.json().status).toBe("paused");
  });

  it("refuses a tenant member with 403, not 404", async () => {
    // The pool is platform infrastructure, so its existence is not a secret
    // from a signed-in operator - only its contents are off limits.
    expect((await addNumber({ e164: "+37069000002" }, memberCookie)).statusCode).toBe(
      403,
    );
  });

  it("refuses a member reading the pool", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/numbers",
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses an anonymous request with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/numbers" });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 9: Add the CLI add-number command**

Append to `console/api/src/cli/commands.ts`:

```ts
import { insertNumber } from "../numbers/queries.js";
import type { PhoneNumber } from "../numbers/queries.js";

const E164 = /^\+[1-9][0-9]{6,14}$/;

export async function addNumberCommand(
  pool: Pool,
  args: { e164: string; telnyxId: string | null; tenantSlug: string | null },
): Promise<PhoneNumber> {
  if (!E164.test(args.e164)) {
    throw new Error(`${args.e164} is not an E.164 number`);
  }

  let tenantId: string | null = null;
  if (args.tenantSlug !== null) {
    const tenant = await findTenantBySlug(pool, args.tenantSlug);
    if (!tenant) throw new Error(`no tenant with slug '${args.tenantSlug}'`);
    tenantId = tenant.id;
  }

  return insertNumber(pool, {
    e164: args.e164,
    telnyxNumberId: args.telnyxId,
    tenantId,
    maxConcurrent: 1,
  });
}
```

In `console/api/src/cli/index.ts`, add `"telnyx-id": { type: "string" }` to the
options, this case to the switch, and the usage line:

```ts
      case "add-number": {
        if (!values.e164) throw new Error("--e164 is required");
        const number = await addNumberCommand(pool, {
          e164: values.e164,
          telnyxId: values["telnyx-id"] ?? null,
          tenantSlug: values.tenant ?? null,
        });
        console.log(
          `added ${number.e164} (${number.tenantSlug ?? "shared pool"})`,
        );
        break;
      }
```

Add `e164: { type: "string" }` to the options object and this line to `USAGE`:

```
  cli add-number --e164 <+E164> [--telnyx-id <id>] [--tenant <slug>]
```

- [ ] **Step 10: Register the new routes**

In `console/api/src/app.ts`:

```ts
import { registerCallRoutes } from "./calls/routes.js";
import { registerNumberRoutes } from "./numbers/routes.js";
```

```ts
  registerCallbackRoutes(app, deps);
  registerCallRoutes(app, deps);
  registerNumberRoutes(app, deps);
```

- [ ] **Step 11: Add isolation cases**

Append inside the `describe("tenant isolation")` block in
`console/api/test/tenant-isolation.test.ts`:

```ts
  it("returns an empty call list for another tenant's campaign", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/calls`,
      headers: { cookie: globexCookie },
    });
    expect(response.json()).toEqual([]);
  });

  it("returns 404 rather than launching another tenant's campaign", async () => {
    // launchBlockers reports "campaign not found", which the route turns into
    // a 404 - never a 409, which would confirm the campaign exists.
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/launch`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("leaves another tenant's campaign as a draft after a refused launch", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/launch`,
      headers: { cookie: globexCookie },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.json().status).toBe("draft");
  });
```

- [ ] **Step 12: Run everything**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green. `campaign-launch` is 13 tests, `admin-numbers` is 9,
`tenant-isolation` is now 15.

---

### Task 10: Campaign detail screen

**Files:**
- Modify: `console/web/src/api/campaigns.ts` (calls, progress, launch, pause, retry hooks)
- Create: `console/web/src/routes/CampaignDetail.tsx`
- Create: `console/web/src/components/OutcomeBadge.tsx`
- Modify: `console/web/src/routes/CampaignWizard.tsx` (launch button on Review)
- Modify: `console/web/src/routes/Campaigns.tsx` (link running campaigns to detail)
- Modify: `console/web/src/App.tsx`
- Test: `console/web/test/outcome-label.test.ts`

**Interfaces:**
- Consumes: the endpoints from Task 9.
- Produces:
  - `useCalls(id)`, `useProgress(id)`, `useLaunch(id)`, `usePause(id)`, `useRetry(id)`
  - `outcomeLabel(call: Call): string` - the one place an outcome becomes English.

- [ ] **Step 1: Write the failing label test**

`console/web/test/outcome-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Call } from "@console/shared";
import { outcomeLabel } from "../src/components/OutcomeBadge.js";

const base: Call = {
  id: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  e164: "+37060000001",
  externalRef: null,
  fromE164: "+37069000001",
  attempt: 1,
  status: "ended",
  outcome: "completed",
  lastStep: "done",
  hangupCause: "normal_clearing",
  createdAt: "2026-08-05T10:00:00.000Z",
  answeredAt: "2026-08-05T10:00:05.000Z",
  endedAt: "2026-08-05T10:01:00.000Z",
};

describe("outcomeLabel", () => {
  it("labels a completed survey", () => {
    expect(outcomeLabel(base)).toBe("Completed");
  });

  it("says which question an abandoned call reached", () => {
    expect(outcomeLabel({ ...base, outcome: "abandoned", lastStep: 2 })).toBe(
      "Abandoned at question 2",
    );
  });

  it("labels an abandoned call with no step at all", () => {
    expect(outcomeLabel({ ...base, outcome: "abandoned", lastStep: null })).toBe(
      "Abandoned before question 1",
    );
  });

  it("labels no answer", () => {
    expect(outcomeLabel({ ...base, outcome: "no_answer", lastStep: null })).toBe(
      "No answer",
    );
  });

  it("labels busy", () => {
    expect(outcomeLabel({ ...base, outcome: "busy", lastStep: null })).toBe("Busy");
  });

  it("labels a dial that never happened", () => {
    expect(
      outcomeLabel({ ...base, status: "failed", outcome: "failed", lastStep: null }),
    ).toBe("Failed to dial");
  });

  it("labels a lost call honestly rather than guessing", () => {
    expect(outcomeLabel({ ...base, outcome: "unknown", lastStep: null })).toBe(
      "Unknown",
    );
  });

  it("shows in-flight calls by status, not by a missing outcome", () => {
    expect(
      outcomeLabel({ ...base, status: "in_progress", outcome: null, lastStep: 1 }),
    ).toBe("In progress");
  });

  it("shows a queued call as dialing", () => {
    expect(
      outcomeLabel({ ...base, status: "dialing", outcome: null, lastStep: null }),
    ).toBe("Dialing");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/web -- outcome-label`
Expected: FAIL - cannot resolve `../src/components/OutcomeBadge.js`.

- [ ] **Step 3: Implement the badge**

`console/web/src/components/OutcomeBadge.tsx`:

```tsx
import type { Call } from "@console/shared";

export function outcomeLabel(call: Call): string {
  if (call.status === "queued" || call.status === "dialing") return "Dialing";
  if (call.status === "in_progress") return "In progress";

  switch (call.outcome) {
    case "completed":
      return "Completed";
    case "abandoned":
      return typeof call.lastStep === "number"
        ? `Abandoned at question ${call.lastStep}`
        : "Abandoned before question 1";
    case "no_answer":
      return "No answer";
    case "busy":
      return "Busy";
    case "failed":
      return "Failed to dial";
    default:
      // A lease expired without a hangup. Saying so beats inventing an outcome.
      return "Unknown";
  }
}

const TONE: Record<string, string> = {
  Completed: "bg-emerald-100 text-emerald-800",
  "No answer": "bg-slate-100 text-slate-700",
  Busy: "bg-amber-100 text-amber-800",
  "Failed to dial": "bg-red-100 text-red-800",
  Unknown: "bg-slate-100 text-slate-700",
  Dialing: "bg-blue-100 text-blue-800",
  "In progress": "bg-blue-100 text-blue-800",
};

export function OutcomeBadge({ call }: { call: Call }) {
  const label = outcomeLabel(call);
  const tone = TONE[label] ?? "bg-amber-100 text-amber-800";
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${tone}`}>{label}</span>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/web -- outcome-label`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the hooks**

Append to `console/web/src/api/campaigns.ts`:

```ts
import {
  callSchema,
  campaignProgressSchema,
  type Call,
  type CampaignProgress,
} from "@console/shared";

/** Polled while a campaign runs; 3 seconds is frequent enough to feel live. */
export const LIVE_POLL_MS = 3000;

export function useCalls(campaignId: string, live: boolean) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "calls"],
    refetchInterval: live ? LIVE_POLL_MS : false,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/calls`, {
        schema: z.array(callSchema),
      }),
  });
}

export function useProgress(campaignId: string, live: boolean) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "progress"],
    refetchInterval: live ? LIVE_POLL_MS : false,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/progress`, {
        schema: campaignProgressSchema,
      }),
  });
}

function useCampaignAction(campaignId: string, action: "launch" | "pause") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/${action}`, {
        method: "POST",
        schema: campaignSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export const useLaunch = (id: string) => useCampaignAction(id, "launch");
export const usePause = (id: string) => useCampaignAction(id, "pause");

export function useRetry(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) =>
      apiFetch(`/api/calls/${callId}/retry`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export type { Call, CampaignProgress };
```

- [ ] **Step 6: Implement the detail screen**

`console/web/src/routes/CampaignDetail.tsx`:

```tsx
import { Link, useParams } from "react-router";
import {
  useCalls,
  useCampaign,
  useLaunch,
  usePause,
  useProgress,
  useRetry,
} from "../api/campaigns.js";
import { ApiError } from "../api/client.js";
import { AppShell } from "../components/AppShell.js";
import { OutcomeBadge } from "../components/OutcomeBadge.js";

export function CampaignDetail() {
  const { id = "" } = useParams();
  const { data: campaign } = useCampaign(id);
  const live = campaign?.status === "running";
  const { data: progress } = useProgress(id, live === true);
  const { data: calls } = useCalls(id, live === true);
  const launch = useLaunch(id);
  const pause = usePause(id);
  const retry = useRetry(id);

  if (!campaign) return <AppShell>Loading</AppShell>;

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <AppShell>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
          <p className="text-sm text-slate-500">
            {campaign.questionCount} questions, {campaign.contactCount} contacts,{" "}
            {campaign.language}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/campaigns/${id}/edit`}
            className="rounded px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200"
          >
            Edit
          </Link>
          {campaign.status === "running" ? (
            <button
              onClick={() => pause.mutate()}
              className="rounded bg-amber-600 px-4 py-2 text-sm text-white"
            >
              Pause
            </button>
          ) : campaign.status !== "completed" ? (
            <button
              onClick={() => launch.mutate()}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white"
            >
              {campaign.status === "paused" ? "Resume" : "Launch"}
            </button>
          ) : null}
        </div>
      </div>

      {launch.isError && (
        <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">
          {launch.error instanceof ApiError
            ? launch.error.message
            : "Could not launch"}
        </div>
      )}

      {progress && (
        <div className="mb-6 rounded border border-slate-200 bg-white p-4">
          <div className="mb-2 flex justify-between text-sm text-slate-600">
            <span>
              {progress.done} of {progress.total} done, {progress.dialing} in
              flight, {progress.pending} waiting
            </span>
            <span>{percent}%</span>
          </div>
          <div className="h-2 w-full rounded bg-slate-100">
            <div
              className="h-2 rounded bg-slate-900 transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <table className="w-full border-collapse rounded border border-slate-200 bg-white text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Attempt</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium">Ended</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {calls?.map((call) => (
            <tr key={call.id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2 font-mono">{call.e164}</td>
              <td className="px-3 py-2 text-slate-500">{call.attempt}</td>
              <td className="px-3 py-2 font-mono text-slate-500">
                {call.fromE164 ?? ""}
              </td>
              <td className="px-3 py-2">
                <OutcomeBadge call={call} />
              </td>
              <td className="px-3 py-2 text-slate-500">
                {call.endedAt ? new Date(call.endedAt).toLocaleString() : ""}
              </td>
              <td className="px-3 py-2 text-right">
                {(call.status === "ended" || call.status === "failed") &&
                  call.outcome !== "completed" && (
                    <button
                      onClick={() => retry.mutate(call.id)}
                      disabled={retry.isPending}
                      className="text-slate-600 underline disabled:opacity-50"
                    >
                      Retry
                    </button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {calls?.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">
          No calls yet. Launch the campaign to start dialling.
        </p>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 7: Wire the route and the wizard**

In `console/web/src/App.tsx` add:

```tsx
import { CampaignDetail } from "./routes/CampaignDetail.js";
```

```tsx
          <Route
            path="/campaigns/:id"
            element={
              <RequireAuth>
                <CampaignDetail />
              </RequireAuth>
            }
          />
```

In `console/web/src/routes/Campaigns.tsx`, change the row click target from
`/campaigns/${campaign.id}/edit` to `/campaigns/${campaign.id}` - the detail
screen is now the campaign's home and links back to the editor.

In `console/web/src/routes/wizard/ReviewStep.tsx`, replace the "launching is not
available yet" note with a real launch button:

```tsx
import { useNavigate } from "react-router";
import { campaignReadiness, useLaunch } from "../../api/campaigns.js";
```

```tsx
  const launch = useLaunch(campaign.id);
  const navigate = useNavigate();
```

```tsx
      {ready ? (
        <button
          onClick={() =>
            launch.mutate(undefined, {
              onSuccess: () => void navigate(`/campaigns/${campaign.id}`),
            })
          }
          disabled={launch.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {launch.isPending ? "Launching" : "Launch campaign"}
        </button>
      ) : (
        <ul className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
```

- [ ] **Step 8: Verify the whole loop against the fake dialer**

With `DIALER=fake` in `api/.env`, start Postgres, MinIO, the API, the worker
(`npm run worker:dev`), and the Vite server. Then:

1. Add a number: `cd console/api && npm run cli -- add-number --e164 +37069000001`
2. Create a campaign, upload one question and a thank-you, import three contacts.
3. Launch it from the Review step.

Expected: the detail screen shows calls appearing one at a time - the pool has
one number, so dialling is serial. Each moves Dialing to In progress to
Completed, and the progress bar reaches 100%. Roughly one call in five shows
"Abandoned at question N", which is the fake exercising that path.

4. Click Retry on any finished call.

Expected: a second row for that number with attempt 2, and the first row
unchanged.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 11: Admin numbers screen

**Files:**
- Create: `console/web/src/api/numbers.ts`
- Create: `console/web/src/routes/AdminNumbers.tsx`
- Modify: `console/web/src/App.tsx`
- Modify: `console/web/src/components/AppShell.tsx` (admin link)

**Interfaces:**
- Consumes: `/api/admin/numbers` and `/api/admin/tenants` from Task 9.
- Produces: `useNumbers()`, `useAddNumber()`, `useUpdateNumber()`, `useTenants()`.

- [ ] **Step 1: Implement the hooks**

`console/web/src/api/numbers.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "./client.js";

export const phoneNumberSchema = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  telnyxNumberId: z.string().nullable(),
  tenantId: z.string().uuid().nullable(),
  tenantSlug: z.string().nullable(),
  maxConcurrent: z.number().int(),
  status: z.enum(["active", "paused", "released"]),
  activeLeases: z.number().int(),
  lastUsedAt: z.string().nullable(),
});
export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

const tenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export function useNumbers() {
  return useQuery({
    queryKey: ["admin", "numbers"],
    // Lease state changes as calls run, so this list is live.
    refetchInterval: 5000,
    queryFn: () =>
      apiFetch("/api/admin/numbers", { schema: z.array(phoneNumberSchema) }),
  });
}

export function useTenants() {
  return useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () =>
      apiFetch("/api/admin/tenants", { schema: z.array(tenantSchema) }),
  });
}

function useNumbersMutation<T>(fn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "numbers"] });
    },
  });
}

export function useAddNumber() {
  return useNumbersMutation((body: { e164: string; telnyxNumberId: string | null }) =>
    apiFetch("/api/admin/numbers", { method: "POST", body }),
  );
}

export function useUpdateNumber() {
  return useNumbersMutation(
    (args: {
      id: string;
      status?: "active" | "paused";
      tenantId?: string | null;
      maxConcurrent?: number;
    }) => {
      const { id, ...body } = args;
      return apiFetch(`/api/admin/numbers/${id}`, { method: "PATCH", body });
    },
  );
}
```

- [ ] **Step 2: Implement the screen**

`console/web/src/routes/AdminNumbers.tsx`:

```tsx
import { useState } from "react";
import { useAddNumber, useNumbers, useTenants, useUpdateNumber } from "../api/numbers.js";
import { ApiError } from "../api/client.js";
import { AppShell } from "../components/AppShell.js";
import { useSession } from "../auth/useSession.js";

export function AdminNumbers() {
  const { user } = useSession();
  const { data: numbers } = useNumbers();
  const { data: tenants } = useTenants();
  const addNumber = useAddNumber();
  const updateNumber = useUpdateNumber();
  const [e164, setE164] = useState("");
  const [telnyxId, setTelnyxId] = useState("");

  if (user && user.role !== "platform_admin") {
    return <AppShell>This page is for platform administrators.</AppShell>;
  }

  return (
    <AppShell>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">Number pool</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          addNumber.mutate(
            { e164, telnyxNumberId: telnyxId || null },
            { onSuccess: () => { setE164(""); setTelnyxId(""); } },
          );
        }}
        className="mb-6 flex items-end gap-3 rounded border border-slate-200 bg-white p-4"
      >
        <label className="text-sm">
          <span className="block text-slate-700">Number (E.164)</span>
          <input
            value={e164}
            onChange={(e) => setE164(e.target.value)}
            placeholder="+37069000001"
            className="mt-1 rounded border border-slate-300 px-3 py-2 font-mono"
          />
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">Telnyx id (optional)</span>
          <input
            value={telnyxId}
            onChange={(e) => setTelnyxId(e.target.value)}
            className="mt-1 rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={addNumber.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
        {addNumber.isError && (
          <span className="text-sm text-red-600">
            {addNumber.error instanceof ApiError
              ? addNumber.error.message
              : "Could not add"}
          </span>
        )}
      </form>

      <p className="mb-2 text-sm text-slate-500">
        Numbers are bought in the Telnyx portal and registered here. A number
        with no tenant is in the shared pool and any campaign may use it.
      </p>

      <table className="w-full border-collapse rounded border border-slate-200 bg-white text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Tenant</th>
            <th className="px-3 py-2 font-medium">In use</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {numbers?.map((number) => (
            <tr key={number.id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2 font-mono">{number.e164}</td>
              <td className="px-3 py-2">
                <select
                  value={number.tenantId ?? ""}
                  onChange={(e) =>
                    updateNumber.mutate({
                      id: number.id,
                      tenantId: e.target.value === "" ? null : e.target.value,
                    })
                  }
                  className="rounded border border-slate-300 px-2 py-1"
                >
                  <option value="">Shared pool</option>
                  {tenants?.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2 text-slate-600">
                {number.activeLeases} of {number.maxConcurrent}
              </td>
              <td className="px-3 py-2">{number.status}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() =>
                    updateNumber.mutate({
                      id: number.id,
                      status: number.status === "active" ? "paused" : "active",
                    })
                  }
                  className="text-slate-600 underline"
                >
                  {number.status === "active" ? "Pause" : "Activate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {numbers?.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">
          The pool is empty. Nothing can be dialled until a number is added.
        </p>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 3: Wire the route and the nav link**

In `console/web/src/App.tsx`:

```tsx
import { AdminNumbers } from "./routes/AdminNumbers.js";
```

```tsx
          <Route
            path="/admin/numbers"
            element={
              <RequireAuth>
                <AdminNumbers />
              </RequireAuth>
            }
          />
```

In `console/web/src/components/AppShell.tsx`, show the link only to platform
admins, inside the header's right-hand group and before the email:

```tsx
        {user?.role === "platform_admin" && (
          <Link to="/admin/numbers" className="underline">
            Numbers
          </Link>
        )}
```

- [ ] **Step 4: Verify by hand**

Sign in as the platform admin created in Plan 1 Task 6. Expected: the Numbers
link appears, a number can be added, assigned to a tenant, and paused, and "In
use" shows `1 of 1` while a fake call is running.

Sign in as a tenant member. Expected: no Numbers link, and visiting
`/admin/numbers` directly shows the administrators-only message.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 12: Production wiring and the first live call

**Files:**
- Modify: `console/docker-compose.prod.yml` (the `worker` service)
- Modify: `console/docker-compose.dev.yml` (nothing structural; document the fake)
- Modify: `console/.env.example`, `console/.env.prod.example`
- Modify: `console/README.md`

- [ ] **Step 1: Add the worker service**

In `console/docker-compose.prod.yml`, alongside `api`:

```yaml
  worker:
    build:
      context: .
      dockerfile: api/Dockerfile
    restart: unless-stopped
    depends_on:
      migrate: { condition: service_completed_successfully }
    environment:
      DATABASE_URL: ${DATABASE_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      S3_BUCKET: ${S3_BUCKET}
      S3_REGION: ${S3_REGION}
      WORKER_BASE_URL: ${WORKER_BASE_URL}
      WORKER_TRIGGER_SECRET: ${WORKER_TRIGGER_SECRET}
      WORKER_HMAC_SECRET: ${WORKER_HMAC_SECRET}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      DIALER: cf-worker
      NODE_ENV: production
    command: ["node", "--experimental-strip-types", "api/src/worker.ts"]
```

Add the same five worker variables to the `api` service's environment - the API
needs `WORKER_HMAC_SECRET` to verify callbacks and `PUBLIC_BASE_URL` for
config validation.

**Exactly one worker container.** Two would double the dial rate against the same
pool. The pool locking makes that safe rather than corrupting, but it is not the
intent, and scaling out is a Plan 3 concern at the earliest.

- [ ] **Step 2: Extend the env examples**

Add to `console/.env.example`:

```
WORKER_BASE_URL=https://your-worker.workers.dev
WORKER_TRIGGER_SECRET=the-same-value-as-the-worker-TRIGGER_SECRET
WORKER_HMAC_SECRET=the-same-value-as-the-worker-CONSOLE_HMAC_SECRET
PUBLIC_BASE_URL=http://localhost:3000
DIALER=fake
```

And to `console/.env.prod.example`:

```
WORKER_BASE_URL=https://your-worker.workers.dev
WORKER_TRIGGER_SECRET=match-the-worker-TRIGGER_SECRET
WORKER_HMAC_SECRET=match-the-worker-CONSOLE_HMAC_SECRET
PUBLIC_BASE_URL=https://console.example.com
DIALER=cf-worker
```

`WORKER_TRIGGER_SECRET` and `WORKER_HMAC_SECRET` must match the Worker's
`TRIGGER_SECRET` and `CONSOLE_HMAC_SECRET` exactly. A mismatch on the first
gives 401 on every dial; a mismatch on the second gives 401 on every callback,
which looks like calls that dial and then never finish.

- [ ] **Step 3: Update the README**

Replace the "Known limitations" bullet about launching with:

```markdown
## Calling

The `worker` process runs a 2-second loop: sweep expired number leases, then for
each running campaign take a free number, claim a pending contact, presign the
audio for an hour, and post to the Cloudflare Worker's `/calls`. The Worker
reports `call.answered`, `call.hangup`, and `call.recording.saved` back to
`/callbacks/worker`, signed with `WORKER_HMAC_SECRET`.

Throughput is bounded by the number pool, not by the loop. One number at
`max_concurrent: 1` means one call at a time, whatever the campaign size.

### DIALER=fake

Telnyx cannot fetch audio from MinIO on localhost, and a Cloudflare Worker
cannot POST a callback to a laptop. `DIALER=fake` substitutes a dialer that
synthesises the whole callback sequence, so dispatch, leasing, outcome
derivation, and the UI all run locally. It is the default in `.env.example`.

Placing a genuinely live call from a development machine needs a public tunnel
for `PUBLIC_BASE_URL` and a real S3 bucket for the audio. That is a deliberate
gap, not an oversight.
```

- [ ] **Step 4: Deploy and verify without dialling**

Deploy the console, then confirm the callback path is reachable and the
signature check is live:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://console.example.com/callbacks/worker \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: `401`. A 404 means Caddy is not routing `/callbacks/*`; a 200 means
the signature check is not running and must be fixed before going further.

- [ ] **Step 5: Ask the operator before the first live call**

**Stop here and ask.** The next step dials a real phone and bills the operator's
Telnyx account. Do not run it unprompted.

When they agree, set up a one-contact campaign against a number they control:
one question, a thank-you, one contact, `DIALER=cf-worker`, and one number in
the pool.

- [ ] **Step 6: Place the call and watch both sides**

Run `npx wrangler tail` in `cf-worker/` and `docker compose -f
docker-compose.prod.yml logs -f worker api` on the box, then launch the campaign.

Expected sequence:

| Where | What |
|---|---|
| console worker | `dispatch_tick` with `dialled: 1` |
| wrangler tail | `webhook` `call.answered`, then `command_sent` for `record_start`, `streaming_start`, `playback_start` |
| console api | callback `call.answered`, call row moves to `in_progress` |
| wrangler tail | `stream_open`, `vad_armed`, `answer_ended` per question |
| wrangler tail | `webhook` `call.hangup` |
| console api | callback `call.hangup` with `step: "done"`, outcome `completed` |
| console UI | the call shows Completed and the number's lease is released |

If the call dials but never completes, the usual cause is a
`WORKER_HMAC_SECRET` mismatch - check for `callback_rejected` with status 401 in
`wrangler tail`.

- [ ] **Step 7: Confirm the number is free again**

Check the admin numbers screen. Expected: `0 of 1` in use, and a second launch
dials again.

---

## Plan self-review

Checked against `docs/superpowers/specs/2026-08-04-console-design.md`, Plan 2
scope:

| Spec requirement | Task |
|---|---|
| Worker accepts `from`, falls back to `TELNYX_FROM_NUMBER` | 2 |
| Worker accepts `callbackUrl`, rides the webhook query string | 2 |
| Worker handles `call.recording.saved` | 2 |
| HMAC-signed callbacks through `ctx.waitUntil` | 1, 2 |
| Number pool with `SKIP LOCKED` and its concurrency suite | 3, 4 |
| Lease expiry sweeper | 4, 8 |
| Dispatcher loop, 2-second tick | 8 |
| `DialerProvider` with both implementations | 7 |
| Callback endpoint with HMAC verification | 6 |
| Call state machine and outcome derivation | 5, 6 |
| Campaign detail UI with live progress | 10 |
| Manual retry | 9, 10 |
| Admin number management | 9, 11 |
| Production `worker` service | 12 |

Deferred to Plan 3 and named in the tasks that touch them: the `recordings`,
`transcripts`, and `jobs` tables; the `call.recording.saved` branch in
`callbacks/routes.ts` logs and returns rather than enqueuing ingest.

