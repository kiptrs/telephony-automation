# Console

Multi-tenant operations app for the Telnyx voice survey Worker in `../cf-worker`.

Tenants log in, build a campaign from audio files and a contact list, launch it
against a shared caller-ID pool, and watch the calls land. Every recording is
pulled out of Telnyx into the operator's own bucket, and transcription runs on
demand.

## Layout

    api/               Fastify API, raw SQL over pg
    web/               React 19 + Vite 8 single page app
    packages/shared/   zod schemas shared by both
    db/migrations/     dbmate SQL

## Local development

The whole stack is one command:

    npm run dev

That is `docker compose -f docker-compose.dev.yml up -d --build`: Postgres 17,
MinIO, a dbmate one-shot that finishes before anything connects, the API, the
worker, and the Vite dev server. Nothing needs to be installed on the host and
there is no `.env` to copy - `DIALER=fake`, so dispatch, leasing, outcome
derivation, ingest, and transcription all run without Telnyx.

It starts detached, and `npm run dev:logs` is how you watch it. Running
attached is not worth it: Docker Compose v5.0.1's attach monitor panics with a
nil pointer dereference when a `compose run` one-off - which is what
`dev:migrate` and `dev:cli` are - starts and exits underneath it.

    http://localhost:5173    the app
    http://localhost:3000    the API directly
    http://localhost:9001    MinIO console, console / consoleconsole

`api/src` and `web/src` are bind-mounted, so `tsx watch` and Vite HMR both pick
up a save. Editing `packages/shared` needs a restart of the affected service -
it is compiled into the image, not watched.

Overrides go in `console/.env`, which compose reads for substitution:
`OPENAI_API_KEY` for real transcription, or `DIALER=cf-worker` plus the
`WORKER_*` values to dial through the real Cloudflare Worker.

## Scripts

Ten, five per environment:

    npm run typecheck        tsc across all three workspaces
    npm test                 vitest across all three workspaces

    npm run dev              build and start the whole dev stack, detached
    npm run dev:down         stop and remove it, keeping the volumes
    npm run dev:logs         follow api, worker, web
    npm run dev:cli          account and number provisioning
    npm run dev:user         shorthand for `dev:cli -- create-user`
    npm run dev:migrate      dbmate up

    npm run prod             build and start the whole prod stack
    npm run prod:down        stop and remove it, keeping the volumes
    npm run prod:logs        follow api, worker
    npm run prod:cli         the same CLI, compiled
    npm run prod:migrate     dbmate up

`dev:down` keeps `pgdata` and `miniodata`, so accounts, campaigns, and uploaded
audio survive a restart. To start from an empty database:

    docker compose -f docker-compose.dev.yml down -v

### Running on the host instead

Sometimes a debugger attaches more easily to a host process. Node 24.11.0 is
required; `.nvmrc` pins it.

    npm install
    cp .env.example api/.env      # set PUBLIC_BASE_URL=http://127.0.0.1:3000
    docker compose -f docker-compose.dev.yml up -d postgres minio minio-init dbmate
    npm run dev --workspace @console/api
    npm run dev --workspace @console/web
    npm run worker:dev --workspace @console/api

The Vite server proxies `/api` to port 3000, so the session cookie is
same-origin and no CORS configuration exists anywhere. Set `API_PROXY_TARGET`
if the API is not on the default port.

### Local environment notes

- The API, CLI, and worker entrypoints run through `tsx`. Node's own type
  stripping does not remap the `.js` import specifiers that `NodeNext` module
  resolution requires, so it cannot run these files directly.
- Never bind-mount the host's `node_modules` into a container. `argon2` and
  `esbuild` are native and compiled for the host platform; the dev images carry
  their own and compose shadows the mount points with anonymous volumes.
- `api/vitest.config.ts` disables file parallelism. Several suites truncate the
  same tables, so running them concurrently would have one test wipe another's
  fixtures mid-flight.

### Creating accounts

There is no registration endpoint. Accounts are created against the running
stack:

    npm run dev:cli -- create-tenant --name "Acme" --slug acme
    npm run dev:user -- --email a@acme.com --tenant acme
    npm run dev:user -- --email ops@example.com --platform-admin
    npm run dev:cli -- reset-password --email a@acme.com
    npm run dev:cli -- add-number --e164 +37069000001

A user needs a tenant unless it is a platform admin, so `create-tenant` comes
first.

Generated passwords are printed once and are not recoverable. Without at least
one number in the pool nothing will dial.

## Tests

    npm run dev        # or just postgres and minio, as above
    npm test
    npm run typecheck

Tests run on the host, not in a container, so this needs `npm install` and the
Node version above. The API suite needs Postgres and MinIO, because the number
of things worth testing here that touch neither is small.

## Production

One EC2 instance running `docker-compose.prod.yml`: Postgres, a dbmate one-shot
that must finish before the API starts, the API, a one-shot that publishes the
built frontend into a volume, and Caddy terminating TLS.

    cp .env.prod.example .env.prod
    # edit .env.prod, then
    npm run prod

`.env.prod`, not `.env`: compose reads `.env` for both compose files, so
production values in it would silently reconfigure `npm run dev` - starting
with `DIALER=cf-worker`, which dials real phones.

S3 is reached through the instance's IAM role. No AWS keys belong on the box.

## Calling

The `worker` process runs a 2-second loop: sweep expired number leases, then for
each running campaign take a free number, claim a pending contact, presign the
audio for an hour, and post to the Cloudflare Worker's `/calls`. The Worker
reports `call.answered`, `call.hangup`, and `call.recording.saved` back to
`/callbacks/worker`, signed with `WORKER_HMAC_SECRET`.

Throughput is bounded by the number pool, not by the loop. One number at
`max_concurrent: 1` means one call at a time, whatever the campaign size.

`WORKER_TRIGGER_SECRET` and `WORKER_HMAC_SECRET` must match the Worker's
`TRIGGER_SECRET` and `CONSOLE_HMAC_SECRET` exactly. A mismatch on the first
gives 401 on every dial; a mismatch on the second gives 401 on every callback,
which looks like calls that dial and then never finish.

Numbers reach the pool through the admin screen or the CLI:

    npm run dev:cli -- add-number --e164 +37069000001 [--telnyx-id <id>] [--tenant <slug>]

### DIALER=fake

Telnyx cannot fetch audio from MinIO on localhost, and a Cloudflare Worker
cannot POST a callback to a laptop. `DIALER=fake` substitutes a dialer that
synthesises the whole callback sequence, so dispatch, leasing, outcome
derivation, and the UI all run locally. It is the default in
`docker-compose.dev.yml`, where `PUBLIC_BASE_URL` is `http://api:3000` so the
fake's callbacks resolve on the compose network.

Placing a genuinely live call from a development machine needs a public tunnel
for `PUBLIC_BASE_URL` and a real S3 bucket for the audio. That is a deliberate
gap, not an oversight.

## Known limitations

- Question reordering uses Up and Down buttons rather than drag and drop.
- A failed audio upload can leave an orphaned S3 object. This is deliberate:
  writing S3 before the database row means a row can never point at a missing
  object, and an orphan costs only storage.
- There is no pagination. A campaign is capped at 10,000 contacts and the
  contact list renders all of them.

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

With `DIALER=fake` the synthesised `call.recording.saved` points at
`https://fake.invalid/recording.mp3`, so ingest jobs fail with a DNS error and
retry. That is expected, and it exercises the queue's backoff path.
