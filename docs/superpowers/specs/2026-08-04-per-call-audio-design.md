# Per-Call Audio Manifest — Design

Date: 2026-08-04
Status: Approved, not yet implemented.

## Problem

Audio ships as Worker static assets at four fixed paths (`q1.mp3`, `q2.mp3`,
`q3.mp3`, `thanks.mp3`), so every call plays the same recordings and changing one
requires a redeploy. The system is becoming multi-tenant: different customers
supply their own recordings, and calls are placed on their behalf. Audio must
therefore be chosen per call.

## Scope

In scope:

- `POST /calls` accepts a per-call audio manifest of question URLs plus a
  thank-you URL.
- Variable question count per call, 1 to 10.
- Validation of manifest structure and, where detectable, pre-signed URL expiry.
- Delivering the manifest to the Durable Object, which is what issues every
  playback after the first.

Out of scope:

- Tenant identity, per-tenant credentials, quotas, and rate limiting. See the
  trust boundary below.
- Audio storage, upload, and signing. The backend owns these.
- Tenant ownership of recordings produced by `record_start`. Recording behaviour
  is unchanged.

## Trust boundary

A backend under the operator's control authenticates the tenant, looks up their
recordings, signs the URLs, and calls `POST /calls` with a ready-made manifest.
The Worker stays tenant-agnostic and keeps its single `TRIGGER_SECRET`.

Tenants never call the Worker directly. Doing so would require a tenant registry,
per-tenant secrets, and quotas, which is a separate project.

## The contract

```json
{
  "to": "+37060000000",
  "silenceMs": 2500,
  "audio": {
    "questions": ["https://bucket.s3.amazonaws.com/t1/q1.mp3?X-Amz-...", "..."],
    "thanks": "https://bucket.s3.amazonaws.com/t1/thanks.mp3?X-Amz-..."
  }
}
```

`audio` is required. There is no fallback to the bundled placeholder files: in a
multi-tenant system a silent fallback means a tenant's recipient hears three
seconds of nothing while the operator sees a success. The bundled files in
`public/audio/` are no longer reachable by the flow.

`to` and `silenceMs` are unchanged.

### Validation

Rejected with 400 and **no dial**:

- `audio` absent, or not an object.
- `questions` absent, not an array, empty, or longer than 10.
- Any entry in `questions`, or `thanks`, that is not a string parseable as a URL
  with the `https:` protocol. `http:` is rejected outright — Telnyx needs public
  HTTPS regardless, and a pre-signed URL sent in clear text leaks its own
  signature.
- `thanks` absent.
- A pre-signed URL with insufficient remaining lifetime (below).

### Expiry validation

Telnyx fetches each `audio_url` at the moment it plays, so `thanks.mp3` is
fetched last and latest. A URL valid at dial time can expire before it is needed.

If a URL carries both `X-Amz-Date` and `X-Amz-Expires` query parameters it is
treated as SigV4 pre-signed and checked. `X-Amz-Date` is ISO8601 basic format
(`YYYYMMDDTHHMMSSZ`) and must be parsed explicitly — `Date.parse` does not handle
it reliably:

```
/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/  ->  Date.UTC(...)
expiresAt = signedAt + Number(X-Amz-Expires) * 1000
```

A URL missing either parameter is treated as opaque and accepted unchanged, so
plain public URLs and non-S3 hosts keep working without special-casing.

Required runway is computed from the manifest rather than being a flat constant,
so a ten-question survey is checked properly and a one-question survey is not
over-rejected:

```
RING_ALLOWANCE_MS     = 60_000
PLAYBACK_ALLOWANCE_MS = 10_000   // per file, generous
MAX_ANSWER_MS         = 30_000   // existing, from flow.ts
MARGIN_MS             = 60_000

required = RING_ALLOWANCE
         + questions.length * (MAX_ANSWER_MS + PLAYBACK_ALLOWANCE)
         + PLAYBACK_ALLOWANCE          // the thank-you
         + MARGIN
```

Three questions requires 4 minutes; ten requires under 9. Against the agreed
60-minute signing TTL this is enormous headroom by design. The check exists to
catch a backend that signed for five minutes by mistake, not to run close to the
line.

## Architecture

