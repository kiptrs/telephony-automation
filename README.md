# rtc-telnyx

An automated voice survey platform. A campaign is a list of contacts and a
handful of recorded questions; the system dials each contact, plays question
one, waits for them to stop talking, plays question two, and so on, then thanks
them and hangs up. Every call is recorded dual-channel and can be transcribed.

There are two deployables, and they are deliberately unalike.

| | Cloudflare Worker (`cf-worker/`) | Console (`console/`) |
|---|---|---|
| Runs on | Cloudflare Workers + Durable Objects | One EC2 instance, Docker Compose |
| Owns | One call, in flight | Tenants, campaigns, contacts, numbers, recordings |
| State | A Durable Object per call, discarded at hangup | Postgres and S3 |
| Knows about tenants | No | Yes |
| Deployed with | `wrangler deploy` | `docker compose up -d --build` |

The Worker is a small, stateless, tenant-agnostic machine that knows how to run
one call well. The console is the multi-tenant application around it. The only
things they share are two secrets and an HTTPS boundary, which is what makes it
reasonable to deploy them to entirely different clouds.

## Main components

**`cf-worker/`** - the call engine. Telnyx cannot tell you when a caller stops
speaking, so the Worker does it itself: it forks the caller's inbound audio to a
WebSocket and a Durable Object measures the energy of each 20ms mu-law frame.
When the caller has been quiet for `silenceMs`, the object plays the next
question. `POST /calls` takes a phone number and a set of HTTPS audio URLs; no
audio is bundled with the Worker.

- `src/index.ts` routing, signature verification, manifest seeding
- `src/session.ts` the `CallSession` Durable Object: media socket, VAD state
- `src/vad.ts` mu-law decode and the silence decision, pure
- `src/flow.ts` call setup and hangup, pure
- `src/manifest.ts` audio manifest validation including SigV4 expiry, pure
- `src/callback.ts` HMAC-signed notifications back to the console

**`console/api/`** - Fastify, raw SQL over `pg`. Serves the SPA's `/api/*`,
receives the Worker's `/callbacks/worker`, and runs a second process
(`worker.js`) holding two loops: a dispatcher that leases caller-ID numbers and
places calls, and a job runner draining a Postgres queue for recording ingest
and transcription.

**`console/web/`** - React 19 and Vite 8. Login, campaign wizard, contact
upload, live call list, recording playback, transcripts. Built to static files
and served by Caddy; no Node process in production.

**`console/packages/shared/`** - zod schemas used by both sides of the console.

**`console/db/`** - dbmate migrations. Postgres 17.

**S3** - one private bucket holds everything: question audio uploaded through
the console, and recordings and transcripts pulled out of Telnyx.

    tenants/{tenant}/campaigns/{campaign}/questions/{n}-{uuid}.mp3
    tenants/{tenant}/campaigns/{campaign}/thanks-{uuid}.mp3
    tenants/{tenant}/calls/{call}/recording.mp3
    tenants/{tenant}/calls/{call}/transcript.json

## How a call actually happens

1. A tenant builds a campaign in the console and presses Launch.
2. The console's dispatcher loop wakes every 2 seconds, takes a free number
   from the pool, and claims a pending contact.
3. It presigns the campaign's audio from S3 for one hour and `POST`s to the
   Worker's `/calls` with `Authorization: Bearer TRIGGER_SECRET`.
4. The Worker calls Telnyx, which dials the contact.
5. On `call.answered` the Worker starts a dual-channel recording, opens a media
   stream, and plays question one.
6. The Durable Object hears silence and plays question two, then three, and so
   on, then the thank-you, then hangs up.
7. The Worker POSTs `call.answered`, `call.hangup` and `call.recording.saved`
   to the console's `/callbacks/worker`, signed with `CONSOLE_HMAC_SECRET`.
8. The console enqueues an ingest job: download the mp3 from Telnyx, upload to
   S3, and only then delete it at Telnyx. That order is deliberate and tested.
9. Transcription never runs on its own - Whisper is billed per minute. A button
   on the campaign enqueues one job per recording.

