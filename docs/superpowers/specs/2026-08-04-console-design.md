# Console: multi-tenant survey operations app

Date: 2026-08-04
Status: approved design, not yet implemented
Scope: everything under `console/`, plus a bounded set of changes to `cf-worker/`

## What this is

A web application that turns the existing Cloudflare Worker from a thing you
poke with `Invoke-RestMethod` into a product. Tenants log in, build a campaign
from audio files and a list of phone numbers, launch it, and read the results.
Recordings are pulled out of Telnyx into S3, deleted from Telnyx, and
transcribed on demand.

The Worker keeps doing exactly what it does today: drive one survey call. The
console owns everything the Worker deliberately does not - who the tenant is,
which numbers to dial, which caller ID to dial from, and what happened
afterwards.

## Decisions taken during design

These were settled explicitly. They are recorded because each closes off an
alternative that would otherwise look reasonable later.

| Decision | Choice | Why not the alternative |
|---|---|---|
| Target scale | Pilot volume, SaaS-ready seams | Building for hundreds of tenants now buys machinery that pilot traffic will not exercise, and unexercised machinery is wrong machinery. |
| Transcript granularity | One blob per call | Per-question slicing needs the Worker to report question timings. An analysis agent will consume the transcript later and can do its own segmentation. |
| Transcription engine | OpenAI Whisper API | Self-hosting on a single EC2 transcribes near real time and creates backlogs. AWS Transcribe costs 4x for no gain here. |
| Language | Per-campaign field | Whisper takes a language hint per request, so this is a column, not an engine choice. |
| Number to tenant | Shared pool, `tenant_id` nullable from day one | Assignment later becomes an UPDATE, not a migration of the allocator. |
| "In use" | Busy on a live call | Reserving numbers per campaign means a 3-number pool caps you at 3 concurrent campaigns however small they are. |
| Retries | Manual, from the console | Removes the scheduler entirely. Automatic retry with backoff windows is the largest piece of machinery that was on the table. |
| Contact import | CSV upload and pasted list | An ingestion API and a do-not-call list were considered and cut. |
| User creation | CLI on the box | No admin UI, no invite flow, no role management screen in v1. |
| Isolation | Cross-tenant data only | Tenants may see numbers, download their own audio, and delete their own recordings. |
| Call outcomes | Worker calls back | Polling the Telnyx API cannot distinguish a completed survey from one abandoned at question 2. That distinction exists only in the Worker's flow state. |
| Queueing | Postgres `SKIP LOCKED`, `JobQueue` interface | Dispatch is gated by free numbers, not worker capacity, so it is a scheduler and not a queue. SQS from day one would also force an outbox table to avoid phantom calls. |
| Persistence | Raw SQL via `pg`, dbmate migrations | Operator preference. No ORM. |

## Stack

Backend: Node 24.11.0, TypeScript strict with `noUncheckedIndexedAccess`,
Fastify, `pg`, zod, dbmate, argon2id, AWS SDK v3, OpenAI SDK.

Frontend: React 19 + TypeScript, Vite 8, react-router, TanStack Query, Tailwind,
react-hook-form + zod.

Node is pinned in `.nvmrc`, `package.json#engines`, and the Docker base image.

### Why raw SQL needs a boundary

Without an ORM nothing stops `result.rows[0]` from being asserted into a type it
does not have. Every query module therefore parses its rows through a zod schema
before returning them. The schema is the single definition of a row's shape, it
is checked at runtime, and `noUncheckedIndexedAccess` still forces the caller to
handle an empty result. SQL stays hand-written and visible; only the trust
boundary is automated.

Queries live in per-domain `queries.ts` modules. No SQL appears in a route
handler or a service.

## Repository layout

