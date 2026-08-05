# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An automated voice survey platform, in two deployables that are deliberately
unalike.

**`cf-worker/`** is a Cloudflare Worker that places an outbound Telnyx call and
drives a scripted survey: play a question, wait for the caller to stop talking,
play the next, then a thank-you and hangup. The whole call is recorded
dual-channel by Telnyx. The audio is supplied per call (1 to 10 questions plus a
thank-you) as HTTPS URLs on `POST /calls`. The Worker is tenant-agnostic and
keeps a single `TRIGGER_SECRET`; it knows how to run one call and nothing else.

**`console/`** is the multi-tenant application around it: tenants log in, build
a campaign from audio files and a contact list, launch it against a shared
caller-ID pool, and watch the calls land. It runs on one EC2 instance under
Docker Compose — Fastify API, React SPA, Postgres, Caddy — and owns everything
the Worker does not: accounts, campaigns, contacts, the number pool, recording
ingest, and transcription.

They share exactly two secrets and an HTTPS boundary, which is what makes it
reasonable to deploy them to different clouds. `README.md` at the repo root has
the full manual deployment procedure for both, plus S3, IAM, EC2 and DNS.

## Commands

Two npm projects, neither at the repo root. `cf-worker/` is plain npm;
`console/` is npm workspaces (`api`, `web`, `packages/shared`).

From `cf-worker/`:

    npm test                            # vitest run, all 8 suites
    npm run test:watch
    npx vitest run test/vad.test.ts     # a single file
    npx vitest run -t "silence"         # a single test by name
    npm run typecheck                   # tsc --noEmit
    npm run deploy                      # wrangler deploy
    npx wrangler tail                   # live logs; the only way to debug a real call

Node 20+ is required — the tests generate Ed25519 keypairs via `crypto.subtle`.

From `console/` (Node 24.11.0, pinned in `.nvmrc`):

    npm run dev                         # the whole stack in Docker, detached
    npm run dev:logs                    # follow api, worker, web
    npm run dev:down                    # stop, keeping the volumes
    npm run dev:cli -- create-tenant --name "Acme" --slug acme
    npm test                            # vitest across all three workspaces
    npm run typecheck

`npm test` in `console/` needs Postgres and MinIO up — run `npm run dev` first.
The tests run on the host, not in a container, so they also need `npm install`
and the right Node version. The `prod:*` scripts are the same commands against
`docker-compose.prod.yml` and `.env.prod`; do not run them locally.

## Architecture

### The call engine (`cf-worker/`)

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

### Worker configuration

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

Six secrets, all set via `wrangler secret put`, never in `wrangler.jsonc`:
`TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CONNECTION_ID`,
`TELNYX_FROM_NUMBER`, `TRIGGER_SECRET`, `CONSOLE_HMAC_SECRET`.

`wrangler.jsonc` uses `new_sqlite_classes` (not `new_classes`) because
SQLite-backed Durable Objects are the variant available on the Workers free plan.
Wrangler is pinned to `^4` because top-level `assets` config is not stable
before 3.91.

`from` and `callbackUrl` are optional per call. `from` overrides
`TELNYX_FROM_NUMBER` for one call, which is how the console drives a caller-ID
pool from outside. `callbackUrl` must be https; the Worker POSTs
`call.answered`, `call.hangup` and `call.recording.saved` to it, signed with
`CONSOLE_HMAC_SECRET` over `${timestamp}.${rawBody}`. Delivery is fire and
forget through `ctx.waitUntil` — a console that is down can never stop this
Worker returning 200 to Telnyx.

### The console (`console/`)

Three workspaces and two processes from one image.

- `api/src/server.ts` — Fastify. Serves `/api/*` for the SPA and
  `/callbacks/worker` for the Cloudflare Worker. Raw SQL over `pg`, no ORM.