Throughput is bounded by the number pool, not by the loop. One number at
`max_concurrent: 1` means one call at a time, whatever the campaign size.

## Repository layout

    cf-worker/          the Cloudflare Worker, its own npm project
    console/            npm workspaces: api, web, packages/shared, db
    docs/superpowers/   design specs and plans, partly historical
    CLAUDE.md           working notes for Claude Code

`cf-worker/README.md` and `console/README.md` go deeper on each side. The specs
under `docs/` are worth reading for the reasoning and the live-call evidence,
but two of them describe approaches that were abandoned - see the dead ends in
`CLAUDE.md`.

## Local development

    cd cf-worker && npm install && npm test
    cd console && npm run dev          # the whole stack, one command

The console's dev stack is Postgres, MinIO, migrations, API, worker and Vite in
Docker, with `DIALER=fake` so nothing dials a real phone. See
`console/README.md` for accounts, the CLI, and why a genuinely live call cannot
be placed from a laptop.

---

# Deployment

Everything below is manual and done once. There is no CI, no Terraform, and no
CloudFormation in this repo - what follows is the whole procedure.

**Order matters.** The console needs the Worker's URL and the Worker's
`TRIGGER_SECRET`, and Caddy cannot get a TLS certificate before DNS resolves.
Work through it in this order:

1. Generate the shared secrets (below)
2. Deploy the Cloudflare Worker, note its hostname
3. Create the S3 bucket and IAM role
4. Launch the EC2 instance and allocate an Elastic IP
5. Point DNS at that IP
6. Bring the console up
7. Configure Telnyx
8. Place a test call

## 0. Shared secrets

Three values are shared across the two deployables and must be generated or
collected once, before either is configured. The other three in the table below
are the Worker's alone, but this is the moment to have them all to hand.
Anything that produces 32+ random bytes will do for the two you invent:

    openssl rand -hex 32

| Value | Worker secret | Console `.env.prod` | Notes |
|---|---|---|---|
| Trigger secret | `TRIGGER_SECRET` | `WORKER_TRIGGER_SECRET` | Must match exactly |
| Callback HMAC | `CONSOLE_HMAC_SECRET` | `WORKER_HMAC_SECRET` | Must match exactly, 32+ chars |
| Telnyx API key | `TELNYX_API_KEY` | `TELNYX_API_KEY` | Same key; the console needs it only to delete ingested recordings |
| Telnyx public key | `TELNYX_PUBLIC_KEY` | - | Worker only |
| Connection ID | `TELNYX_CONNECTION_ID` | - | Worker only |
| Default from number | `TELNYX_FROM_NUMBER` | - | Worker only; the console overrides it per call from the number pool |

A mismatch on the first gives a 401 on every dial. A mismatch on the second
gives a 401 on every callback, which presents as calls that dial and then never
finish. Neither is obvious from the console UI, so get them right here.

## 1. Cloudflare Worker

### 1.1 Prerequisites

- A Cloudflare account. The free plan is enough; `wrangler.jsonc` uses
  `new_sqlite_classes` precisely because SQLite-backed Durable Objects are the
  variant available there.
- Node 20 or newer on your machine. The tests generate Ed25519 keypairs
  through `crypto.subtle`.
- A Telnyx account with a number, a Voice API application, and an API key.
  Section 7 covers the portal side; you need the values before deploying.

### 1.2 Authenticate and verify

    cd cf-worker
    npm install
    npx wrangler login
    npm run typecheck
    npm test

The suite is 140 tests across 8 files and needs no credentials and no Workers
runtime. If it does not pass, stop here.

### 1.3 Set the secrets

Six, each prompting for the value on stdin. They are never in `wrangler.jsonc`
and never in the repo:

    npx wrangler secret put TELNYX_API_KEY
    npx wrangler secret put TELNYX_PUBLIC_KEY
    npx wrangler secret put TELNYX_CONNECTION_ID
    npx wrangler secret put TELNYX_FROM_NUMBER
    npx wrangler secret put TRIGGER_SECRET
    npx wrangler secret put CONSOLE_HMAC_SECRET

