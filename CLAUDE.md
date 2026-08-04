# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that places an outbound Telnyx call and drives a scripted
voice survey: play a question, wait for the caller to stop talking, play the
next, then a thank-you and hangup. The whole call is recorded dual-channel by
Telnyx.

The audio is supplied per call (1 to 10 questions plus a thank-you) as HTTPS
URLs on `POST /calls`, so the system is multi-tenant: a backend authenticates
the tenant, signs their recordings, and passes the manifest. The Worker itself
is tenant-agnostic and keeps a single `TRIGGER_SECRET`.

All code lives in `cf-worker/`. The repo root holds only that directory and
`docs/`.

## Commands

Run everything from `cf-worker/`, not the repo root.

    npm test                            # vitest run, all 6 suites
    npm run test:watch
    npx vitest run test/vad.test.ts     # a single file
    npx vitest run -t "silence"         # a single test by name
    npm run typecheck                   # tsc --noEmit
    npm run deploy                      # wrangler deploy
    npx wrangler tail                   # live logs; the only way to debug a real call

Node 20+ is required — the tests generate Ed25519 keypairs via `crypto.subtle`.

## Architecture

Two brains, and knowing which one owns a decision is the thing that makes this
codebase legible.

**The Worker (`src/index.ts` + `src/flow.ts`) is stateless.** `decide()` is a
pure function mapping one webhook to a list of Telnyx commands. It handles
exactly two situations: `call.answered` (start recording, open the media stream,
play q1) and `call.playback.ended` at `step: "done"` (hangup). Everything else
returns `[]`.

**The Durable Object (`src/session.ts`) owns the call in progress.** It holds the
media WebSocket and decides when an answer has ended, because silence is only
observable by watching a live stream over time. It — not `decide()` — issues the
command that moves question N to question N+1.

The handoff between them:

0. `POST /calls` validates the manifest, dials, then seeds the manifest into
   `CALL_SESSIONS.idFromName(ccid)` — the ccid returned by `createCall`. This
   happens before the call is answered.
1. `decide()` emits `streaming_start` on `call.answered` with a placeholder
   `stream_url`. It cannot build the real URL because it has no access to the
   `call_control_id`.
2. `withCallId()` in `index.ts` rewrites that URL with `?ccid=`.
3. Telnyx opens a WebSocket to `/stream?ccid=...`. The Worker routes it to
   `CALL_SESSIONS.idFromName(ccid)` — the same derivation used for webhooks, so
   audio and webhooks land on the same object.
4. When a question finishes playing, the Worker fetches `/arm?step=N` on that
   object. **This is the only trigger that starts voice detection.** Frames
   arrive continuously; before arming, `step === 0` and they are discarded.
5. The object hears silence, calls `nextAfterAnswer()` from `flow.ts`, and sends
   the next `playback_start` itself.

`src/vad.ts` is pure maths — mu-law decode, mean absolute amplitude, and the
silence decision — so the whole detection algorithm is unit testable without a
call. `observeFrame()` takes `now` as an argument; media frames arrive every
~20ms and double as the clock, so there are no timers anywhere.

`src/state.ts` encodes `{ step: 1 | 2 | 3 | "done" }` as base64 into Telnyx's
`client_state`, which is echoed back on every subsequent webhook for that call.
`decodeState` never throws; it returns `null` for anything malformed.

### Non-obvious constraints

- **Always return 200 from the webhook route.** A non-2xx makes Telnyx retry,
  which re-issues commands and double-advances the flow.
- **Verify the signature against the raw body string.** Parsing and
  re-serializing the JSON changes the bytes and breaks Ed25519 verification.
  `index.ts` reads `request.text()` once and passes that same string to both the
  verifier and `JSON.parse`.
- **`stream_track: "inbound_track"`** means only the caller's audio reaches the
  VAD. Our own playbacks are on the outbound track and can never be mistaken for
  the caller speaking.
- **`step: "done"` is the only thing distinguishing the thank-you playback from a
  question playback** — both arrive as `call.playback.ended`.
- **The Durable Object persists only the audio manifest.** VAD state stays in
  memory; the manifest goes to storage because it is seeded before the call is
  answered, and ring time is long enough for an idle object to be evicted. The
  constructor reloads it through `blockConcurrencyWhile`. `/end` wipes it on
  `call.hangup` so manifests do not accumulate.
- **Only `call.answered` reads the manifest back from the DO.** Every other
  event skips that round-trip, which is why `FlowInput.audio` is optional.
- `advancing` guards against issuing the next question twice for one answer.
- `sendCommand()` returns the response body rather than discarding it. A Telnyx
  2xx only means the command was accepted, not that the underlying engine
  started — see the dead ends below.