```
console/
  package.json                 npm workspaces
  .nvmrc                       24.11.0
  docker-compose.dev.yml
  docker-compose.prod.yml
  Caddyfile                    production TLS termination
  .env.example
  db/
    migrations/                dbmate .sql files
  api/
    src/
      server.ts                Fastify bootstrap and route registration
      config.ts                env parsed by zod, fails fast at boot
      db/
        client.ts              pg Pool, withTransaction helper
        rows.ts                zod row-parsing helper
      auth/
        passwords.ts           argon2id hash and verify
        sessions.ts            create, look up, revoke
        middleware.ts          requireUser, requireTenant, requirePlatformAdmin
        routes.ts
      campaigns/
        queries.ts  service.ts  routes.ts  schemas.ts
      audio/
        routes.ts              upload to S3, presign for console playback
      contacts/
        parse.ts               CSV and pasted-list parsing, E.164 normalisation
        queries.ts  routes.ts
      numbers/
        pool.ts                acquire and release
        queries.ts  routes.ts
      dispatch/
        dispatcher.ts          the scheduling loop
        dialer.ts              DialerProvider: CfWorkerDialer, FakeDialer
      callbacks/
        verify.ts              HMAC verification
        routes.ts              worker event ingestion
      media/
        ingest.ts              Telnyx recording to S3, then delete in Telnyx
        transcribe.ts          S3 to Whisper
      jobs/
        queue.ts               JobQueue interface
        pg-queue.ts            SKIP LOCKED implementation
        runner.ts
      telnyx.ts                recordings API client
      s3.ts
      worker.ts                entrypoint for the worker process
      cli/index.ts             create-tenant, create-user, reset-password, add-number
  web/
    src/
      routes/                  login, campaigns, campaign detail, admin numbers
      components/
      api/                     typed fetch client generated from shared schemas
  packages/shared/
    src/                       zod schemas shared by api and web
```

## Data model

All timestamps are `timestamptz`. All ids are `uuid` with `gen_random_uuid()`.

```
tenants            id, name, slug UNIQUE, created_at

users              id, tenant_id NULL REFERENCES tenants, email CITEXT UNIQUE,
                   password_hash, role, created_at
                   role: 'platform_admin' | 'member'
                   CHECK: platform_admin has tenant_id NULL, member has it NOT NULL

sessions           id, user_id, expires_at, created_at

phone_numbers      id, e164 UNIQUE, telnyx_number_id, tenant_id NULL,
                   max_concurrent int NOT NULL DEFAULT 1,
                   status 'active' | 'paused' | 'released',
                   last_used_at NULL, created_at

number_leases      id, phone_number_id, call_id, acquired_at, expires_at,
                   released_at NULL
                   INDEX (phone_number_id) WHERE released_at IS NULL

campaigns          id, tenant_id, name, language, default_country char(2),
                   silence_ms int DEFAULT 2500, thanks_s3_key NULL, status,
                   created_at, launched_at NULL
                   status: 'draft' | 'running' | 'paused' | 'completed'
                   language is the Whisper hint (ISO-639-1, e.g. 'lt').
                   default_country is the E.164 parsing region (ISO-3166-1,
                   e.g. 'LT'). They are distinct fields because they answer
                   different questions and do not always agree.

campaign_questions id, campaign_id, position int, s3_key, original_filename,
                   bytes, created_at
                   UNIQUE (campaign_id, position), CHECK position BETWEEN 1 AND 10

contacts           id, campaign_id, e164, external_ref NULL, status, created_at
                   status: 'pending' | 'dialing' | 'done'
                   UNIQUE (campaign_id, e164)

calls              id, campaign_id, contact_id, phone_number_id, attempt int,
                   telnyx_call_control_id NULL UNIQUE, status, outcome NULL,
                   last_step NULL, hangup_cause NULL,
                   created_at, dialed_at NULL, answered_at NULL, ended_at NULL
                   status: 'queued' | 'dialing' | 'in_progress' | 'ended' | 'failed'
                   outcome: 'completed' | 'abandoned' | 'no_answer' | 'busy'
                          | 'failed' | 'unknown'

recordings         id, call_id, telnyx_recording_id UNIQUE, s3_key NULL,
                   bytes NULL, duration_ms NULL, channels,
                   ingested_at NULL, telnyx_deleted_at NULL, created_at

transcripts        id, recording_id, engine, language, text NULL,
                   raw_s3_key NULL, status, error NULL,
                   created_at, completed_at NULL
                   status: 'pending' | 'running' | 'done' | 'failed'

jobs               id, kind, payload jsonb, run_at, attempts int, max_attempts int,
                   locked_at NULL, locked_by NULL, last_error NULL,
                   created_at, completed_at NULL
                   kind: 'ingest_recording' | 'transcribe'
                   INDEX (run_at) WHERE completed_at IS NULL
```