`TELNYX_PUBLIC_KEY` is the base64 Ed25519 public key from the Telnyx portal, not
the API key. `TELNYX_CONNECTION_ID` is the Voice API application id.
`TELNYX_FROM_NUMBER` is in E.164, for example `+37060000000`.

Confirm all six are present:

    npx wrangler secret list

Secrets survive deployments. You only revisit this when a value rotates.

### 1.4 Deploy

    npm run deploy

Wrangler prints the hostname, typically
`https://rtc-telnyx.<your-subdomain>.workers.dev`. Record it - it is the
console's `WORKER_BASE_URL`.

If this is the first Worker on the account, enable the `workers.dev` subdomain
in the dashboard under Workers & Pages first, or the deploy has nowhere to
publish.

### 1.5 Verify

The Worker exposes three routes: `POST /calls`, `POST /webhooks/telnyx`, and a
`/stream` WebSocket upgrade. An unauthenticated dial attempt should be refused:

    curl -i -X POST https://rtc-telnyx.<subdomain>.workers.dev/calls

Expect `401 {"error":"unauthorized"}`, which proves the Worker is live and
`TRIGGER_SECRET` is set. A DNS failure means the deploy never landed. A `404`
means something other than this Worker is answering on that hostname. A `5xx`
means the code is running but a secret is missing.

Then watch it live:

    npx wrangler tail

`stream_open`, `vad_armed` and `answer_ended` are the three log lines that tell
you the silence detection is working. This is the only way to debug a real
call.

### 1.6 Redeploying

`npm run deploy` again. There is no build step and no artifact - Wrangler
bundles `src/index.ts` on the spot. Durable Objects in flight are drained by
Cloudflare, so a deploy mid-call is safe but will end that call's media stream.

## 2. Cloudflare DNS

Two records, only one of which is required.

### 2.1 The console record (required)

The console needs a public hostname before Caddy can obtain a certificate. You
need the Elastic IP from section 4 first, so if you are working strictly in
order, do section 3 and 4 and come back.

In the Cloudflare dashboard, open the zone, then DNS > Records > Add record:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `console` (for `console.example.com`) |
| IPv4 address | the Elastic IP from section 4.3 |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

**The grey cloud is not optional.** `docker-compose.prod.yml` runs Caddy with
automatic HTTPS, which means Caddy answers a Let's Encrypt HTTP-01 challenge on
port 80 and terminates real TLS itself. Turning the proxy on puts Cloudflare's
edge in front of ports 80 and 443, so the challenge no longer reaches Caddy and
visitors get Cloudflare's certificate instead. Making the orange cloud work
means a Cloudflare Origin CA certificate or a DNS-01 challenge plus SSL mode
Full (strict), and a `Caddyfile` that does not currently exist here.

Verify from your machine, not from the box:

    dig +short console.example.com

It must return your Elastic IP. If it returns something in `104.x` or `172.67.x`
the record is still proxied and Caddy will fail to get a certificate.

If the zone has CAA records, `letsencrypt.org` must be among the permitted
issuers:

    dig +short CAA example.com

### 2.2 A custom domain for the Worker (optional)

The `workers.dev` hostname works perfectly well and needs no DNS at all. If you
would rather the Worker lived on your own domain:

1. The zone must already be on Cloudflare.
2. Workers & Pages > `rtc-telnyx` > Settings > Domains & Routes > Add > Custom
   Domain.
3. Enter `voice.example.com`. Cloudflare creates the DNS record and issues the
   certificate itself.

Do not create that record by hand. A manually created A or CNAME record will not
route to a Worker, and a hand-made record on the same name blocks the automatic
one.

Afterwards, update the console's `WORKER_BASE_URL` and the Telnyx application's
webhook URL to the new hostname.

## 3. AWS: S3 and IAM

Region matters and must be consistent: `S3_REGION` in `.env.prod`, the bucket's
region, and the instance's region should all be the same. SigV4 signatures are
region-scoped, so a mismatch fails at signing time with an unhelpful message.
`eu-central-1` is used in the examples.

### 3.1 The bucket