The load-bearing fact: **the Durable Object, not `decide()`, issues every
playback after the first.** `decide()` handles `call.answered` and the final
hangup; the DO drives question to question. The manifest must therefore reach the
DO, and today the only audio-locating value that does is `origin`, on the
stream_url query string.

```
POST /calls
  validate manifest ─── 400 ──> no dial
  createCall() ──> call_control_id
  sessionFor(ccid).fetch("/init", POST manifest)
      DO: storage.put("manifest", ...)
  ──> 200 { call_control_id, silenceMs }

call.answered webhook
  sessionFor(ccid).fetch("/manifest") ──> manifest
  decide({ ..., audio: manifest })
      ──> record_start, streaming_start, playback questions[0]

answer ends (inside the DO)
  nextAfterAnswer(manifest, answeredStep) ──> questions[N] or thanks

call.hangup webhook
  sessionFor(ccid).fetch("/end") ──> storage.deleteAll()
```

The DO is seeded by key `idFromName(call_control_id)`, the same derivation the
webhook and media-stream routing already use, so no new addressing scheme is
introduced.

### Why the Durable Object gains storage

The DO currently holds everything in memory and ignores its `DurableObjectState`.
That is no longer safe. Between the dial and `call.answered` there are 5 to 30
seconds of ring time during which the object has no active connection and can be
evicted. An in-memory manifest would be lost exactly when a slow-to-answer call
needs it. The constructor loads the manifest through `blockConcurrencyWhile` so a
woken object has it before handling any request.

`/end` exists solely so per-call manifests do not accumulate in DO storage
indefinitely.

### Approaches rejected

**Manifest in the stream_url query string.** Follows the existing `silenceMs`
pattern and needs no storage. Rejected on data: SigV4 pre-signed URLs run 800 to
1500 characters, so eleven of them is a roughly 9KB URL handed to Telnyx as a
WebSocket target. The existing pattern works for `silenceMs` because it is four
digits.

**KV or D1 keyed by call_control_id.** KV is disqualified on correctness — it is
eventually consistent, and this is a write-then-read-seconds-later pattern, which
is precisely where that bites. D1 would work but adds a binding and a schema to
store something whose lifetime is one call and whose natural owner is already the
DO.

**Manifest in `client_state`.** Telnyx echoes it on every webhook, but it is
size-limited and the URLs are long. Rejected.

## Module changes

### New: `src/manifest.ts`

Pure. Parsing and validation only, no network and no clock beyond an injectable
`nowMs`.

```ts
export interface AudioManifest {
  questions: string[];
  thanks: string;
}

export type ManifestError = { field: string; reason: string };

export function parseManifest(
  value: unknown,
  nowMs?: number,
): { manifest: AudioManifest } | { error: ManifestError };
```

`nowMs` is injectable purely so expiry tests can control the clock, matching the
existing convention in `verify.ts`.

### `src/flow.ts`

`decide()` stops deriving audio URLs and takes them as input. `originUrl` stays —
it is still needed to build the `ws://` stream URL — but is no longer an audio
concern.

```ts
export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  originUrl: string;              // stream_url only
  audio?: AudioManifest;          // required for call.answered, unused otherwise
  silenceMs?: number | string | null;
}

export function question(audio: AudioManifest, step: number): Command | null;
export function nextAfterAnswer(
  audio: AudioManifest,
  answeredStep: number,
): Command | null;
```

`audio` is optional so `index.ts` only pays for the DO round-trip on
`call.answered`; every other event skips it. `decide()` returns `[]` if
`call.answered` arrives without a manifest, and likewise returns `[]` — emitting
neither `record_start` nor `streaming_start` — if `question(audio, 1)` returns
`null`. Validation guarantees at least one question, so this is unreachable in
practice, but a call with recording and streaming started and no audio to play is
worse than no call at all.

`question` and `nextAfterAnswer` return `Command | null` rather than asserting.
With `noUncheckedIndexedAccess` enabled, `questions[step - 1]` is
`string | undefined`, and the project rule is not to widen types to make a build
pass. `null` means the step is out of range; the DO logs and ignores it.

`QUESTION_COUNT` is deleted. The audio-URL helpers `audioUrl()` and the
`q${step}.mp3` construction are deleted with it.

### `src/state.ts`