Manual retry is why `calls` is a separate table from `contacts` rather than a set
of columns on it: one contact accumulates one row per attempt, and `attempt`
increments.

`campaign_questions.position` is 1-based to match `flow.ts`, where `question()`
indexes `questions[step - 1]`.

## Tenant isolation

Every tenant-owned query function takes `tenantId` as its first parameter and
includes it in the `WHERE` clause. `requireTenant()` is the only place a request
turns into a `tenantId`, and it reads from the session, never from the URL or
body. Platform-admin routes live under `/api/admin` and are the only routes that
may name a tenant explicitly.

This is enforced by convention plus a test suite that, for each tenant-scoped
endpoint, authenticates as tenant A and asserts that tenant B's ids return 404
rather than 403 - a 403 confirms the resource exists.

## HTTP surface

```
POST   /api/auth/login                  {email, password}, sets session cookie
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/campaigns
POST   /api/campaigns                   {name, language, silenceMs}
GET    /api/campaigns/:id
PATCH  /api/campaigns/:id
DELETE /api/campaigns/:id               draft only

POST   /api/campaigns/:id/questions     multipart, appends at next position
DELETE /api/campaigns/:id/questions/:qid
PATCH  /api/campaigns/:id/questions/order  {ids: [...]}
PUT    /api/campaigns/:id/thanks        multipart
GET    /api/campaigns/:id/questions/:qid/url  presigned redirect, 15 min
GET    /api/campaigns/:id/thanks/url          presigned redirect, 15 min

POST   /api/campaigns/:id/contacts/preview  {csv | text} -> accepted, rejected, duplicates
POST   /api/campaigns/:id/contacts          {rows}
DELETE /api/campaigns/:id/contacts/:cid

POST   /api/campaigns/:id/launch
POST   /api/campaigns/:id/pause
GET    /api/campaigns/:id/calls         paginated, with outcome and transcript status
POST   /api/campaigns/:id/transcribe    enqueue for every ingested recording lacking one

POST   /api/calls/:id/retry
GET    /api/calls/:id/recording         presigned redirect, 15 min
GET    /api/calls/:id/transcript

GET    /api/admin/tenants
GET    /api/admin/numbers
POST   /api/admin/numbers               {e164, telnyxNumberId, tenantId?, maxConcurrent?}
PATCH  /api/admin/numbers/:id           status, tenantId, maxConcurrent

POST   /callbacks/worker                HMAC-authenticated, not session-authenticated
```

`GET /api/campaigns/:id/calls` is what the campaign detail screen polls every 3
seconds while a campaign is running. No websockets in v1.

## Authentication

Session cookies stored in Postgres. `console_session`, httpOnly, SameSite=Lax,
Secure in production, absolute 7-day expiry with no sliding renewal. Logout and
password reset delete the rows, so revocation is immediate - the reason this is
not JWT.

Passwords are argon2id. There is no registration endpoint and no password-reset
email. Accounts are created by CLI on the box:

```
npm run cli -- create-tenant --name "Acme" --slug acme
npm run cli -- create-user --tenant acme --email a@acme.com --role member
npm run cli -- create-user --platform-admin --email ops@example.com
npm run cli -- reset-password --email a@acme.com
npm run cli -- add-number --e164 +37069625082 --telnyx-id <id>
```

Each prints a generated password once and never stores it in plaintext.

## Audio

Uploads accept `audio/mpeg` and `audio/wav`, 10 MB maximum, 1 to 10 questions
plus one thanks file. Stored at:

```
tenants/{tenant_id}/campaigns/{campaign_id}/questions/{position}-{uuid}.mp3
tenants/{tenant_id}/campaigns/{campaign_id}/thanks-{uuid}.mp3
tenants/{tenant_id}/calls/{call_id}/recording.mp3
tenants/{tenant_id}/calls/{call_id}/transcript.json
```

Launch is refused unless positions are contiguous from 1 and a thanks file
exists. Reordering rewrites `position` values inside one transaction; the S3 key
keeps its original position prefix and is not renamed, because the key is an
opaque identifier and renaming would mean a copy plus a delete for no benefit.

## Contact import

CSV and pasted text go through the same pipeline. A CSV either has a header row
naming a `phone`, `number`, or `msisdn` column plus an optional `ref`, or it has
no header and the first column is the number. Pasted text is split on newlines
and commas.

Every value is normalised to E.164 with `libphonenumber-js` using the campaign's
country default. The preview endpoint returns three lists - accepted, rejected
with a per-row reason, and duplicates already present in the campaign - and
nothing is written until the operator confirms. A campaign is capped at 10,000
contacts, which is a pilot guard rather than a technical limit.

## Number pool

`acquire(tenantId, callId)` runs in one transaction:

1. `SELECT id, e164, max_concurrent FROM phone_numbers WHERE status = 'active'
   AND (tenant_id IS NULL OR tenant_id = $1) ORDER BY last_used_at NULLS FIRST
   FOR UPDATE SKIP LOCKED`
2. Count unreleased, unexpired leases for the locked rows in one query.
3. Take the first row under its `max_concurrent`, insert a `number_leases` row
   with `expires_at = now() + interval '8 minutes'`, set `last_used_at = now()`.
4. Commit. If no row had capacity, return null and let the next tick try again.

Locking every lockable row is O(pool size). That is correct and obviously so for
a pool in the tens, which is the shape of this system for the foreseeable
future. If the pool ever reaches the low hundreds, the replacement is a
denormalised `active_leases` counter column on `phone_numbers` updated in the
same transaction - a change confined to `numbers/pool.ts`.

`release(callId)` sets `released_at = now()`. A sweeper on every dispatcher tick
releases leases where `expires_at < now() AND released_at IS NULL` and marks the
associated call `ended` with outcome `unknown`. Eight minutes exceeds the
worst-case call - 60s ring plus 10 questions at 40s - so a live call cannot have
its number stolen.

Growing the pool is `add-number` on the CLI or `POST /api/admin/numbers`. Buying
numbers through the Telnyx API is deliberately out of scope; numbers are bought
in the portal and registered here.

## Dispatch

The dispatcher loop ticks every 2 seconds:

1. Sweep expired leases.
2. For each `running` campaign, oldest first, try to acquire a number for its
   tenant. If none is free, move on.
3. Claim the next `pending` contact with `FOR UPDATE SKIP LOCKED`, set it
   `dialing`, insert a `calls` row with `status = 'queued'` and the next
   `attempt` number.
4. Presign the campaign's question and thanks URLs for 60 minutes, comfortably
   clearing the Worker's `requiredRunwayMs` check in `manifest.ts`.
5. Call `DialerProvider.dial()`. On success, store the returned
   `call_control_id` and set the call `dialing`. On failure, release the lease,
   set the call `failed`, and return the contact to `pending` so the operator
   can retry it manually.
6. Mark a campaign `completed` when it has no `pending` or in-flight contacts.

`DialerProvider` is the seam that makes local development possible:

```ts
interface DialerProvider {
  dial(args: {
    to: string; from: string; silenceMs: number;
    audio: { questions: string[]; thanks: string };
    callbackUrl: string;
  }): Promise<{ callControlId: string }>;
}
```

`CfWorkerDialer` posts to the Worker's `/calls` with the `TRIGGER_SECRET`.
`FakeDialer` returns a synthetic id and schedules the callback sequence -
answered, recording saved, hangup - on a timer, so every downstream path is
exercisable on a laptop.

Manual retry (`POST /api/calls/:id/retry`) sets the contact back to `pending`.
The dispatcher picks it up on the next tick; `attempt` increments on the new
call row and the previous call row is left intact as history.

## Worker changes