One private bucket holds question audio, recordings, and transcripts.

    BUCKET=your-production-bucket
    REGION=eu-central-1

    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"

    aws s3api put-public-access-block \
      --bucket "$BUCKET" \
      --public-access-block-configuration \
        BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

    aws s3api put-bucket-encryption \
      --bucket "$BUCKET" \
      --server-side-encryption-configuration \
        '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

`us-east-1` is the exception that rejects `--create-bucket-configuration`; drop
that flag there.

Two things this bucket does **not** need:

- **Public access.** Telnyx fetches question audio over presigned URLs, so
  blocking public access entirely is correct. Keep it blocked.
- **A CORS policy.** The browser uploads audio to the console's API, not
  straight to S3, and playback is a plain `<audio src>` element, which is not a
  CORS-restricted request. If you later add a direct-to-S3 upload, that changes.

Optional but sensible: a lifecycle rule expiring `tenants/*/calls/*` after
whatever your retention policy is. Recordings are the bulk of the storage.

### 3.2 The instance role

The console authenticates to S3 with the EC2 instance role. No AWS access keys
belong on the box, and none appear in `docker-compose.prod.yml`.

Substitute your bucket name for `YOUR-BUCKET` in the second command; the JSON is
quoted literally, so no shell variable is expanded inside it.

    aws iam create-role --role-name console-ec2 \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": { "Service": "ec2.amazonaws.com" },
          "Action": "sts:AssumeRole"
        }]
      }'

    aws iam put-role-policy --role-name console-ec2 --policy-name console-s3 \
      --policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Sid": "ConsoleObjects",
          "Effect": "Allow",
          "Action": ["s3:GetObject", "s3:PutObject"],
          "Resource": "arn:aws:s3:::YOUR-BUCKET/tenants/*"
        }]
      }'

    aws iam create-instance-profile --instance-profile-name console-ec2
    aws iam add-role-to-instance-profile \
      --instance-profile-name console-ec2 --role-name console-ec2

Two permissions, scoped to one prefix, because that is genuinely all the code
does: `src/s3.ts` issues `GetObject` and `PutObject` and nothing else, and every
key it builds starts with `tenants/`. There is no `ListBucket` and no
`DeleteObject` - orphaned objects are left deliberately, since a failed upload
that leaves a stray object costs only storage, while a database row pointing at
a missing object costs a recording.

If you would rather use Session Manager than SSH, also attach the managed
policy:

    aws iam attach-role-policy --role-name console-ec2 \
      --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

## 4. AWS: the EC2 instance

### 4.1 Sizing

| | |
|---|---|
| AMI | Amazon Linux 2023, x86_64 |
| Type | `t3.small` minimum, `t3.medium` comfortable |
| Storage | 30 GB gp3 |
| Networking | Public subnet with an internet gateway |

The constraint is the build, not the run. `docker compose up --build` compiles
TypeScript for the API and runs a Vite production build, twice installing dev
dependencies. On 2 GB that is tight; on 1 GB (`t3.micro`) it gets OOM-killed.
Either use `t3.medium`, or add swap on a `t3.small`:

    sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

Outbound internet access is required at runtime, not just at build time: the API
reaches Telnyx, OpenAI, and the Cloudflare Worker. A private subnet needs a NAT
gateway.

`arm64` (`t4g.*`) works too - `argon2` and `esbuild` both build natively - but
use the `aarch64`/`arm64` plugin binaries in 4.5.

### 4.2 Security group

| Direction | Port | Source | Why |
|---|---|---|---|
| Inbound | 80 | `0.0.0.0/0` | ACME HTTP-01 challenge, and the redirect to 443 |
| Inbound | 443 | `0.0.0.0/0` | The console itself, and the Worker's callbacks |
| Inbound | 22 | your IP only | Omit entirely if using Session Manager |
| Outbound | all | `0.0.0.0/0` | Telnyx, OpenAI, S3, Let's Encrypt |

Port 80 must stay open permanently, not just during setup - Caddy renews
certificates on the same challenge every 60 days.

Postgres is not in this table on purpose. `docker-compose.prod.yml` publishes
ports only on the `caddy` service; Postgres is reachable on the Compose network
and nowhere else.

### 4.3 Launch, and pin the address