### Configuration

`audio` is required on every call: `{ questions: string[], thanks: string }`,
1 to 10 questions, `https:` only. There is no fallback to the bundled
placeholders — in a multi-tenant system a silent fallback means a recipient
hears nothing while the operator sees a success.

`silenceMs` (default 2500, accepted 500-10000, anything else silently falls back)
is chosen per call in the `POST /calls` body and travels to both the webhook and
the media socket on their query strings. There is no language setting — nothing
here transcribes speech, it only measures loudness.

`manifest.ts` computes how much life a pre-signed URL needs from the question
count (`60s ring + n × 40s + 10s + 60s margin`) rather than using a flat floor.
SigV4 URLs carry `X-Amz-Date` and `X-Amz-Expires`, so expiry is checked locally
with no AWS credentials; anything without both is treated as opaque and accepted.

`SPEECH_THRESHOLD` in `vad.ts` (700, on the 0..32768 PCM scale) is the tuning
knob. If a call never advances, background noise is holding the answer open;
raise it. Too high degrades safely — the answer ends at the 30s `MAX_ANSWER_MS`
cap rather than misbehaving. Watch `stream_open`, `vad_armed`, and `answer_ended`
in `wrangler tail`.

Five secrets, all set via `wrangler secret put`, never in `wrangler.jsonc`:
`TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CONNECTION_ID`,
`TELNYX_FROM_NUMBER`, `TRIGGER_SECRET`.

`wrangler.jsonc` uses `new_sqlite_classes` (not `new_classes`) because
SQLite-backed Durable Objects are the variant available on the Workers free plan.
Wrangler is pinned to `^4` because top-level `assets` config is not stable
before 3.91.

## Telnyx dead ends — do not retry these

Both were implemented and failed against a live number. The evidence is in
`docs/superpowers/specs/2026-08-03-telnyx-voice-survey-design.md`.

- **`gather_using_ai` with `greeting` omitted.** It is a conversational LLM
  assistant, not a silence detector. Omitting `greeting` suppresses only its
  opening line; it still spoke its own follow-up questions in TTS
  (`Telnyx.KokoroTTS.af`) and returned `422 AI Assistant is already in progress`
  when the flow tried to advance. Also billed at AI rates.
- **`transcription_start`.** Returned 200 and then emitted no `call.transcription`
  events at all, across several engine configurations.

Media streaming depends on neither subsystem.

## The docs directory is stale

`docs/superpowers/specs/` and `docs/superpowers/plans/` describe the two
abandoned approaches above, not the shipped code. The plan in particular contains
full source listings for a `gather_using_ai` implementation that no longer
exists. Read them for the *reasoning* and the live-call evidence; read `src/` for
what the system does. `cf-worker/README.md` is current.

## Testing

117 tests across 7 files, all pure — no Telnyx credentials and no Workers
runtime. `flow.ts`, `vad.ts`, `state.ts`, `verify.ts`, `telnyx.ts`, and
`manifest.ts` are all covered; `index.ts` is tested by stubbing global `fetch`
and signing webhooks with a generated keypair.

`session.ts` has no unit tests — the Durable Object needs a Workers pool that
vitest is not configured with. This was a deliberate call, and it is now the
largest gap in the suite: `session.ts` owns persistent storage and four routes
(`/init`, `/manifest`, `/end`, `/arm`). What *is* covered is the Worker side of
that boundary — `index.test.ts` stubs `CALL_SESSIONS` and asserts seeding,
manifest read-back, the 502-on-seed-failure path, and `/end` on hangup. What is
not covered is the storage round-trip and the `blockConcurrencyWhile` reload.
If you change `session.ts`, verification means a real call.

## Working conventions

- TypeScript strict, with `noUncheckedIndexedAccess`. Do not widen types to make
  a build pass.
- No emojis in source or docs.
- **Git is read-only.** Use it for `log`, `status`, `diff`, `ls-files`. Never
  run `git commit`, `git add`, or `git checkout -b` — the operator manages the
  whole history, and work happens directly on `main`. Superpowers plans include
  commit steps; skip them.
- `public/audio/` still holds four silent placeholders, but **nothing plays
  them** — audio arrives per call as HTTPS URLs. Telnyx fetches them at the
  moment each one plays, so they must be publicly reachable and outlive the
  call.
- Placing a call from PowerShell: `curl` is an alias for `Invoke-WebRequest` and
  rejects `-H`. Use `Invoke-RestMethod` or `curl.exe`. The README has both forms.
- Never trigger a real call without asking the operator — it dials a real phone
  and bills their Telnyx account.