Bounded, and in the existing style. Full detail belongs in that plan; the
contract is fixed here.

1. `POST /calls` accepts optional `from` in E.164, falling back to
   `TELNYX_FROM_NUMBER`. `createCall` already takes `from` as an argument.
2. `POST /calls` accepts optional `callbackUrl`, https only. It is appended to
   the webhook URL query string next to the existing `silenceMs`, so every
   webhook arrives already carrying it and no Durable Object round trip is
   added.
3. New secret `CONSOLE_HMAC_SECRET`.
4. New `src/callback.ts` with a pure signing function and a `notify()` that
   POSTs the event. Fired through `ctx.waitUntil` and with all errors swallowed,
   because the webhook route must return 200 regardless - a non-2xx makes Telnyx
   retry and double-advance the flow.
5. `call.recording.saved` is handled for the first time. It issues no Telnyx
   command; it only notifies.
6. `call.answered` and `call.hangup` notify as well. The hangup notification
   includes the decoded step from `client_state`, which is what makes outcome
   derivation possible.

Callback contract:

```
POST {callbackUrl}
x-console-timestamp: <unix seconds>
x-console-signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`>

{ "event": "call.hangup",
  "call_control_id": "...",
  "occurred_at": "2026-08-04T10:00:00Z",
  "step": 2,
  "payload": { "hangup_cause": "normal_clearing", ... } }