Launch with the AMI, type, security group and the `console-ec2` instance profile
from 3.2. Then allocate an Elastic IP and associate it, so that a stop/start
does not silently break DNS and every certificate renewal after it:

    aws ec2 allocate-address --domain vpc
    aws ec2 associate-address --instance-id i-0123456789abcdef0 \
      --allocation-id eipalloc-0123456789abcdef0

That address is what goes in the DNS record in section 2.1. Go and create it
now if you have not - the certificate step later depends on it having
propagated.

### 4.4 Confirm the instance role works

SSH in (`ssh ec2-user@console.example.com`) and check that the box can reach S3
without any credentials on disk. The AWS CLI is preinstalled on Amazon Linux
2023:

    aws sts get-caller-identity        # shows .../console-ec2/i-0123...

    echo probe > /tmp/probe.txt
    aws s3api put-object --bucket "$BUCKET" --key tenants/_probe \
      --body /tmp/probe.txt --region "$REGION"
    aws s3api get-object --bucket "$BUCKET" --key tenants/_probe \
      /tmp/probe.out --region "$REGION"

Both should succeed. Note that `aws s3 ls s3://$BUCKET` will *not* - that needs
`ListBucket`, which the policy deliberately withholds, and its failure is not a
sign of a broken role. The probe object cannot be deleted by this role either;
remove it with your own credentials afterwards.

### 4.5 Docker, Compose, and Buildx

Amazon Linux 2023 ships Docker in its repositories but neither CLI plugin. Both
have to be installed by hand:

    sudo dnf update -y
    sudo dnf install -y docker git
    sudo systemctl enable --now docker
    sudo usermod -aG docker ec2-user

Log out and back in for the group change to apply, then:

    sudo mkdir -p /usr/local/lib/docker/cli-plugins

    sudo curl -SL \
      https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    BUILDX=v0.30.1
    sudo curl -SL \
      "https://github.com/docker/buildx/releases/download/$BUILDX/buildx-$BUILDX.linux-amd64" \
      -o /usr/local/lib/docker/cli-plugins/docker-buildx
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

    docker compose version
    docker buildx version
    docker run --rm hello-world

**Buildx is not optional, and 0.17.0 is the floor.** Current Compose delegates
every image build to it, so on a box with no `docker-buildx` plugin - or an older
one - the `up -d --build` in 5.2 stops immediately with `compose build requires
buildx 0.17.0 or later` and nothing starts. It is easy to miss when installing
only the Compose plugin, because `docker compose version` then reports a perfectly
healthy Compose and only builds fail.

Unlike Compose, Buildx publishes no `latest/download` alias - its release assets
carry the version in the filename - so the version above is pinned. Take the
current one from https://github.com/docker/buildx/releases; anything from 0.17.0
up satisfies Compose.

On `arm64`, substitute `docker-compose-linux-aarch64` and
`buildx-$BUILDX.linux-arm64`.

Node is not needed on the instance. Everything compiles inside the images. The
`npm run prod*` scripts in `console/package.json` are conveniences for a machine
that happens to have npm; every command below is given in its raw
`docker compose` form so the box stays minimal.

## 5. The console

### 5.1 Clone and configure

    sudo mkdir -p /opt && sudo chown ec2-user:ec2-user /opt
    cd /opt
    git clone <your-repo-url> rtc_telnyx
    cd rtc_telnyx/console
    cp .env.prod.example .env.prod

Edit `.env.prod`:

    CONSOLE_DOMAIN=console.example.com

    POSTGRES_USER=console
    POSTGRES_PASSWORD=<openssl rand -hex 32>
    POSTGRES_DB=console
    DATABASE_URL=postgres://console:<same password>@postgres:5432/console?sslmode=disable

    SESSION_SECRET=<openssl rand -hex 32>

    S3_BUCKET=your-production-bucket
    S3_REGION=eu-central-1

    WORKER_BASE_URL=https://rtc-telnyx.<subdomain>.workers.dev
    WORKER_TRIGGER_SECRET=<the Worker's TRIGGER_SECRET>
    WORKER_HMAC_SECRET=<the Worker's CONSOLE_HMAC_SECRET>
    PUBLIC_BASE_URL=https://console.example.com
    DIALER=cf-worker

    TELNYX_API_KEY=<the same key the Worker holds>
    OPENAI_API_KEY=sk-...