- `api/src/worker.ts` — a second process, and the one that actually makes calls.
  It runs two loops: `startDispatcher` (every 2 seconds: sweep expired number
  leases, then per running campaign take a free number, claim a pending
  contact, presign the audio for an hour, POST the Worker's `/calls`) and
  `startRunner`, which drains the `jobs` table.
- `web/` — React 19 and Vite 8, built to static files and served by Caddy. There
  is no Node process for the frontend in production.
- `packages/shared/` — zod schemas used by both. It is compiled into the dev
  images, not watched, so editing it needs a service restart.

Things that are easy to get wrong here:

- **Exactly one `worker` container.** Two would double the dial rate against the
  same pool. The row locking makes that safe rather than corrupting, but it is
  not the intent.
- **Throughput is bounded by the number pool, not the loop.** One number at
  `max_concurrent: 1` is one call at a time, whatever the campaign size.
- **Ingest order is load-bearing and tested**: download the mp3 from Telnyx,
  upload to S3, and only then delete it at Telnyx. A job that dies between the
  last two steps finishes correctly on retry because each stage is skipped if
  already done. A failed ingest must never destroy the only copy of a call.
- **Nothing transcribes automatically** — transcription is billed per minute. A
  button enqueues one job per ingested recording with no transcript from the
  current engine, so changing that constant re-does the back catalogue once.
- **`DIALER=fake`** substitutes a dialer that synthesises the whole callback
  sequence. It is the default in `docker-compose.dev.yml`, because Telnyx cannot
  fetch audio from a local MinIO and a Worker cannot POST a callback to a
  laptop. Its `call.recording.saved` points at `https://fake.invalid/`, so
  ingest jobs fail with a DNS error and retry — that is expected, and exercises
  the backoff path.
- **`.env.prod`, never `.env`.** Compose reads `.env` for *both* compose files,
  so a production value there silently reconfigures `npm run dev` — starting
  with `DIALER=cf-worker`, which dials real phones.
- **In production there are no AWS keys.** `src/s3.ts` configures no
  credentials at all and the SDK picks up the EC2 instance role; `S3_ENDPOINT`
  exists only to point at MinIO locally, and setting it in production would send
  traffic somewhere wrong.
- `WORKER_TRIGGER_SECRET` and `WORKER_HMAC_SECRET` must equal the Worker's
  `TRIGGER_SECRET` and `CONSOLE_HMAC_SECRET`. A mismatch on the first gives 401
  on every dial; on the second, 401 on every callback, which presents as calls
  that dial and then never finish.
- The Vite dev server proxies `/api` to port 3000, so the session cookie is
  same-origin and **there is no CORS configuration anywhere**. Keep it that way.

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

## The docs directory is partly stale

`docs/superpowers/` holds the specs and plans for both halves. Read all of them
for the *reasoning*; read `src/` for what the system does.

`2026-08-03-telnyx-voice-survey-design.md` and its plan describe the two
abandoned approaches above, not the shipped code — the plan in particular
contains full source listings for a `gather_using_ai` implementation that no
longer exists. The console specs and plans (`2026-08-04-*`, `2026-08-05-*`) are
much closer to what shipped, but they are still historical documents, not
maintained ones.

The three READMEs are current: `README.md` at the root (overview and the whole
manual deployment procedure), `cf-worker/README.md`, and `console/README.md`.

## Testing

`cf-worker/`: 140 tests across 8 files, all pure — no Telnyx credentials and no
Workers runtime. `flow.ts`, `vad.ts`, `state.ts`, `verify.ts`, `telnyx.ts`,
`callback.ts` and `manifest.ts` are all covered; `index.ts` is tested by
stubbing global `fetch` and signing webhooks with a generated keypair.

`session.ts` has no unit tests — the Durable Object needs a Workers pool that
vitest is not configured with. This was a deliberate call, and it is now the
largest gap in that suite: `session.ts` owns persistent storage and four routes
(`/init`, `/manifest`, `/end`, `/arm`). What *is* covered is the Worker side of
that boundary — `index.test.ts` stubs `CALL_SESSIONS` and asserts seeding,
manifest read-back, the 502-on-seed-failure path, and `/end` on hangup. What is
not covered is the storage round-trip and the `blockConcurrencyWhile` reload.
If you change `session.ts`, verification means a real call.

`console/`: 28 API suites and 4 web suites. The API ones talk to a real Postgres
and a real MinIO rather than mocking them, because the number of things worth
testing there that touch neither is small — so they need `npm run dev` (or at
least its `postgres`, `minio`, `minio-init` and `dbmate` services) running
first. `api/vitest.config.ts` disables file parallelism on purpose: several
suites truncate the same tables, and running them concurrently would have one
test wipe another's fixtures mid-flight. Do not re-enable it.

## Working conventions

- TypeScript strict, with `noUncheckedIndexedAccess`. Do not widen types to make
  a build pass.
- No emojis in source or docs.
- **Git is read-only.** Use it for `log`, `status`, `diff`, `ls-files`. Never
  run `git commit`, `git add`, or `git checkout -b` — the operator manages the
  whole history, and work happens directly on `main`. Superpowers plans include
  commit steps; skip them.
- `cf-worker/public/audio/` still holds four silent placeholders, but **nothing
  plays them** — audio arrives per call as HTTPS URLs. Telnyx fetches them at
  the moment each one plays, so they must be publicly reachable and outlive the
  call.
- Placing a call from PowerShell: `curl` is an alias for `Invoke-WebRequest` and
  rejects `-H`. Use `Invoke-RestMethod` or `curl.exe`. The README has both forms.
- Never trigger a real call without asking the operator — it dials a real phone
  and bills their Telnyx account.

### Console specifics

- The API, CLI and worker entrypoints run through `tsx`. Node's own type
  stripping does not remap the `.js` import specifiers that `NodeNext` module
  resolution requires, so it cannot run these files directly. The production
  image compiles with `tsc` for the same reason.
- **Never bind-mount the host's `node_modules` into a container.** `argon2` and
  `esbuild` are native and compiled for win32 here; the dev images carry their
  own Linux builds and compose shadows the mount points with anonymous volumes.
- The dev stack starts detached and `npm run dev:logs` is how you watch it.
  Running attached is not worth it: Docker Compose v5.0.1's attach monitor
  panics with a nil pointer dereference when a `compose run` one-off — which is
  what `dev:migrate` and `dev:cli` are — starts and exits underneath it.
- There is no registration endpoint. Accounts come from the CLI, and a user
  needs a tenant unless it is a platform admin, so `create-tenant` comes first.
  Generated passwords are printed once and are not recoverable.
- Migrations are dbmate SQL in `console/db/migrations`, applied by a one-shot
  container that must complete before the API starts. Add a migration; never
  edit an applied one.