```

The console verifies the HMAC against the raw body before parsing and rejects
timestamps more than 5 minutes from now. Idempotency needs no dedupe table: the
`recordings.telnyx_recording_id` unique constraint absorbs a repeated
`call.recording.saved`, and the call state machine only moves forward, so
replaying `call.answered` after `call.hangup` is a no-op. A repeated event is
therefore harmless rather than merely unlikely.

Outcome derivation on `call.hangup`:

| Condition | Outcome |
|---|---|
| `step === "done"` | `completed` |
| numeric `step`, call was answered | `abandoned` (with `last_step`) |
| never answered, cause `user_busy` | `busy` |
| never answered, other cause | `no_answer` |
| lease expired without a hangup | `unknown` |

The same handler moves the contact from `dialing` to `done` regardless of
outcome. A contact returns to `pending` only through a dispatch failure or an
explicit manual retry, which is what keeps "done" meaning "we are finished with
this number for now" rather than "the survey succeeded" - the survey's success
lives in `calls.outcome`.

## Media pipeline

`call.recording.saved` inserts a `recordings` row and enqueues
`ingest_recording`. The job:

1. Downloads the MP3 from the Telnyx URL in the payload.
2. Verifies the byte count is non-zero and matches `Content-Length`.
3. Puts it to `tenants/{t}/calls/{c}/recording.mp3` and records `s3_key`,
   `bytes`, `ingested_at`.
4. Only then issues `DELETE /v2/recordings/{telnyx_recording_id}` and records
   `telnyx_deleted_at`.

Deletion strictly after a verified upload, so a failed ingest can never destroy
the only copy. A job that dies between step 3 and step 4 leaves a recording in
Telnyx that a later retry deletes; the S3 put is idempotent on a fixed key.

`transcribe` is only ever enqueued by an operator action. It streams the object
from S3 to Whisper with the campaign's language hint, writes `text` to Postgres
and the verbose JSON to `transcript.json` in S3, and marks the row `done`. Files
above 24 MB fail with an explicit message rather than a truncated transcript.
Re-transcribing replaces the existing row for that recording.

## Job queue

```ts
interface JobQueue {
  enqueue(kind: JobKind, payload: unknown, runAt?: Date): Promise<string>;
  claim(limit: number, lockedBy: string): Promise<Job[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}
```

`PgJobQueue` claims with `UPDATE jobs SET locked_at = now(), locked_by = $2
WHERE id IN (SELECT id FROM jobs WHERE completed_at IS NULL AND run_at <= now()
AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING *`. Failures retry
with exponential backoff to `max_attempts` of 5, then stay failed and visible in
the campaign UI.

The interface exists so that moving the media jobs to SQS later is an added
adapter rather than a refactor. Dispatch never moves to a queue, because it is
gated by number availability rather than worker capacity.

## Frontend

Screens, and nothing else in v1:

- **Login.** Email and password.
- **Campaigns.** List with status and progress, plus a create button.
- **Campaign wizard.** Four steps: details (name, language, silenceMs), audio
  (upload questions, drag to reorder, upload thanks), contacts (CSV or paste
  with a preview of accepted, rejected, and duplicate rows), review and launch.
  The wizard writes a draft campaign at step one, so nothing is lost on refresh.
- **Campaign detail.** Progress bar, a table of calls with outcome and duration,
  a retry button per failed call, an inline audio player using a presigned URL,
  the transcript inline once done, and a "Transcribe all" button. Polls every 3
  seconds while running.
- **Admin numbers.** Platform admin only. Pool table showing each number, its
  tenant assignment, `max_concurrent`, live lease state, and controls to add,
  pause, and assign.

## Environments

### Local development

`docker-compose.dev.yml` brings up Postgres 17, MinIO, a dbmate one-shot, `api`,
`worker`, and the Vite dev server. `DIALER=fake` by default.

The honest constraint: Telnyx cannot fetch audio from a MinIO URL on localhost,
and a Cloudflare Worker cannot POST a callback to localhost either. `FakeDialer`
is what makes the dev loop complete - it synthesises the whole callback sequence
so contact import, dispatch, lease handling, outcome derivation, ingest, and
transcription all run on a laptop. Placing a genuinely live call from a dev
machine requires a tunnel and real S3, and is documented rather than engineered
around.

### Production

`docker-compose.prod.yml` on one EC2 instance: Caddy for automatic TLS, `web`
built to static assets and served by Caddy, `api`, `worker`, Postgres 17 with a
named volume, and a dbmate one-shot that runs before `api`. S3 is real, reached
through the instance's IAM role so no AWS keys exist on the box. Configuration
comes from a `.env` file on the instance and is not in git.

Postgres in the compose file rather than RDS is a deliberate pilot-scale choice.
The swap is a connection string.

## Testing

Pure unit tests, no database: CSV and pasted-list parsing with E.164
normalisation, outcome derivation, HMAC signing and verification, job backoff,
presign runway arithmetic, and every zod schema.

Integration tests against the compose Postgres:

- **Number pool concurrency.** N parallel `acquire()` calls against a
  one-number pool yield exactly one lease. This is the highest-risk function in
  the codebase and the reason this suite exists.
- **Tenant isolation.** For each tenant-scoped endpoint, tenant A receives 404
  for tenant B's ids.
- **Job claim.** Parallel claims never hand the same job to two runners.
- **Dispatcher.** A campaign with three contacts and one number places three
  sequential calls against `FakeDialer` and ends `completed`.

Frontend tests cover wizard validation only.

Worker changes are tested in the existing suites - the signing function is pure,
and `index.test.ts` already stubs `fetch` and signs webhooks with a generated
keypair.

## Implementation plans

Three, in order. Each is independently shippable.

**Plan 1 - Foundation.** Workspace scaffold, both compose files, dbmate schema
and migrations, the `pg` client and zod row boundary, auth with sessions and
the CLI, tenant scoping and its test suite, the React shell with login, campaign
CRUD, audio upload to S3, contact import with preview. No calling of any kind.

**Plan 2 - Dispatch.** The Worker changes and their tests, the number pool with
its concurrency suite, the dispatcher loop, `DialerProvider` with both
implementations, the callback endpoint with HMAC verification, the call state
machine and outcome derivation, campaign detail UI with live progress and manual
retry.

**Plan 3 - Media.** The job queue and runner, recording ingest to S3 with
Telnyx deletion, Whisper transcription on demand, transcript UI, production
compose hardening and EC2 deployment notes.

## Explicitly out of scope

Automatic retry scheduling, do-not-call and suppression lists, a contact
ingestion API, per-question transcript segmentation, any analysis of transcript
content, buying numbers through the Telnyx API, self-service registration,
password reset by email, an admin UI for user management, websockets, and RDS.