Points where this goes wrong:

- **The password appears twice.** `POSTGRES_PASSWORD` and the password embedded
  in `DATABASE_URL` must be identical, and URL-encoded if it contains `@`, `/`
  or `:`. Hex output avoids the question.
- **`CONSOLE_DOMAIN` must exactly match the DNS record.** Caddy requests a
  certificate for that literal name.
- **`PUBLIC_BASE_URL` must be `https://`.** The API refuses to start otherwise
  when `DIALER=cf-worker`, because the Worker rejects `http` callback URLs.
- **`SESSION_SECRET` needs 32+ characters**, and `WORKER_HMAC_SECRET` likewise.
  Both are enforced by the zod schema in `api/src/config.ts` at boot.
- **The file is `.env.prod`, not `.env`.** Compose reads `.env` automatically
  for *both* compose files, so production values placed there would silently
  reconfigure `npm run dev` - starting with `DIALER=cf-worker`, which dials real
  phones.
- **No AWS keys.** If you set `AWS_ACCESS_KEY_ID` here it will override the
  instance role. Leave them out. Likewise `S3_ENDPOINT`, which exists only to
  point at MinIO locally and would send production traffic somewhere wrong.

Lock the file down: `chmod 600 .env.prod`.

### 5.2 Start the stack

    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

The first run takes several minutes. In order:

1. Postgres starts and becomes healthy.
2. `migrate`, a dbmate one-shot, applies `db/migrations` and exits. The API
   waits on `service_completed_successfully`, so it can never come up against
   an unmigrated schema.
3. `api` and `worker` start from the same image with different commands.
   Exactly one `worker` container - a second would double the dial rate against
   the same number pool.
4. `web` builds the SPA, copies it into a named volume, and exits. Seeing it in
   `Exited (0)` is correct, not a failure.
5. `caddy` starts, requests a certificate from Let's Encrypt, and serves.

Watch it settle:

    docker compose --env-file .env.prod -f docker-compose.prod.yml ps
    docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api worker
    docker compose --env-file .env.prod -f docker-compose.prod.yml logs caddy | grep -i certificate

### 5.3 Verify

From your own machine:

    curl -I https://console.example.com/

A `200` with a valid certificate means Caddy, the SPA volume and DNS are all
correct. Then open it in a browser and expect the login page.

The API's `/health` is deliberately *not* reachable from the internet - the
`Caddyfile` proxies only `/api/*` and `/callbacks/*`, and everything else falls
through to the SPA. Check it from inside the network instead:

    docker compose --env-file .env.prod -f docker-compose.prod.yml \
      exec caddy wget -qO- http://api:3000/health

Expect `{"ok":true}`.

### 5.4 Create accounts and numbers

There is no registration endpoint. Accounts are created against the running
stack with the CLI, and a user needs a tenant unless it is a platform admin, so
the tenant comes first:

    CLI="docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm --no-deps api node api/dist/cli/index.js"

    $CLI create-tenant --name "Acme" --slug acme
    $CLI create-user --email ops@example.com --platform-admin
    $CLI create-user --email a@acme.com --tenant acme
    $CLI add-number --e164 +37069000001 --telnyx-id <telnyx-number-id>

Generated passwords are printed once and are not recoverable;
`$CLI reset-password --email a@acme.com` issues a new one. Without at least one
number in the pool nothing will ever dial, however many campaigns are running.

## 6. Telnyx

Do this once, in the Telnyx portal.

1. Buy a number.
2. Create a **Voice API application** (Call Control, API v2). Its id is
   `TELNYX_CONNECTION_ID`.
3. Set the application's webhook URL to
   `https://rtc-telnyx.<subdomain>.workers.dev/webhooks/telnyx`. The Worker also
   passes `webhook_url` per call, but setting it here keeps the two consistent.
4. Assign the number to that application.
5. Copy the Ed25519 public key from the portal into `TELNYX_PUBLIC_KEY`. It is
   used to verify every inbound webhook signature and is not the API key.