`Step` becomes `number | "done"`. `decodeState` accepts `"done"` or an integer in
`1..10`, rejecting `0`, `-1`, `11`, `1.5`, and `"3"`. `MAX_QUESTIONS = 10` is
introduced as the validation bound and shared with `manifest.ts`.

### `src/session.ts`

- Holds `manifest: AudioManifest | null`, loaded in the constructor via
  `blockConcurrencyWhile`.
- New routes: `POST /init` (store), `GET /manifest` (read back, 404 when the
  object holds no manifest), `POST /end` (`storage.deleteAll()`).
- `handleArm` replaces `step !== 1 && step !== 2 && step !== 3` with a bounds
  check against `manifest.questions.length`, which is where that validation now
  belongs. A null manifest is itself a 400 — arming an object that was never
  seeded is a bug, not a recoverable state.
- `advance()` calls `nextAfterAnswer(this.manifest, answeredStep)`.
- The `origin` field is deleted. Its only use was building audio URLs.

### `src/index.ts`

- `handleCreateCall` validates the manifest before dialling, then seeds the DO
  after `createCall` returns.
- `handleWebhook` fetches the manifest from the DO only when the event is
  `call.answered`, and calls `/end` on `call.hangup`.
- `withCallId()` no longer attaches `origin` to the stream URL, only `ccid`.

## Error handling

| Condition | Response |
|---|---|
| Manifest absent, malformed, non-https, or over 10 questions | 400 naming the field, no dial |
| Pre-signed URL with insufficient runway | 400 naming the URL and its expiry, no dial |
| `/init` seeding fails after the dial | Hang up the call, 502 |
| `call.answered` and the DO has no manifest | Log, hang up |
| `/arm` step outside `1..questions.length` | 400 from the DO, logged |
| Playback fails mid-call because a URL expired anyway | Existing path: `command_failed`, best-effort hangup |

Seeding happens after the dial because the `call_control_id` does not exist until
then. If `/init` fails the Worker hangs up the call it just placed. Briefly
dialling and then dropping is the correct failure — the alternative is a live
call with no audio.

The always-200 invariant on the webhook route is untouched: a non-2xx makes
Telnyx retry and double-advance the flow.

## Testing

New, pure, in `test/manifest.test.ts`: valid manifest; `audio` missing; `http:`
rejected; unparseable URL; empty `questions`; 11 entries; `thanks` missing; an
expired SigV4 URL; a short-TTL URL against the computed floor; a boundary case
just inside the floor; a non-S3 opaque URL accepted unchanged; malformed
`X-Amz-Date` treated as opaque rather than throwing.

`test/flow.test.ts` gains variable-count coverage: one question, ten questions,
`thanks` after the last, and out-of-range steps returning `null`.

`test/state.test.ts` widens to the new step range and its rejections.

`test/index.test.ts` covers 400-with-no-dial, seeding failure hanging up and
returning 502, and `call.answered` fetching the manifest and playing
`questions[0]`.

### Accepted risk

`session.ts` remains untested. It gains persistent storage, three routes, and a
bounds check in this change, all of which will be verified only by placing a real
call. Adding `@cloudflare/vitest-pool-workers` was considered and declined to
keep the diff and the suite small. This is a known and growing gap: the DO now
owns per-call state that no automated test exercises.

## Live verification

Three things cannot be checked without a real call and must be confirmed first:

1. **The `call_control_id` returned by `createCall` is the same one the webhooks
   carry.** The whole seeding design depends on it. Nothing in the current code
   relies on this, so it is the first thing to verify.
2. The DO survives ring time with the manifest intact — verify on a call left
   ringing for 20 seconds or more before answering.
3. A pre-signed URL still resolves when `thanks.mp3` plays at the end of a
   long survey.

Watch `stream_open`, `vad_armed`, and `answer_ended` in `wrangler tail` as usual.

## Known limitations

- A URL valid at dial can still expire mid-call. Validation shrinks this window
  but cannot close it; the computed runway check is what keeps it from being a
  live concern.
- Manifests are held per call in DO storage and cleaned on `call.hangup`. A call
  that never produces a hangup webhook leaves its manifest behind.
- The bundled `public/audio/` placeholders become unreachable by the flow. They
  are left in the repo but nothing plays them.