6. Add the number to the console's pool, via the admin screen or `add-number`
   above.

## 7. The first real call

This dials a real phone and bills the Telnyx account. Use a number you own.

In the console: create a campaign, upload one short question and a thank-you,
add a single contact with your own number, and launch it. Then watch both
sides at once:

    # your machine
    cd cf-worker && npx wrangler tail

    # the instance
    docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api worker

The sequence to expect in `wrangler tail` is `command_sent record_start`,
`command_sent streaming_start`, `stream_open`, `vad_armed`, `answer_ended`, then
the next playback. In the console logs, `call.answered`, `call.hangup`,
`call.recording.saved`, and an `ingest_recording` job that completes.

## Operating notes

**Updating.** Pull and rebuild; the migration one-shot runs again automatically
and is a no-op when there is nothing new:

    cd /opt/rtc_telnyx && git pull
    cd console
    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

The Worker is updated independently, from your machine, with `npm run deploy`.
Nothing coordinates the two, so if a change spans both, deploy the Worker first
and take the console down for the moment in between.

**Backups.** Postgres holds tenants, campaigns, contacts, calls and job state;
S3 holds the audio. Only the first is on the instance:

    docker compose --env-file .env.prod -f docker-compose.prod.yml \
      exec postgres pg_dump -U console console | gzip > console-$(date +%F).sql.gz

**Stopping.** `down` keeps the volumes, so the database and certificates
survive:

    docker compose --env-file .env.prod -f docker-compose.prod.yml down

Adding `-v` destroys `pgdata` and every account with it.

**Stuck jobs.** The queue is a plain Postgres table, drained with
`SELECT ... FOR UPDATE SKIP LOCKED`, retried with exponential backoff up to
`max_attempts`:

    select kind, attempts, last_error, failed_at
      from jobs where completed_at is null;

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every dial fails with 401 | `WORKER_TRIGGER_SECRET` does not match the Worker's `TRIGGER_SECRET` |
| Calls dial, then never finish | `WORKER_HMAC_SECRET` does not match `CONSOLE_HMAC_SECRET`; the console rejects every callback |
| Caddy cannot get a certificate | The DNS record is proxied (orange cloud), port 80 is closed, DNS has not propagated, or a CAA record excludes Let's Encrypt |
| API exits at boot | `loadConfig` rejected the environment. The log names the offending variable |
| Campaign launches, nothing dials | No numbers in the pool, or every number is leased |
| Call connects but never advances | Background noise is holding the answer open. Raise `SPEECH_THRESHOLD` in `cf-worker/src/vad.ts` and redeploy |
| Every answer runs exactly 30 seconds | `SPEECH_THRESHOLD` is too high; the answer is ending at the `MAX_ANSWER_MS` cap |
| Audio upload succeeds, playback 403s | `S3_REGION` does not match the bucket's region, or the presigned URL expired |
| Recordings never appear in S3 | Ingest jobs are failing; check `last_error` in `jobs` |
| Build is OOM-killed | The instance is too small. See 4.1 |
| `compose build requires buildx 0.17.0 or later` | The `docker-buildx` CLI plugin is missing or too old on the instance. Installing the Compose plugin alone is not enough. See 4.5 |

One subtlety worth knowing before it bites: presigned URLs are signed with the
instance role's temporary credentials, so a URL cannot outlive the credentials
that signed it, whatever expiry was requested. Instance credentials are valid
for hours and refreshed automatically, so the one-hour presign the dispatcher
uses is comfortably safe - but this is why a URL can occasionally die earlier
than its stated expiry.

## Testing

    cd cf-worker && npm test && npm run typecheck    # 140 tests, no credentials
    cd console && npm run dev && npm test            # needs Postgres and MinIO

The Worker's suite is entirely pure. The console's API suite talks to a real
Postgres and a real MinIO, because the number of things worth testing there
that touch neither is small; `npm run dev` brings both up. The one significant
gap is `cf-worker/src/session.ts`, the Durable Object, which has no unit tests -
verifying a change to it means placing a real call.
