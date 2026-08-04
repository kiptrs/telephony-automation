# Console Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-tenant console up to the point where a tenant can log in, create a campaign, upload its audio, and import its contact list - with no calling of any kind.

**Architecture:** An npm workspace under `console/` holding a Fastify API, a React 19 SPA, and a shared zod schema package. Postgres is reached through raw SQL with `pg`; every row is parsed through a zod schema at the database boundary so no ORM is needed and no type is asserted into existence. Migrations are plain SQL run by dbmate. Local infrastructure (Postgres, MinIO) comes up in Docker.

**Tech Stack:** Node 24.11.0, TypeScript strict, Fastify, `pg`, zod, dbmate, argon2, AWS SDK v3, React 19, Vite 8, TanStack Query, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-console-design.md`. This plan implements the "Plan 1 - Foundation" scope from that spec's Implementation Plans section. Dispatch, the number pool, the cf-worker changes, and the media pipeline are Plans 2 and 3 and must not be built here.

## Global Constraints

- Node **24.11.0** exactly, pinned in `.nvmrc`, `package.json#engines`, and every Docker base image.
- React **19**, Vite **8**, TypeScript **strict** with `noUncheckedIndexedAccess: true`. Do not widen a type to make a build pass.
- **No ORM.** Raw SQL only. Migrations are dbmate `.sql` files with `-- migrate:up` and `-- migrate:down`.
- **No SQL in route handlers or services.** SQL lives only in `queries.ts` modules.
- **Every database row is parsed through a zod schema** before leaving its query module.
- **No emojis** in source or docs.
- **Git is read-only.** Do not run `git add`, `git commit`, or `git checkout`. The operator manages history. Every task therefore ends with a verification step instead of a commit step.
- All ids are `uuid` defaulting to `gen_random_uuid()`. All timestamps are `timestamptz`.
- Tenant-owned query functions take `tenantId` as their first parameter and include it in the `WHERE` clause. No exceptions.

## File Structure

```
console/
  package.json                    npm workspaces root, shared scripts
  .nvmrc                          24.11.0
  .env.example                    every variable config.ts reads
  docker-compose.dev.yml          postgres, minio, minio-init, dbmate
  db/migrations/                  dbmate SQL files
  packages/shared/
    src/index.ts                  re-exports
    src/campaign.ts               campaign zod schemas shared api <-> web
    src/contact.ts                contact import request/response schemas
    src/auth.ts                   login request/response schemas
  api/
    src/config.ts                 env parsed by zod, throws at boot
    src/db/client.ts              pg Pool, query(), withTransaction()
    src/db/rows.ts                parseRows/parseOne zod boundary helpers
    src/auth/passwords.ts         argon2id hash + verify
    src/auth/queries.ts           user and session SQL
    src/auth/sessions.ts          create, look up, revoke
    src/auth/middleware.ts        requireUser, requireTenant, requirePlatformAdmin
    src/auth/routes.ts            login, logout, me
    src/campaigns/queries.ts      campaign + question SQL
    src/campaigns/service.ts      launch validation, question reordering
    src/campaigns/routes.ts
    src/contacts/parse.ts         CSV + pasted text -> E.164, pure
    src/contacts/queries.ts
    src/contacts/routes.ts
    src/audio/routes.ts           multipart upload, presigned playback
    src/s3.ts                     S3 client, put/presign
    src/server.ts                 Fastify bootstrap and route registration
    src/cli/index.ts              create-tenant, create-user, reset-password, add-number
    test/                         vitest
  web/
    index.html
    vite.config.ts
    src/main.tsx  src/App.tsx
    src/api/client.ts             typed fetch wrapper
    src/routes/Login.tsx
    src/routes/Campaigns.tsx
    src/routes/CampaignWizard.tsx
```

Split is by responsibility, not by layer: everything about campaigns lives in `campaigns/`, everything about auth in `auth/`. `queries.ts`/`service.ts`/`routes.ts` inside each is the repeated shape.

---

### Task 1: Workspace scaffold and local infrastructure

**Files:**
- Create: `console/package.json`, `console/.nvmrc`, `console/.env.example`
- Create: `console/tsconfig.base.json`
- Create: `console/api/package.json`, `console/api/tsconfig.json`
- Create: `console/packages/shared/package.json`, `console/packages/shared/tsconfig.json`, `console/packages/shared/src/index.ts`
- Create: `console/docker-compose.dev.yml`
- Create: `console/api/src/config.ts`
- Test: `console/api/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` from `api/src/config.ts`, where `Config` has `databaseUrl: string`, `port: number`, `sessionSecret: string`, `s3: { endpoint: string | null, region: string, bucket: string, forcePathStyle: boolean }`, `nodeEnv: "development" | "production" | "test"`. Every later task reads configuration only through this.

- [ ] **Step 1: Create the workspace root**

`console/package.json`:

```json
{
  "name": "console",
  "private": true,
  "type": "module",
  "workspaces": ["api", "web", "packages/*"],
  "engines": { "node": "24.11.0" },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "infra:up": "docker compose -f docker-compose.dev.yml up -d",
    "infra:down": "docker compose -f docker-compose.dev.yml down",
    "migrate": "docker compose -f docker-compose.dev.yml run --rm dbmate up"
  }
}
```

`console/.nvmrc` contains exactly:

```
24.11.0
```

- [ ] **Step 2: Create the shared TypeScript config**

`console/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Create the shared package**

`console/packages/shared/package.json`:

```json
{
  "name": "@console/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "^3.23.8" }
}
```

`console/packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`console/packages/shared/src/index.ts`:

```ts
export const SHARED_PACKAGE_VERSION = "0.0.0";
```

- [ ] **Step 4: Create the api package**

`console/api/package.json`:

```json
{
  "name": "@console/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/server.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@console/shared": "*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`console/api/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Write the failing config test**

`console/api/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://console:console@localhost:5432/console",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  S3_BUCKET: "console-dev",
  S3_REGION: "us-east-1",
  NODE_ENV: "test",
};

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    const config = loadConfig(valid);
    expect(config.databaseUrl).toBe(valid.DATABASE_URL);
    expect(config.s3.bucket).toBe("console-dev");
    expect(config.port).toBe(3000);
  });

  it("defaults S3 to real AWS when no endpoint is given", () => {
    const config = loadConfig(valid);
    expect(config.s3.endpoint).toBeNull();
    expect(config.s3.forcePathStyle).toBe(false);
  });

  it("uses path style when an endpoint is set, because MinIO requires it", () => {
    const config = loadConfig({ ...valid, S3_ENDPOINT: "http://localhost:9000" });
    expect(config.s3.endpoint).toBe("http://localhost:9000");
    expect(config.s3.forcePathStyle).toBe(true);
  });

  it("throws when DATABASE_URL is missing rather than starting up broken", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects a session secret short enough to brute force", () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd console && npm install && npm run test --workspace @console/api`
Expected: FAIL - cannot resolve `../src/config.js`.

- [ ] **Step 7: Implement config.ts**

`console/api/src/config.ts`:

```ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_SECRET: z.string().min(32),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export interface Config {
  databaseUrl: string;
  port: number;
  sessionSecret: string;
  nodeEnv: "development" | "production" | "test";
  s3: {
    endpoint: string | null;
    region: string;
    bucket: string;
    /** MinIO cannot serve virtual-hosted-style buckets, so a custom endpoint implies path style. */
    forcePathStyle: boolean;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment: ${detail}`);
  }

  const value = parsed.data;
  const endpoint = value.S3_ENDPOINT ?? null;

  return {
    databaseUrl: value.DATABASE_URL,
    port: value.PORT,
    sessionSecret: value.SESSION_SECRET,
    nodeEnv: value.NODE_ENV,
    s3: {
      endpoint,
      region: value.S3_REGION,
      bucket: value.S3_BUCKET,
      forcePathStyle: endpoint !== null,
    },
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd console && npm run test --workspace @console/api`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the dev compose file**

`console/docker-compose.dev.yml`:

```yaml
name: console-dev

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: console
      POSTGRES_PASSWORD: console
      POSTGRES_DB: console
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U console"]
      interval: 2s
      timeout: 3s
      retries: 20

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: console
      MINIO_ROOT_PASSWORD: consoleconsole
    ports: ["9000:9000", "9001:9001"]
    volumes: ["miniodata:/data"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 2s
      timeout: 3s
      retries: 20

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 console consoleconsole &&
      mc mb --ignore-existing local/console-dev &&
      echo minio ready
      "

  dbmate:
    image: ghcr.io/amacneil/dbmate:2
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://console:console@postgres:5432/console?sslmode=disable
    volumes: ["./db:/db"]
    command: ["--wait", "up"]

volumes:
  pgdata:
  miniodata:
```

- [ ] **Step 10: Write .env.example**

`console/.env.example`:

```
DATABASE_URL=postgres://console:console@localhost:5432/console?sslmode=disable
PORT=3000
SESSION_SECRET=change-me-to-at-least-32-characters-long
S3_BUCKET=console-dev
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=console
AWS_SECRET_ACCESS_KEY=consoleconsole
NODE_ENV=development
```

- [ ] **Step 11: Create the migrations directory**

The `dbmate` service bind-mounts `./db`, and Docker would otherwise create it
root-owned on first run. Create it with a placeholder now:

Run: `mkdir -p console/db/migrations && touch console/db/migrations/.gitkeep`

- [ ] **Step 12: Verify infrastructure comes up**

Run: `cd console && npm run infra:up`
Then: `docker compose -f docker-compose.dev.yml ps`
Expected: `postgres` and `minio` both healthy, `minio-init` exited 0.
Then: `npm run typecheck`
Expected: no errors.

---

### Task 2: Database schema

Only the tables this plan needs. `phone_numbers`, `number_leases`, `calls`,
`recordings`, `transcripts`, and `jobs` belong to Plans 2 and 3 and must not be
created here - dbmate migrations are additive, so adding them later is a new
file, not an edit to these.

**Files:**
- Create: `console/db/migrations/20260804090000_extensions.sql`
- Create: `console/db/migrations/20260804090100_tenants_and_users.sql`
- Create: `console/db/migrations/20260804090200_campaigns.sql`
- Create: `console/db/migrations/20260804090300_contacts.sql`

**Interfaces:**
- Consumes: the `dbmate` service from Task 1.
- Produces: tables `tenants`, `users`, `sessions`, `campaigns`,
  `campaign_questions`, `contacts`. Every later task's SQL targets these exact
  column names.

- [ ] **Step 1: Enable the extensions**

`console/db/migrations/20260804090000_extensions.sql`:

```sql
-- migrate:up
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- migrate:down
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pgcrypto;
```

`pgcrypto` supplies `gen_random_uuid()`. `citext` makes email uniqueness
case-insensitive without every query remembering to lower-case.

- [ ] **Step 2: Create tenants, users, and sessions**

`console/db/migrations/20260804090100_tenants_and_users.sql`:

```sql
-- migrate:up
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants (id) ON DELETE CASCADE,
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_valid CHECK (role IN ('platform_admin', 'member')),
  -- A platform admin belongs to no tenant; a member must belong to one.
  -- Encoding this here means no application bug can produce a member with
  -- NULL tenant_id, which would silently escape every tenant-scoped query.
  CONSTRAINT users_tenant_matches_role CHECK (
    (role = 'platform_admin' AND tenant_id IS NULL) OR
    (role = 'member' AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX users_tenant_id_idx ON users (tenant_id);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- migrate:down
DROP TABLE sessions;
DROP TABLE users;
DROP TABLE tenants;
```

- [ ] **Step 3: Create campaigns and their questions**

`console/db/migrations/20260804090200_campaigns.sql`:

```sql
-- migrate:up
CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- Whisper's language hint, ISO-639-1, e.g. 'lt'.
  language         text NOT NULL,
  -- The region used to parse local-format numbers, ISO-3166-1, e.g. 'LT'.
  -- Separate from language because a Lithuanian-language campaign may call
  -- numbers in another country.
  default_country  char(2) NOT NULL,
  silence_ms       integer NOT NULL DEFAULT 2500,
  thanks_s3_key    text,
  status           text NOT NULL DEFAULT 'draft',
  created_at       timestamptz NOT NULL DEFAULT now(),
  launched_at      timestamptz,
  CONSTRAINT campaigns_status_valid
    CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  -- Mirrors the Worker's accepted range in flow.ts.
  CONSTRAINT campaigns_silence_ms_valid
    CHECK (silence_ms BETWEEN 500 AND 10000)
);

CREATE INDEX campaigns_tenant_id_idx ON campaigns (tenant_id, created_at DESC);

CREATE TABLE campaign_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  position           integer NOT NULL,
  s3_key             text NOT NULL,
  original_filename  text NOT NULL,
  bytes              bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- 1-based to match flow.ts, where question() indexes questions[step - 1].
  CONSTRAINT campaign_questions_position_valid CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT campaign_questions_position_unique UNIQUE (campaign_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX campaign_questions_campaign_id_idx
  ON campaign_questions (campaign_id, position);

-- migrate:down
DROP TABLE campaign_questions;
DROP TABLE campaigns;
```

The unique constraint is `DEFERRABLE` because reordering questions rewrites
several `position` values in one transaction and would otherwise collide
mid-update. Task 9 defers it explicitly.

- [ ] **Step 4: Create contacts**

`console/db/migrations/20260804090300_contacts.sql`:

```sql
-- migrate:up
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  e164          text NOT NULL,
  external_ref  text,
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_status_valid
    CHECK (status IN ('pending', 'dialing', 'done')),
  CONSTRAINT contacts_e164_format CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT contacts_unique_per_campaign UNIQUE (campaign_id, e164)
);

-- Supports the dispatcher's "next pending contact" claim in Plan 2.
CREATE INDEX contacts_pending_idx
  ON contacts (campaign_id, created_at) WHERE status = 'pending';

-- migrate:down
DROP TABLE contacts;
```

- [ ] **Step 5: Run the migrations**

Run: `cd console && npm run migrate`
Expected: dbmate prints `Applying: 20260804090000_extensions.sql` through
`20260804090300_contacts.sql` with no errors.

- [ ] **Step 6: Verify the schema and the role constraint**

Run:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres \
  psql -U console -d console -c "\dt"
```

Expected: `campaign_questions`, `campaigns`, `contacts`, `schema_migrations`,
`sessions`, `tenants`, `users`.

Then prove the check constraint actually bites:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U console -d console -c \
  "INSERT INTO users (email, password_hash, role) VALUES ('x@y.z', 'h', 'member');"
```

Expected: FAIL with `violates check constraint "users_tenant_matches_role"`.

- [ ] **Step 7: Verify rollback works**

Run: `docker compose -f docker-compose.dev.yml run --rm dbmate down`
Expected: drops `contacts` cleanly.
Then: `npm run migrate` to restore.

---

### Task 3: Database client and the zod row boundary

This is the piece that replaces an ORM. Without it, `result.rows[0]` is `any`
and every query module invents its own types.

**Files:**
- Create: `console/api/src/db/client.ts`
- Create: `console/api/src/db/rows.ts`
- Test: `console/api/test/rows.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from Task 1.
- Produces:
  - `createPool(config: Config): Pool`
  - `withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T>`
  - `parseRows<T>(schema: ZodType<T>, result: QueryResult): T[]`
  - `parseOne<T>(schema: ZodType<T>, result: QueryResult): T | null`
  - `parseExactlyOne<T>(schema: ZodType<T>, result: QueryResult): T`
  - `RowParseError` (exported class)

  Every `queries.ts` module in every later task returns values through these.

- [ ] **Step 1: Add the pg dependency**

Run: `cd console && npm install --workspace @console/api pg` and
`npm install --workspace @console/api --save-dev @types/pg`

- [ ] **Step 2: Write the failing row-boundary test**

`console/api/test/rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseExactlyOne,
  parseOne,
  parseRows,
  RowParseError,
} from "../src/db/rows.js";

const userRow = z.object({
  id: z.string().uuid(),
  email: z.string(),
  created_at: z.date(),
});

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length } as never;
}

const validRow = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "a@b.c",
  created_at: new Date("2026-08-04T00:00:00Z"),
};

describe("parseRows", () => {
  it("parses every row", () => {
    const parsed = parseRows(userRow, result([validRow, validRow]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.email).toBe("a@b.c");
  });

  it("returns an empty array for no rows", () => {
    expect(parseRows(userRow, result([]))).toEqual([]);
  });

  it("throws on a column the schema does not describe as expected", () => {
    const bad = { ...validRow, created_at: "2026-08-04" };
    expect(() => parseRows(userRow, result([bad]))).toThrow(RowParseError);
  });

  it("names the offending column, because a silent shape drift is unfindable", () => {
    const bad = { ...validRow, created_at: "2026-08-04" };
    expect(() => parseRows(userRow, result([bad]))).toThrow(/created_at/);
  });
});

describe("parseOne", () => {
  it("returns the row when there is one", () => {
    expect(parseOne(userRow, result([validRow]))?.email).toBe("a@b.c");
  });

  it("returns null for no rows", () => {
    expect(parseOne(userRow, result([]))).toBeNull();
  });

  it("throws when a supposedly unique lookup returned several rows", () => {
    expect(() => parseOne(userRow, result([validRow, validRow]))).toThrow(
      /expected at most 1 row/,
    );
  });
});

describe("parseExactlyOne", () => {
  it("returns the row", () => {
    expect(parseExactlyOne(userRow, result([validRow])).email).toBe("a@b.c");
  });

  it("throws for no rows, so a failed RETURNING is never mistaken for success", () => {
    expect(() => parseExactlyOne(userRow, result([]))).toThrow(
      /expected exactly 1 row/,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- rows`
Expected: FAIL - cannot resolve `../src/db/rows.js`.

- [ ] **Step 4: Implement rows.ts**

`console/api/src/db/rows.ts`:

```ts
import type { QueryResult } from "pg";
import type { ZodType } from "zod";

/**
 * Raised when the database returned a shape the caller did not expect. This is
 * always a bug - a migration and a query drifted apart - so it carries the
 * column path rather than a generic validation message.
 */
export class RowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowParseError";
  }
}

export function parseRows<T>(schema: ZodType<T>, result: QueryResult): T[] {
  return result.rows.map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new RowParseError(`row ${index} did not match schema - ${detail}`);
    }
    return parsed.data;
  });
}

export function parseOne<T>(schema: ZodType<T>, result: QueryResult): T | null {
  if (result.rows.length > 1) {
    throw new RowParseError(
      `expected at most 1 row, got ${result.rows.length}`,
    );
  }
  const [row] = parseRows(schema, result);
  return row ?? null;
}

export function parseExactlyOne<T>(schema: ZodType<T>, result: QueryResult): T {
  const row = parseOne(schema, result);
  if (row === null) throw new RowParseError("expected exactly 1 row, got 0");
  return row;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- rows`
Expected: PASS, 9 tests.

- [ ] **Step 6: Implement the pool and transaction helper**

`console/api/src/db/client.ts`:

```ts
import pg from "pg";
import type { Config } from "../config.js";

const { Pool, types } = pg;

// node-postgres returns bigint as a string to avoid precision loss. Every
// bigint column in this schema is a byte count that fits in a JS number, and
// silently receiving a string where a number is expected is worse than the
// theoretical overflow.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export type { Pool, PoolClient } from "pg";

export function createPool(config: Config): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Runs fn inside a transaction, rolling back on any throw. Callers must use
 * the supplied client, not the pool, or their statements land outside the
 * transaction and the rollback silently does nothing.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 7: Verify it connects to the real database**

Run:

```bash
cd console/api && node --experimental-strip-types -e "
import { loadConfig } from './src/config.ts';
import { createPool } from './src/db/client.ts';
const pool = createPool(loadConfig({
  DATABASE_URL: 'postgres://console:console@localhost:5432/console',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  S3_BUCKET: 'console-dev',
}));
const r = await pool.query('SELECT count(*)::int AS n FROM tenants');
console.log('tenants:', r.rows[0].n);
await pool.end();
"
```

Expected: `tenants: 0`.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 4: Password hashing and session storage

**Files:**
- Create: `console/api/src/auth/passwords.ts`
- Create: `console/api/src/auth/queries.ts`
- Create: `console/api/src/auth/sessions.ts`
- Test: `console/api/test/passwords.test.ts`
- Test: `console/api/test/sessions.test.ts`

**Interfaces:**
- Consumes: `createPool`, `parseOne`, `parseExactlyOne`, `parseRows` from Task 3.
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `AuthenticatedUser = { id: string; tenantId: string | null; email: string; role: "platform_admin" | "member" }`
  - `findUserByEmail(pool, email): Promise<(AuthenticatedUser & { passwordHash: string }) | null>`
  - `insertUser(client, args): Promise<AuthenticatedUser>`
  - `createSession(pool, userId): Promise<{ id: string; expiresAt: Date }>`
  - `findUserBySession(pool, sessionId): Promise<AuthenticatedUser | null>`
  - `deleteSession(pool, sessionId): Promise<void>`
  - `SESSION_TTL_DAYS = 7`

  Task 5 uses all of these; Task 7's CLI uses `hashPassword` and `insertUser`.

- [ ] **Step 1: Add argon2**

Run: `cd console && npm install --workspace @console/api argon2`

- [ ] **Step 2: Write the failing password test**

`console/api/test/passwords.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("produces a different hash each time, so equal passwords are not linkable", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("uses argon2id", async () => {
    expect(await hashPassword("x")).toMatch(/^\$argon2id\$/);
  });

  it("returns false rather than throwing on a corrupt hash", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- passwords`
Expected: FAIL - cannot resolve `../src/auth/passwords.js`.

- [ ] **Step 4: Implement passwords.ts**

`console/api/src/auth/passwords.ts`:

```ts
import argon2 from "argon2";

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * A malformed stored hash means a corrupted row, not an authenticated user, so
 * it fails closed rather than propagating an exception into the login route.
 */
export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- passwords`
Expected: PASS, 5 tests.

- [ ] **Step 6: Implement the auth queries**

`console/api/src/auth/queries.ts`:

```ts
import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { parseExactlyOne, parseOne } from "../db/rows.js";

export const roleSchema = z.enum(["platform_admin", "member"]);
export type Role = z.infer<typeof roleSchema>;

export interface AuthenticatedUser {
  id: string;
  tenantId: string | null;
  email: string;
  role: Role;
}

const userRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  email: z.string(),
  role: roleSchema,
});

const userWithHashRow = userRow.extend({ password_hash: z.string() });

function toUser(row: z.infer<typeof userRow>): AuthenticatedUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
  };
}

export async function findUserByEmail(
  pool: Pool,
  email: string,
): Promise<(AuthenticatedUser & { passwordHash: string }) | null> {
  const result = await pool.query(
    `SELECT id, tenant_id, email, role, password_hash
       FROM users
      WHERE email = $1`,
    [email],
  );
  const row = parseOne(userWithHashRow, result);
  if (row === null) return null;
  return { ...toUser(row), passwordHash: row.password_hash };
}

export async function insertUser(
  client: Pool | PoolClient,
  args: {
    email: string;
    passwordHash: string;
    role: Role;
    tenantId: string | null;
  },
): Promise<AuthenticatedUser> {
  const result = await client.query(
    `INSERT INTO users (email, password_hash, role, tenant_id)
          VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, email, role`,
    [args.email, args.passwordHash, args.role, args.tenantId],
  );
  return toUser(parseExactlyOne(userRow, result));
}

export async function updatePasswordHash(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET password_hash = $2 WHERE email = $1`,
    [email, passwordHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export const sessionUserRow = userRow;
```

- [ ] **Step 7: Implement sessions.ts**

`console/api/src/auth/sessions.ts`:

```ts
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne } from "../db/rows.js";
import { roleSchema, type AuthenticatedUser } from "./queries.js";

/** Absolute expiry with no sliding renewal - see the spec's Authentication section. */
export const SESSION_TTL_DAYS = 7;

const createdRow = z.object({
  id: z.string().uuid(),
  expires_at: z.date(),
});

const sessionUserRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  email: z.string(),
  role: roleSchema,
});

export async function createSession(
  pool: Pool,
  userId: string,
): Promise<{ id: string; expiresAt: Date }> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, expires_at)
          VALUES ($1, now() + make_interval(days => $2))
       RETURNING id, expires_at`,
    [userId, SESSION_TTL_DAYS],
  );
  const row = parseExactlyOne(createdRow, result);
  return { id: row.id, expiresAt: row.expires_at };
}

/**
 * Expiry is filtered in SQL rather than compared in JS so the database clock is
 * the only clock that matters.
 */
export async function findUserBySession(
  pool: Pool,
  sessionId: string,
): Promise<AuthenticatedUser | null> {
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = parseOne(sessionUserRow, result);
  if (row === null) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
  };
}

export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

export async function deleteSessionsForUser(
  pool: Pool,
  userId: string,
): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}
```

- [ ] **Step 8: Write the session integration test**

This one needs the real database, because expiry is enforced by Postgres.

`console/api/test/sessions.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import {
  createSession,
  deleteSession,
  findUserBySession,
} from "../src/auth/sessions.js";

const config = loadConfig({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://console:console@localhost:5432/console",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  S3_BUCKET: "console-dev",
  NODE_ENV: "test",
});

let pool: Pool;
let tenantId: string;

beforeAll(() => {
  pool = createPool(config);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
  const result = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id",
  );
  tenantId = result.rows[0].id as string;
});

async function makeUser(email: string) {
  return insertUser(pool, {
    email,
    passwordHash: await hashPassword("password"),
    role: "member",
    tenantId,
  });
}

describe("sessions", () => {
  it("resolves a live session back to its user", async () => {
    const user = await makeUser("a@acme.com");
    const session = await createSession(pool, user.id);
    const found = await findUserBySession(pool, session.id);
    expect(found?.id).toBe(user.id);
    expect(found?.tenantId).toBe(tenantId);
  });

  it("returns null for an unknown session id", async () => {
    const missing = "11111111-1111-4111-8111-111111111111";
    expect(await findUserBySession(pool, missing)).toBeNull();
  });

  it("refuses an expired session", async () => {
    const user = await makeUser("b@acme.com");
    const session = await createSession(pool, user.id);
    await pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
      [session.id],
    );
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });

  it("revokes immediately on delete, which is why this is not a JWT", async () => {
    const user = await makeUser("c@acme.com");
    const session = await createSession(pool, user.id);
    await deleteSession(pool, session.id);
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });

  it("cascades session deletion when the user is deleted", async () => {
    const user = await makeUser("d@acme.com");
    const session = await createSession(pool, user.id);
    await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    expect(await findUserBySession(pool, session.id)).toBeNull();
  });
});
```

- [ ] **Step 9: Run the session tests**

Run: `cd console && npm run infra:up && npm run migrate && npm run test --workspace @console/api -- sessions`
Expected: PASS, 5 tests.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 5: Fastify server, auth middleware, and login

**Files:**
- Create: `console/packages/shared/src/auth.ts`
- Modify: `console/packages/shared/src/index.ts`
- Create: `console/api/src/auth/middleware.ts`
- Create: `console/api/src/auth/routes.ts`
- Create: `console/api/src/server.ts`
- Create: `console/api/src/app.ts`
- Test: `console/api/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: everything from Task 4, `createPool` from Task 3, `loadConfig` from Task 1.
- Produces:
  - `buildApp(deps: { pool: Pool; config: Config }): FastifyInstance` from `app.ts`. Every later task registers its routes inside this function.
  - `requireUser(request): AuthenticatedUser` - throws a 401 if unauthenticated.
  - `requireTenant(request): { user: AuthenticatedUser; tenantId: string }` - throws 401 if unauthenticated, 403 if the user is a platform admin with no tenant.
  - `requirePlatformAdmin(request): AuthenticatedUser` - throws 403 for members.
  - `SESSION_COOKIE = "console_session"`
  - Shared schemas `loginRequestSchema`, `meResponseSchema`.

`buildApp` taking its dependencies as an argument rather than importing a
module-level pool is what makes the route tests in this and every later task
possible without a running server.

- [ ] **Step 1: Add Fastify and its cookie plugin**

Run: `cd console && npm install --workspace @console/api fastify @fastify/cookie`

- [ ] **Step 2: Add the shared auth schemas**

`console/packages/shared/src/auth.ts`:

```ts
import { z } from "zod";

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(["platform_admin", "member"]),
  tenantId: z.string().uuid().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
```

`console/packages/shared/src/index.ts`:

```ts
export * from "./auth.js";
```

- [ ] **Step 3: Write the failing auth route test**

`console/api/test/auth-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Pool } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";

const config = loadConfig({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://console:console@localhost:5432/console",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  S3_BUCKET: "console-dev",
  NODE_ENV: "test",
});

let pool: Pool;
let app: FastifyInstance;

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
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
  const tenant = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id",
  );
  await insertUser(pool, {
    email: "a@acme.com",
    passwordHash: await hashPassword("password123"),
    role: "member",
    tenantId: tenant.rows[0].id as string,
  });
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("no session cookie was set");
  return value.split(";")[0] ?? "";
}

describe("POST /api/auth/login", () => {
  it("sets a session cookie for correct credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    expect(response.statusCode).toBe(200);
    expect(cookieFrom(response)).toMatch(/^console_session=/);
  });

  it("marks the cookie httpOnly and SameSite=Lax", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const raw = response.headers["set-cookie"];
    const value = Array.isArray(raw) ? raw[0] : String(raw);
    expect(value).toMatch(/HttpOnly/i);
    expect(value).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("gives an unknown email the same 401 and message as a wrong password", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@acme.com", password: "password123" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "wrong" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("rejects a malformed body with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the logged-in user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieFrom(login) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe("a@acme.com");
    expect(response.json().tenantId).toEqual(expect.any(String));
  });

  it("returns 401 without a cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a garbage cookie rather than failing to parse a uuid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "console_session=not-a-uuid" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the session immediately", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@acme.com", password: "password123" },
    });
    const cookie = cookieFrom(login);

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- auth-routes`
Expected: FAIL - cannot resolve `../src/app.js`.

- [ ] **Step 5: Implement the middleware**

`console/api/src/auth/middleware.ts`:

```ts
import type { FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "./queries.js";

export const SESSION_COOKIE = "console_session";

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw new HttpError(401, "unauthorized");
  return user;
}

/**
 * The only place a request becomes a tenantId. It reads the session and never
 * the URL or body, which is what makes tenant isolation a property of the
 * system rather than something each route has to remember.
 */
export function requireTenant(request: FastifyRequest): {
  user: AuthenticatedUser;
  tenantId: string;
} {
  const user = requireUser(request);
  if (user.tenantId === null) {
    throw new HttpError(403, "this endpoint requires a tenant account");
  }
  return { user, tenantId: user.tenantId };
}

export function requirePlatformAdmin(request: FastifyRequest): AuthenticatedUser {
  const user = requireUser(request);
  if (user.role !== "platform_admin") throw new HttpError(403, "forbidden");
  return user;
}
```

- [ ] **Step 6: Implement the auth routes**

`console/api/src/auth/routes.ts`:

```ts
import { loginRequestSchema } from "@console/shared";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { HttpError, requireUser, SESSION_COOKIE } from "./middleware.js";
import { verifyPassword } from "./passwords.js";
import { findUserByEmail } from "./queries.js";
import { createSession, deleteSession, SESSION_TTL_DAYS } from "./sessions.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config },
): void {
  const { pool, config } = deps;

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid credentials payload");

    const user = await findUserByEmail(pool, parsed.data.email);

    // An unknown email and a wrong password must be indistinguishable, or the
    // login form becomes an account enumeration oracle. The dummy verify keeps
    // the timing comparable too.
    const ok = user
      ? await verifyPassword(user.passwordHash, parsed.data.password)
      : await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aaaa", "x");

    if (!user || !ok) throw new HttpError(401, "invalid email or password");

    const session = await createSession(pool, user.id);

    reply.setCookie(SESSION_COOKIE, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await deleteSession(pool, sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const user = requireUser(request);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  });
}
```

- [ ] **Step 7: Implement app.ts**

`console/api/src/app.ts`:

```ts
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerAuthRoutes } from "./auth/routes.js";
import { HttpError, SESSION_COOKIE } from "./auth/middleware.js";
import { findUserBySession } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Pool } from "./db/client.js";
import { RowParseError } from "./db/rows.js";

const uuidSchema = z.string().uuid();

export interface AppDeps {
  pool: Pool;
  config: Config;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.nodeEnv !== "test" });

  app.register(cookie);

  // Resolves the session once per request. Routes then call requireUser or
  // requireTenant, so an unauthenticated request never reaches tenant data.
  app.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    // A cookie is attacker-controlled; sending a non-uuid straight to Postgres
    // would raise 22P02 rather than a clean 401.
    if (!uuidSchema.safeParse(raw).success) return;
    const user = await findUserBySession(deps.pool, raw);
    if (user) request.user = user;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error instanceof RowParseError) {
      request.log.error({ err: error }, "database row did not match schema");
      return reply.status(500).send({ error: "internal error" });
    }
    if (error.validation) {
      return reply.status(400).send({ error: "invalid request" });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "internal error" });
  });

  registerAuthRoutes(app, deps);

  app.get("/health", async () => ({ ok: true }));

  return app;
}
```

- [ ] **Step 8: Implement server.ts**

`console/api/src/server.ts`:

```ts
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";

const config = loadConfig(process.env);
const pool = createPool(config);
const app = buildApp({ pool, config });

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await app.listen({ port: config.port, host: "0.0.0.0" });
```

- [ ] **Step 9: Run the auth route tests**

Run: `cd console && npm run test --workspace @console/api -- auth-routes`
Expected: PASS, 9 tests.

- [ ] **Step 10: Verify the server actually boots**

Run: `cd console/api && cp ../.env.example .env && node --experimental-strip-types --env-file=.env src/server.ts &`
Then: `curl -s http://localhost:3000/health`
Expected: `{"ok":true}`. Stop the process afterwards.

- [ ] **Step 11: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 6: Account provisioning CLI

There is no registration endpoint and no admin UI in v1, so this CLI is the only
way an account comes into existence. `add-number` writes to a table that does
not exist until Plan 2, so it is deliberately not implemented here.

**Files:**
- Create: `console/api/src/cli/index.ts`
- Create: `console/api/src/cli/commands.ts`
- Create: `console/api/src/tenants/queries.ts`
- Modify: `console/api/package.json` (add the `cli` script)
- Test: `console/api/test/cli-commands.test.ts`

**Interfaces:**
- Consumes: `hashPassword` and `insertUser` from Task 4, `updatePasswordHash` from Task 4, `createPool` from Task 3.
- Produces:
  - `insertTenant(pool, args: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string }>`
  - `findTenantBySlug(pool, slug): Promise<{ id: string; name: string; slug: string } | null>`
  - `createTenantCommand`, `createUserCommand`, `resetPasswordCommand` - each takes `(pool, args)` and returns a printable result object. The CLI wrapper does argument parsing and printing only.
  - `generatePassword(): string`

- [ ] **Step 1: Implement the tenant queries**

`console/api/src/tenants/queries.ts`:

```ts
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const tenantRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export type Tenant = z.infer<typeof tenantRow>;

export async function insertTenant(
  pool: Pool,
  args: { name: string; slug: string },
): Promise<Tenant> {
  const result = await pool.query(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug`,
    [args.name, args.slug],
  );
  return parseExactlyOne(tenantRow, result);
}

export async function findTenantBySlug(
  pool: Pool,
  slug: string,
): Promise<Tenant | null> {
  const result = await pool.query(
    `SELECT id, name, slug FROM tenants WHERE slug = $1`,
    [slug],
  );
  return parseOne(tenantRow, result);
}

export async function listTenants(pool: Pool): Promise<Tenant[]> {
  const result = await pool.query(
    `SELECT id, name, slug FROM tenants ORDER BY created_at`,
  );
  return parseRows(tenantRow, result);
}
```

- [ ] **Step 2: Write the failing CLI command test**

`console/api/test/cli-commands.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTenantCommand,
  createUserCommand,
  generatePassword,
  resetPasswordCommand,
} from "../src/cli/commands.js";
import { verifyPassword } from "../src/auth/passwords.js";
import { findUserByEmail } from "../src/auth/queries.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Pool } from "../src/db/client.js";

const config = loadConfig({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://console:console@localhost:5432/console",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  S3_BUCKET: "console-dev",
  NODE_ENV: "test",
});

let pool: Pool;

beforeAll(() => {
  pool = createPool(config);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
});

describe("generatePassword", () => {
  it("is long enough to resist offline guessing", () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(20);
  });

  it("differs every call", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("createTenantCommand", () => {
  it("creates a tenant", async () => {
    const tenant = await createTenantCommand(pool, {
      name: "Acme",
      slug: "acme",
    });
    expect(tenant.slug).toBe("acme");
  });

  it("refuses a duplicate slug with a readable message", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    await expect(
      createTenantCommand(pool, { name: "Other", slug: "acme" }),
    ).rejects.toThrow(/slug 'acme' already exists/);
  });
});

describe("createUserCommand", () => {
  it("creates a member inside a tenant and returns the password once", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    const created = await createUserCommand(pool, {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    });

    expect(created.password).toEqual(expect.any(String));
    const stored = await findUserByEmail(pool, "a@acme.com");
    expect(stored?.role).toBe("member");
    expect(await verifyPassword(stored!.passwordHash, created.password)).toBe(true);
  });

  it("creates a platform admin with no tenant", async () => {
    await createUserCommand(pool, {
      email: "ops@example.com",
      tenantSlug: null,
      platformAdmin: true,
    });
    const stored = await findUserByEmail(pool, "ops@example.com");
    expect(stored?.role).toBe("platform_admin");
    expect(stored?.tenantId).toBeNull();
  });

  it("refuses a member with no tenant, rather than letting the DB check fire", async () => {
    await expect(
      createUserCommand(pool, {
        email: "a@acme.com",
        tenantSlug: null,
        platformAdmin: false,
      }),
    ).rejects.toThrow(/--tenant is required/);
  });

  it("refuses an unknown tenant slug", async () => {
    await expect(
      createUserCommand(pool, {
        email: "a@acme.com",
        tenantSlug: "nope",
        platformAdmin: false,
      }),
    ).rejects.toThrow(/no tenant with slug 'nope'/);
  });

  it("refuses a duplicate email", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    const args = {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    };
    await createUserCommand(pool, args);
    await expect(createUserCommand(pool, args)).rejects.toThrow(/already exists/);
  });
});

describe("resetPasswordCommand", () => {
  it("replaces the hash and returns the new password", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    await createUserCommand(pool, {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    });

    const reset = await resetPasswordCommand(pool, { email: "a@acme.com" });
    const stored = await findUserByEmail(pool, "a@acme.com");
    expect(await verifyPassword(stored!.passwordHash, reset.password)).toBe(true);
  });

  it("refuses an unknown email", async () => {
    await expect(
      resetPasswordCommand(pool, { email: "nobody@acme.com" }),
    ).rejects.toThrow(/no user with email/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- cli-commands`
Expected: FAIL - cannot resolve `../src/cli/commands.js`.

- [ ] **Step 4: Implement the commands**

`console/api/src/cli/commands.ts`:

```ts
import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.js";
import {
  findUserByEmail,
  insertUser,
  updatePasswordHash,
} from "../auth/queries.js";
import type { Pool } from "../db/client.js";
import {
  findTenantBySlug,
  insertTenant,
  type Tenant,
} from "../tenants/queries.js";

/** 24 base64url characters, roughly 144 bits. Shown once and never stored. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function createTenantCommand(
  pool: Pool,
  args: { name: string; slug: string },
): Promise<Tenant> {
  const existing = await findTenantBySlug(pool, args.slug);
  if (existing) throw new Error(`slug '${args.slug}' already exists`);
  return insertTenant(pool, args);
}

export async function createUserCommand(
  pool: Pool,
  args: { email: string; tenantSlug: string | null; platformAdmin: boolean },
): Promise<{ email: string; role: string; password: string }> {
  if (!args.platformAdmin && args.tenantSlug === null) {
    throw new Error("--tenant is required unless --platform-admin is given");
  }
  if (args.platformAdmin && args.tenantSlug !== null) {
    throw new Error("a platform admin cannot belong to a tenant");
  }

  const existing = await findUserByEmail(pool, args.email);
  if (existing) throw new Error(`a user with email ${args.email} already exists`);

  let tenantId: string | null = null;
  if (args.tenantSlug !== null) {
    const tenant = await findTenantBySlug(pool, args.tenantSlug);
    if (!tenant) throw new Error(`no tenant with slug '${args.tenantSlug}'`);
    tenantId = tenant.id;
  }

  const password = generatePassword();
  const user = await insertUser(pool, {
    email: args.email,
    passwordHash: await hashPassword(password),
    role: args.platformAdmin ? "platform_admin" : "member",
    tenantId,
  });

  return { email: user.email, role: user.role, password };
}

export async function resetPasswordCommand(
  pool: Pool,
  args: { email: string },
): Promise<{ email: string; password: string }> {
  const password = generatePassword();
  const updated = await updatePasswordHash(
    pool,
    args.email,
    await hashPassword(password),
  );
  if (!updated) throw new Error(`no user with email ${args.email}`);
  return { email: args.email, password };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- cli-commands`
Expected: PASS, 11 tests.

- [ ] **Step 6: Implement the CLI wrapper**

`console/api/src/cli/index.ts`:

```ts
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createPool } from "../db/client.js";
import { listTenants } from "../tenants/queries.js";
import {
  createTenantCommand,
  createUserCommand,
  resetPasswordCommand,
} from "./commands.js";

const USAGE = `Usage:
  cli create-tenant --name <name> --slug <slug>
  cli create-user --email <email> (--tenant <slug> | --platform-admin)
  cli reset-password --email <email>
  cli list-tenants
`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      email: { type: "string" },
      tenant: { type: "string" },
      "platform-admin": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const pool = createPool(loadConfig(process.env));

  try {
    switch (command) {
      case "create-tenant": {
        if (!values.name || !values.slug) throw new Error("--name and --slug are required");
        const tenant = await createTenantCommand(pool, {
          name: values.name,
          slug: values.slug,
        });
        console.log(`created tenant ${tenant.slug} (${tenant.id})`);
        break;
      }
      case "create-user": {
        if (!values.email) throw new Error("--email is required");
        const created = await createUserCommand(pool, {
          email: values.email,
          tenantSlug: values.tenant ?? null,
          platformAdmin: values["platform-admin"] === true,
        });
        console.log(`created ${created.role} ${created.email}`);
        console.log(`password: ${created.password}`);
        console.log("This password is shown once and is not recoverable.");
        break;
      }
      case "reset-password": {
        if (!values.email) throw new Error("--email is required");
        const reset = await resetPasswordCommand(pool, { email: values.email });
        console.log(`password for ${reset.email}: ${reset.password}`);
        console.log("This password is shown once and is not recoverable.");
        break;
      }
      case "list-tenants": {
        for (const tenant of await listTenants(pool)) {
          console.log(`${tenant.slug}\t${tenant.name}\t${tenant.id}`);
        }
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
```

- [ ] **Step 7: Add the cli script**

Add to `console/api/package.json` scripts:

```json
"cli": "node --experimental-strip-types --env-file=.env src/cli/index.ts"
```

- [ ] **Step 8: Verify the CLI end to end**

Run:

```bash
cd console/api
npm run cli -- create-tenant --name "Acme" --slug acme
npm run cli -- create-user --email a@acme.com --tenant acme
npm run cli -- list-tenants
```

Expected: a tenant id, a generated password printed once, and the tenant listed.
Then log in with those credentials against the running server:

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@acme.com","password":"<printed password>"}'
```

Expected: a JSON user object and a `set-cookie` header.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 7: Campaign CRUD and the tenant isolation suite

Campaigns are the first tenant-owned resource, so this is where the isolation
guarantee stops being a convention and becomes a test.

**Files:**
- Create: `console/packages/shared/src/campaign.ts`
- Modify: `console/packages/shared/src/index.ts`
- Create: `console/api/src/campaigns/queries.ts`
- Create: `console/api/src/campaigns/routes.ts`
- Modify: `console/api/src/app.ts` (register the routes)
- Test: `console/api/test/campaigns.test.ts`
- Test: `console/api/test/tenant-isolation.test.ts`
- Create: `console/api/test/helpers.ts`

**Interfaces:**
- Consumes: `requireTenant`, `HttpError` from Task 5; `buildApp` from Task 5.
- Produces:
  - `campaignSchema`, `createCampaignSchema`, `updateCampaignSchema` in shared.
  - `listCampaigns(pool, tenantId): Promise<Campaign[]>`
  - `findCampaign(pool, tenantId, id): Promise<Campaign | null>`
  - `insertCampaign(pool, tenantId, args): Promise<Campaign>`
  - `updateCampaign(pool, tenantId, id, args): Promise<Campaign | null>`
  - `deleteDraftCampaign(pool, tenantId, id): Promise<boolean>`
  - Test helpers `seedTenant(pool, slug)`, `loginAs(app, email, password)`.

- [ ] **Step 1: Add the shared campaign schemas**

`console/packages/shared/src/campaign.ts`:

```ts
import { z } from "zod";

export const campaignStatusSchema = z.enum([
  "draft",
  "running",
  "paused",
  "completed",
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 10_000;
export const DEFAULT_SILENCE_MS = 2500;
export const MAX_QUESTIONS = 10;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Whisper's hint, ISO-639-1.
  language: z.string().trim().length(2).toLowerCase(),
  // E.164 parsing region, ISO-3166-1 alpha-2.
  defaultCountry: z.string().trim().length(2).toUpperCase(),
  silenceMs: z
    .number()
    .int()
    .min(MIN_SILENCE_MS)
    .max(MAX_SILENCE_MS)
    .default(DEFAULT_SILENCE_MS),
});
export type CreateCampaignRequest = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = createCampaignSchema.partial();
export type UpdateCampaignRequest = z.infer<typeof updateCampaignSchema>;

export const campaignSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  language: z.string(),
  defaultCountry: z.string(),
  silenceMs: z.number().int(),
  status: campaignStatusSchema,
  thanksUploaded: z.boolean(),
  questionCount: z.number().int(),
  contactCount: z.number().int(),
  createdAt: z.string(),
});
export type Campaign = z.infer<typeof campaignSchema>;
```

Add to `console/packages/shared/src/index.ts`:

```ts
export * from "./campaign.js";
```

- [ ] **Step 2: Write the test helpers**

`console/api/test/helpers.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/queries.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Pool } from "../src/db/client.js";

export const TEST_PASSWORD = "test-password-123";

export function testConfig(): Config {
  return loadConfig({
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgres://console:console@localhost:5432/console",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    S3_BUCKET: "console-dev",
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    NODE_ENV: "test",
  });
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE tenants, users, sessions CASCADE");
}

/** Creates a tenant plus one member, and returns both plus that member's cookie-ready credentials. */
export async function seedTenant(
  pool: Pool,
  slug: string,
): Promise<{ tenantId: string; email: string; userId: string }> {
  const tenant = await pool.query(
    "INSERT INTO tenants (name, slug) VALUES ($1, $1) RETURNING id",
    [slug],
  );
  const tenantId = tenant.rows[0].id as string;
  const email = `user@${slug}.test`;
  const user = await insertUser(pool, {
    email,
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: "member",
    tenantId,
  });
  return { tenantId, email, userId: user.id };
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${response.statusCode}`);
  }
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new Error("no session cookie");
  return value.split(";")[0] ?? "";
}
```

- [ ] **Step 3: Write the failing campaign test**

`console/api/test/campaigns.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  const config = testConfig();
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
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);
});

const valid = {
  name: "August survey",
  language: "lt",
  defaultCountry: "LT",
  silenceMs: 3000,
};

async function createCampaign(body: unknown = valid) {
  return app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie },
    payload: body,
  });
}

describe("POST /api/campaigns", () => {
  it("creates a draft campaign", async () => {
    const response = await createCampaign();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("draft");
    expect(body.questionCount).toBe(0);
    expect(body.contactCount).toBe(0);
    expect(body.thanksUploaded).toBe(false);
  });

  it("defaults silenceMs to 2500 when omitted", async () => {
    const { silenceMs: _omitted, ...rest } = valid;
    const response = await createCampaign(rest);
    expect(response.json().silenceMs).toBe(2500);
  });

  it("rejects a silenceMs outside the Worker's accepted range", async () => {
    expect((await createCampaign({ ...valid, silenceMs: 250 })).statusCode).toBe(400);
    expect((await createCampaign({ ...valid, silenceMs: 20000 })).statusCode).toBe(400);
  });

  it("rejects an empty name", async () => {
    expect((await createCampaign({ ...valid, name: "  " })).statusCode).toBe(400);
  });

  it("normalises language to lower case and country to upper case", async () => {
    const response = await createCampaign({
      ...valid,
      language: "LT",
      defaultCountry: "lt",
    });
    expect(response.json().language).toBe("lt");
    expect(response.json().defaultCountry).toBe("LT");
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      payload: valid,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/campaigns", () => {
  it("lists newest first", async () => {
    await createCampaign({ ...valid, name: "first" });
    await createCampaign({ ...valid, name: "second" });
    const response = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { cookie },
    });
    expect(response.json().map((c: { name: string }) => c.name)).toEqual([
      "second",
      "first",
    ]);
  });
});

describe("PATCH /api/campaigns/:id", () => {
  it("updates only the given fields", async () => {
    const created = (await createCampaign()).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
      payload: { name: "renamed" },
    });
    expect(response.json().name).toBe("renamed");
    expect(response.json().language).toBe("lt");
  });

  it("returns 404 for an unknown id", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/campaigns/11111111-1111-4111-8111-111111111111",
      headers: { cookie },
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed id rather than 500", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/campaigns/not-a-uuid",
      headers: { cookie },
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("DELETE /api/campaigns/:id", () => {
  it("deletes a draft", async () => {
    const created = (await createCampaign()).json();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);
  });

  it("refuses to delete a campaign that has been launched", async () => {
    const created = (await createCampaign()).json();
    await pool.query("UPDATE campaigns SET status = 'running' WHERE id = $1", [
      created.id,
    ]);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- campaigns`
Expected: FAIL - 404 on every route, because they are not registered yet.

- [ ] **Step 5: Implement the campaign queries**

`console/api/src/campaigns/queries.ts`:

```ts
import type { Campaign } from "@console/shared";
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const campaignRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  language: z.string(),
  default_country: z.string(),
  silence_ms: z.number().int(),
  status: z.enum(["draft", "running", "paused", "completed"]),
  thanks_s3_key: z.string().nullable(),
  question_count: z.number().int(),
  contact_count: z.number().int(),
  created_at: z.date(),
});

function toCampaign(row: z.infer<typeof campaignRow>): Campaign {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    defaultCountry: row.default_country,
    silenceMs: row.silence_ms,
    status: row.status,
    thanksUploaded: row.thanks_s3_key !== null,
    questionCount: row.question_count,
    contactCount: row.contact_count,
    createdAt: row.created_at.toISOString(),
  };
}

// The counts are subqueries rather than joins so a campaign with no questions
// and no contacts still returns exactly one row.
const SELECT_CAMPAIGN = `
  SELECT c.id, c.name, c.language, c.default_country, c.silence_ms, c.status,
         c.thanks_s3_key, c.created_at,
         (SELECT count(*)::int FROM campaign_questions q WHERE q.campaign_id = c.id)
           AS question_count,
         (SELECT count(*)::int FROM contacts ct WHERE ct.campaign_id = c.id)
           AS contact_count
    FROM campaigns c
`;

export async function listCampaigns(
  pool: Pool,
  tenantId: string,
): Promise<Campaign[]> {
  const result = await pool.query(
    `${SELECT_CAMPAIGN} WHERE c.tenant_id = $1 ORDER BY c.created_at DESC`,
    [tenantId],
  );
  return parseRows(campaignRow, result).map(toCampaign);
}

export async function findCampaign(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<Campaign | null> {
  const result = await pool.query(
    `${SELECT_CAMPAIGN} WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, id],
  );
  const row = parseOne(campaignRow, result);
  return row === null ? null : toCampaign(row);
}

export async function insertCampaign(
  pool: Pool,
  tenantId: string,
  args: {
    name: string;
    language: string;
    defaultCountry: string;
    silenceMs: number;
  },
): Promise<Campaign> {
  const inserted = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country, silence_ms)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
    [tenantId, args.name, args.language, args.defaultCountry, args.silenceMs],
  );
  const { id } = parseExactlyOne(z.object({ id: z.string().uuid() }), inserted);
  const campaign = await findCampaign(pool, tenantId, id);
  if (campaign === null) throw new Error("campaign vanished after insert");
  return campaign;
}

export async function updateCampaign(
  pool: Pool,
  tenantId: string,
  id: string,
  args: {
    name?: string;
    language?: string;
    defaultCountry?: string;
    silenceMs?: number;
  },
): Promise<Campaign | null> {
  // COALESCE keeps this a single statement while leaving omitted fields alone.
  const result = await pool.query(
    `UPDATE campaigns
        SET name = COALESCE($3, name),
            language = COALESCE($4, language),
            default_country = COALESCE($5, default_country),
            silence_ms = COALESCE($6, silence_ms)
      WHERE tenant_id = $1 AND id = $2
      RETURNING id`,
    [
      tenantId,
      id,
      args.name ?? null,
      args.language ?? null,
      args.defaultCountry ?? null,
      args.silenceMs ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return findCampaign(pool, tenantId, id);
}

export async function deleteDraftCampaign(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<"deleted" | "not_found" | "not_draft"> {
  const found = await pool.query(
    `SELECT status FROM campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = parseOne(z.object({ status: z.string() }), found);
  if (row === null) return "not_found";
  if (row.status !== "draft") return "not_draft";

  await pool.query(`DELETE FROM campaigns WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return "deleted";
}
```

- [ ] **Step 6: Implement the campaign routes**

`console/api/src/campaigns/routes.ts`:

```ts
import { createCampaignSchema, updateCampaignSchema } from "@console/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import type { Pool } from "../db/client.js";
import {
  deleteDraftCampaign,
  findCampaign,
  insertCampaign,
  listCampaigns,
  updateCampaign,
} from "./queries.js";

const paramsSchema = z.object({ id: z.string().uuid() });

/** A malformed id is a client mistake, not a missing resource. */
export function parseCampaignId(params: unknown): string {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new HttpError(400, "invalid campaign id");
  return parsed.data.id;
}

export function registerCampaignRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  app.get("/api/campaigns", async (request) => {
    const { tenantId } = requireTenant(request);
    return listCampaigns(pool, tenantId);
  });

  app.post("/api/campaigns", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const parsed = createCampaignSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid campaign payload");

    const campaign = await insertCampaign(pool, tenantId, parsed.data);
    return reply.status(201).send(campaign);
  });

  app.get("/api/campaigns/:id", async (request) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);
    const campaign = await findCampaign(pool, tenantId, id);
    // 404 and not 403: a 403 would confirm the campaign exists in another tenant.
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  });

  app.patch("/api/campaigns/:id", async (request) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);
    const parsed = updateCampaignSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid campaign payload");

    const campaign = await updateCampaign(pool, tenantId, id, parsed.data);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  });

  app.delete("/api/campaigns/:id", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);

    switch (await deleteDraftCampaign(pool, tenantId, id)) {
      case "not_found":
        throw new HttpError(404, "campaign not found");
      case "not_draft":
        throw new HttpError(409, "only a draft campaign can be deleted");
      case "deleted":
        return reply.status(204).send();
    }
  });
}
```

- [ ] **Step 7: Register the routes**

In `console/api/src/app.ts`, add the import and call it next to `registerAuthRoutes`:

```ts
import { registerCampaignRoutes } from "./campaigns/routes.js";
```

```ts
  registerAuthRoutes(app, deps);
  registerCampaignRoutes(app, deps);
```

- [ ] **Step 8: Run the campaign tests**

Run: `cd console && npm run test --workspace @console/api -- campaigns`
Expected: PASS, 12 tests.

- [ ] **Step 9: Write the tenant isolation suite**

`console/api/test/tenant-isolation.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let acmeCookie: string;
let globexCookie: string;
let acmeCampaignId: string;

beforeAll(async () => {
  const config = testConfig();
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
  const acme = await seedTenant(pool, "acme");
  const globex = await seedTenant(pool, "globex");
  acmeCookie = await loginAs(app, acme.email);
  globexCookie = await loginAs(app, globex.email);

  const created = await app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie: acmeCookie },
    payload: {
      name: "Acme survey",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    },
  });
  acmeCampaignId = created.json().id;
});

describe("tenant isolation", () => {
  it("hides another tenant's campaign from the list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { cookie: globexCookie },
    });
    expect(response.json()).toEqual([]);
  });

  // 404 and not 403 throughout: a 403 confirms the resource exists, which is
  // itself a cross-tenant leak.
  it("returns 404, not 403, when reading another tenant's campaign", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when patching another tenant's campaign", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
      payload: { name: "hijacked" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not modify the campaign it refused to patch", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
      payload: { name: "hijacked" },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.json().name).toBe("Acme survey");
  });

  it("returns 404 when deleting another tenant's campaign", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("still leaves the campaign intact for its owner after a refused delete", async () => {
    await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 10: Run the isolation suite**

Run: `cd console && npm run test --workspace @console/api -- tenant-isolation`
Expected: PASS, 6 tests.

**Every later task that adds a tenant-owned route adds its cases to this file.**

- [ ] **Step 11: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 8: S3 storage and audio upload

**Files:**
- Create: `console/api/src/s3.ts`
- Create: `console/api/src/audio/keys.ts`
- Create: `console/api/src/audio/queries.ts`
- Create: `console/api/src/audio/routes.ts`
- Modify: `console/api/src/app.ts` (register multipart plugin and the routes)
- Modify: `console/api/test/tenant-isolation.test.ts` (add audio cases)
- Test: `console/api/test/audio-keys.test.ts`
- Test: `console/api/test/audio-routes.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1, `requireTenant`/`HttpError` from Task 5, `parseCampaignId` and `findCampaign` from Task 7.
- Produces:
  - `createS3(config: Config): S3Client`
  - `putObject(s3, config, args: { key: string; body: Buffer; contentType: string }): Promise<void>`
  - `presignGet(s3, config, key: string, expiresInSeconds: number): Promise<string>`
  - `questionKey(tenantId, campaignId, position, extension): string`
  - `thanksKey(tenantId, campaignId, extension): string`
  - `extensionForContentType(contentType: string): "mp3" | "wav" | null`
  - `Question = { id, position, s3Key, originalFilename, bytes }`
  - `listQuestions`, `findQuestion`, `insertQuestionAtEnd`, `deleteQuestionAndClose`, `reorderQuestions`, `setThanksKey`, `findThanksKey` in `audio/queries.ts`.

- [ ] **Step 1: Add the dependencies**

Run:

```bash
cd console
npm install --workspace @console/api @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @fastify/multipart
```

- [ ] **Step 2: Write the failing key test**

`console/api/test/audio-keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  extensionForContentType,
  questionKey,
  thanksKey,
} from "../src/audio/keys.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const campaign = "22222222-2222-4222-8222-222222222222";

describe("extensionForContentType", () => {
  it("maps the accepted audio types", () => {
    expect(extensionForContentType("audio/mpeg")).toBe("mp3");
    expect(extensionForContentType("audio/wav")).toBe("wav");
    expect(extensionForContentType("audio/x-wav")).toBe("wav");
  });

  it("ignores parameters on the content type", () => {
    expect(extensionForContentType("audio/mpeg; charset=binary")).toBe("mp3");
  });

  it("returns null for anything else, so an upload is refused not guessed", () => {
    expect(extensionForContentType("application/pdf")).toBeNull();
    expect(extensionForContentType("audio/ogg")).toBeNull();
  });
});

describe("questionKey", () => {
  it("namespaces by tenant then campaign", () => {
    const key = questionKey(tenant, campaign, 3, "mp3");
    expect(
      key.startsWith(`tenants/${tenant}/campaigns/${campaign}/questions/3-`),
    ).toBe(true);
    expect(key.endsWith(".mp3")).toBe(true);
  });

  it("is unique per call, so re-uploading a position never overwrites in place", () => {
    expect(questionKey(tenant, campaign, 1, "mp3")).not.toBe(
      questionKey(tenant, campaign, 1, "mp3"),
    );
  });
});

describe("thanksKey", () => {
  it("sits beside the questions", () => {
    expect(
      thanksKey(tenant, campaign, "wav").startsWith(
        `tenants/${tenant}/campaigns/${campaign}/thanks-`,
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- audio-keys`
Expected: FAIL - cannot resolve `../src/audio/keys.js`.

- [ ] **Step 4: Implement keys.ts**

`console/api/src/audio/keys.ts`:

```ts
import { randomUUID } from "node:crypto";

export type AudioExtension = "mp3" | "wav";

const CONTENT_TYPES: Record<string, AudioExtension> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export function extensionForContentType(
  contentType: string,
): AudioExtension | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPES[base] ?? null;
}

/**
 * A uuid segment makes every upload a new object. Replacing a question is then
 * a new key plus a row update rather than an overwrite, so a partially failed
 * upload can never leave a campaign pointing at a truncated object.
 */
export function questionKey(
  tenantId: string,
  campaignId: string,
  position: number,
  extension: AudioExtension,
): string {
  return `tenants/${tenantId}/campaigns/${campaignId}/questions/${position}-${randomUUID()}.${extension}`;
}

export function thanksKey(
  tenantId: string,
  campaignId: string,
  extension: AudioExtension,
): string {
  return `tenants/${tenantId}/campaigns/${campaignId}/thanks-${randomUUID()}.${extension}`;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- audio-keys`
Expected: PASS, 6 tests.

- [ ] **Step 6: Implement the S3 wrapper**

`console/api/src/s3.ts`:

```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";

export type { S3Client };

/**
 * In production no credentials are configured here at all - the SDK picks up
 * the EC2 instance role. Locally, S3_ENDPOINT points at MinIO and the
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY variables in .env are used.
 */
export function createS3(config: Config): S3Client {
  return new S3Client({
    region: config.s3.region,
    ...(config.s3.endpoint !== null
      ? {
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
        }
      : {}),
  });
}

export async function putObject(
  s3: S3Client,
  config: Config,
  args: { key: string; body: Buffer; contentType: string },
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
}

export function presignGet(
  s3: S3Client,
  config: Config,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
```

- [ ] **Step 7: Implement the audio queries**

`console/api/src/audio/queries.ts`:

```ts
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";

const questionRow = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  s3_key: z.string(),
  original_filename: z.string(),
  bytes: z.number().int(),
});

export interface Question {
  id: string;
  position: number;
  s3Key: string;
  originalFilename: string;
  bytes: number;
}

function toQuestion(row: z.infer<typeof questionRow>): Question {
  return {
    id: row.id,
    position: row.position,
    s3Key: row.s3_key,
    originalFilename: row.original_filename,
    bytes: row.bytes,
  };
}

/**
 * Joining through campaigns on every query is what keeps tenant scoping true
 * for a table that has no tenant_id of its own.
 */
export async function listQuestions(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<Question[]> {
  const result = await pool.query(
    `SELECT q.id, q.position, q.s3_key, q.original_filename, q.bytes
       FROM campaign_questions q
       JOIN campaigns c ON c.id = q.campaign_id
      WHERE c.tenant_id = $1 AND q.campaign_id = $2
      ORDER BY q.position`,
    [tenantId, campaignId],
  );
  return parseRows(questionRow, result).map(toQuestion);
}

export async function findQuestion(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  questionId: string,
): Promise<Question | null> {
  const result = await pool.query(
    `SELECT q.id, q.position, q.s3_key, q.original_filename, q.bytes
       FROM campaign_questions q
       JOIN campaigns c ON c.id = q.campaign_id
      WHERE c.tenant_id = $1 AND q.campaign_id = $2 AND q.id = $3`,
    [tenantId, campaignId, questionId],
  );
  const row = parseOne(questionRow, result);
  return row === null ? null : toQuestion(row);
}

/** Appends at the next free position. Returns null when the campaign is full. */
export async function insertQuestionAtEnd(
  pool: Pool,
  campaignId: string,
  args: { s3Key: string; originalFilename: string; bytes: number },
): Promise<Question | null> {
  const result = await pool.query(
    `INSERT INTO campaign_questions
            (campaign_id, position, s3_key, original_filename, bytes)
     SELECT $1, COALESCE(max(position), 0) + 1, $2, $3, $4
       FROM campaign_questions
      WHERE campaign_id = $1
     HAVING COALESCE(max(position), 0) + 1 <= 10
     RETURNING id, position, s3_key, original_filename, bytes`,
    [campaignId, args.s3Key, args.originalFilename, args.bytes],
  );
  const row = parseOne(questionRow, result);
  return row === null ? null : toQuestion(row);
}

/**
 * Deleting a question closes the gap it leaves, because launch requires
 * positions contiguous from 1 and a gap would be invisible in the UI.
 */
export async function deleteQuestionAndClose(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  questionId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const deleted = await client.query(
      `DELETE FROM campaign_questions q
        USING campaigns c
        WHERE c.id = q.campaign_id
          AND c.tenant_id = $1 AND q.campaign_id = $2 AND q.id = $3
      RETURNING q.position`,
      [tenantId, campaignId, questionId],
    );
    if ((deleted.rowCount ?? 0) === 0) return false;

    const { position } = parseExactlyOne(
      z.object({ position: z.number().int() }),
      deleted,
    );
    await client.query(
      `UPDATE campaign_questions
          SET position = position - 1
        WHERE campaign_id = $1 AND position > $2`,
      [campaignId, position],
    );
    return true;
  });
}

/**
 * Rewrites every position in one transaction. The unique constraint is
 * deferred first, because an in-place reorder always collides part way through.
 */
export async function reorderQuestions(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  orderedIds: string[],
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const owned = await client.query(
      `SELECT q.id
         FROM campaign_questions q
         JOIN campaigns c ON c.id = q.campaign_id
        WHERE c.tenant_id = $1 AND q.campaign_id = $2`,
      [tenantId, campaignId],
    );
    const existing = parseRows(z.object({ id: z.string().uuid() }), owned).map(
      (row) => row.id,
    );

    // The new order must be a permutation of the existing set, or a partial
    // list would silently drop questions.
    if (existing.length !== orderedIds.length) return false;
    if (!orderedIds.every((id) => existing.includes(id))) return false;

    await client.query(
      "SET CONSTRAINTS campaign_questions_position_unique DEFERRED",
    );
    for (const [index, id] of orderedIds.entries()) {
      await client.query(
        `UPDATE campaign_questions SET position = $2
          WHERE id = $1 AND campaign_id = $3`,
        [id, index + 1, campaignId],
      );
    }
    return true;
  });
}

export async function setThanksKey(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  key: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE campaigns SET thanks_s3_key = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, campaignId, key],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function findThanksKey(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT thanks_s3_key FROM campaigns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, campaignId],
  );
  const row = parseOne(
    z.object({ thanks_s3_key: z.string().nullable() }),
    result,
  );
  return row?.thanks_s3_key ?? null;
}
```

- [ ] **Step 8: Write the failing audio route test**

`console/api/test/audio-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let campaignId: string;

beforeAll(async () => {
  const config = testConfig();
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
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);
  const created = await app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie },
    payload: {
      name: "Survey",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    },
  });
  campaignId = created.json().id;
});

/** A minimal multipart body. The bytes need not be real audio - nothing decodes them. */
function multipart(filename: string, contentType: string, bytes = 1024) {
  const boundary = "----consoletest";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const body = Buffer.alloc(bytes, 1);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(filename = "q1.mp3", contentType = "audio/mpeg") {
  const part = multipart(filename, contentType);
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/questions`,
    headers: { ...part.headers, cookie },
    payload: part.payload,
  });
}

describe("POST /api/campaigns/:id/questions", () => {
  it("stores an mp3 and appends it at position 1", async () => {
    const response = await upload();
    expect(response.statusCode).toBe(201);
    expect(response.json().position).toBe(1);
    expect(response.json().originalFilename).toBe("q1.mp3");
  });

  it("appends subsequent uploads at the next position", async () => {
    await upload("q1.mp3");
    const second = await upload("q2.mp3");
    expect(second.json().position).toBe(2);
  });

  it("refuses a content type that is not audio", async () => {
    const response = await upload("notes.pdf", "application/pdf");
    expect(response.statusCode).toBe(400);
  });

  it("refuses an eleventh question, matching the Worker's MAX_QUESTIONS", async () => {
    for (let i = 0; i < 10; i++) await upload(`q${i + 1}.mp3`);
    const eleventh = await upload("q11.mp3");
    expect(eleventh.statusCode).toBe(409);
  });

  it("requires authentication", async () => {
    const part = multipart("q1.mp3", "audio/mpeg");
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: part.headers,
      payload: part.payload,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/campaigns/:id/questions", () => {
  it("lists in position order", async () => {
    await upload("q1.mp3");
    await upload("q2.mp3");
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: { cookie },
    });
    expect(
      response.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q1.mp3", "q2.mp3"]);
  });
});

describe("DELETE /api/campaigns/:id/questions/:qid", () => {
  it("closes the gap so positions stay contiguous", async () => {
    await upload("q1.mp3");
    const second = (await upload("q2.mp3")).json();
    await upload("q3.mp3");

    await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/questions/${second.id}`,
      headers: { cookie },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: { cookie },
    });
    expect(list.json().map((q: { position: number }) => q.position)).toEqual([1, 2]);
    expect(
      list.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q1.mp3", "q3.mp3"]);
  });
});

describe("PATCH /api/campaigns/:id/questions/order", () => {
  it("reverses the order without tripping the unique constraint", async () => {
    const first = (await upload("q1.mp3")).json();
    const second = (await upload("q2.mp3")).json();
    const third = (await upload("q3.mp3")).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${campaignId}/questions/order`,
      headers: { cookie },
      payload: { ids: [third.id, second.id, first.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q3.mp3", "q2.mp3", "q1.mp3"]);
  });

  it("refuses a partial list rather than silently dropping questions", async () => {
    const first = (await upload("q1.mp3")).json();
    await upload("q2.mp3");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${campaignId}/questions/order`,
      headers: { cookie },
      payload: { ids: [first.id] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("PUT /api/campaigns/:id/thanks", () => {
  it("marks the campaign as having a thanks file", async () => {
    const part = multipart("thanks.mp3", "audio/mpeg");
    const response = await app.inject({
      method: "PUT",
      url: `/api/campaigns/${campaignId}/thanks`,
      headers: { ...part.headers, cookie },
      payload: part.payload,
    });
    expect(response.statusCode).toBe(200);

    const campaign = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}`,
      headers: { cookie },
    });
    expect(campaign.json().thanksUploaded).toBe(true);
  });
});

describe("GET /api/campaigns/:id/questions/:qid/url", () => {
  it("returns a presigned URL for playback", async () => {
    const question = (await upload()).json();
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions/${question.id}/url`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/X-Amz-Signature=/);
  });

  it("returns 404 for an unknown question", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions/11111111-1111-4111-8111-111111111111/url`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- audio-routes`
Expected: FAIL - 404 on every route.

- [ ] **Step 10: Implement the audio routes**

`console/api/src/audio/routes.ts`:

```ts
import { MAX_QUESTIONS } from "@console/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import { findCampaign } from "../campaigns/queries.js";
import { parseCampaignId } from "../campaigns/routes.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { presignGet, putObject, type S3Client } from "../s3.js";
import { extensionForContentType, questionKey, thanksKey } from "./keys.js";
import {
  deleteQuestionAndClose,
  findQuestion,
  findThanksKey,
  insertQuestionAtEnd,
  listQuestions,
  reorderQuestions,
  setThanksKey,
} from "./queries.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

const questionIdSchema = z.object({ qid: z.string().uuid() });
const orderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

interface UploadedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

async function readUpload(request: FastifyRequest): Promise<UploadedFile> {
  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (!part) throw new HttpError(400, "a file part is required");

  const buffer = await part.toBuffer();
  // @fastify/multipart truncates rather than throwing, so an oversized upload
  // would otherwise be stored silently cut short.
  if (part.file.truncated) {
    throw new HttpError(413, "audio must be 10 MB or smaller");
  }
  return { buffer, filename: part.filename, contentType: part.mimetype };
}

export function registerAudioRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; s3: S3Client },
): void {
  const { pool, config, s3 } = deps;

  async function requireOwnedCampaign(
    tenantId: string,
    params: unknown,
  ): Promise<string> {
    const id = parseCampaignId(params);
    const campaign = await findCampaign(pool, tenantId, id);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return id;
  }

  app.get("/api/campaigns/:id/questions", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    return listQuestions(pool, tenantId, campaignId);
  });

  app.post("/api/campaigns/:id/questions", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const upload = await readUpload(request);
    const extension = extensionForContentType(upload.contentType);
    if (!extension) {
      throw new HttpError(400, "audio must be audio/mpeg or audio/wav");
    }

    const existing = await listQuestions(pool, tenantId, campaignId);
    if (existing.length >= MAX_QUESTIONS) {
      throw new HttpError(
        409,
        `a campaign holds at most ${MAX_QUESTIONS} questions`,
      );
    }

    const key = questionKey(tenantId, campaignId, existing.length + 1, extension);
    // S3 first: a row pointing at a missing object is worse than an orphaned
    // object, which costs only storage.
    await putObject(s3, config, {
      key,
      body: upload.buffer,
      contentType: upload.contentType,
    });

    const question = await insertQuestionAtEnd(pool, campaignId, {
      s3Key: key,
      originalFilename: upload.filename,
      bytes: upload.buffer.byteLength,
    });
    if (!question) {
      throw new HttpError(
        409,
        `a campaign holds at most ${MAX_QUESTIONS} questions`,
      );
    }

    return reply.status(201).send(question);
  });

  app.delete("/api/campaigns/:id/questions/:qid", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = questionIdSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid question id");

    const deleted = await deleteQuestionAndClose(
      pool,
      tenantId,
      campaignId,
      parsed.data.qid,
    );
    if (!deleted) throw new HttpError(404, "question not found");
    return reply.status(204).send();
  });

  app.patch("/api/campaigns/:id/questions/order", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid order payload");

    const ok = await reorderQuestions(pool, tenantId, campaignId, parsed.data.ids);
    if (!ok) throw new HttpError(400, "ids must list every question exactly once");
    return listQuestions(pool, tenantId, campaignId);
  });

  app.put("/api/campaigns/:id/thanks", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const upload = await readUpload(request);
    const extension = extensionForContentType(upload.contentType);
    if (!extension) {
      throw new HttpError(400, "audio must be audio/mpeg or audio/wav");
    }

    const key = thanksKey(tenantId, campaignId, extension);
    await putObject(s3, config, {
      key,
      body: upload.buffer,
      contentType: upload.contentType,
    });
    await setThanksKey(pool, tenantId, campaignId, key);
    return { ok: true };
  });

  app.get("/api/campaigns/:id/questions/:qid/url", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = questionIdSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid question id");

    const question = await findQuestion(pool, tenantId, campaignId, parsed.data.qid);
    if (!question) throw new HttpError(404, "question not found");

    return {
      url: await presignGet(s3, config, question.s3Key, PLAYBACK_URL_TTL_SECONDS),
    };
  });

  app.get("/api/campaigns/:id/thanks/url", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const key = await findThanksKey(pool, tenantId, campaignId);
    if (!key) throw new HttpError(404, "no thanks audio uploaded");
    return { url: await presignGet(s3, config, key, PLAYBACK_URL_TTL_SECONDS) };
  });
}
```

- [ ] **Step 11: Wire multipart and the routes into app.ts**

In `console/api/src/app.ts` add the imports:

```ts
import multipart from "@fastify/multipart";
import { registerAudioRoutes } from "./audio/routes.js";
import { createS3 } from "./s3.js";
```

Register the plugin next to `cookie`:

```ts
  app.register(multipart);
```

And create the client, then register the routes:

```ts
  const s3 = createS3(deps.config);

  registerAuthRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerAudioRoutes(app, { ...deps, s3 });
```

- [ ] **Step 12: Run the audio route tests**

Run: `cd console && npm run infra:up && npm run test --workspace @console/api -- audio-routes`
Expected: PASS, 12 tests. MinIO must be running for the put and presign calls.

- [ ] **Step 13: Add audio cases to the isolation suite**

Append inside the `describe("tenant isolation")` block in
`console/api/test/tenant-isolation.test.ts`:

```ts
  it("returns 404 when listing another tenant's questions", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/questions`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when uploading into another tenant's campaign", async () => {
    const boundary = "----consoletest";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      Buffer.alloc(64, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/questions`,
      headers: {
        cookie: globexCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's thanks audio URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/thanks/url`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });
```

- [ ] **Step 14: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green. The isolation suite is now 9 tests.

---

### Task 9: Contact list parsing

Pure logic, no database and no HTTP. Every rejection reason a user will ever see
is decided here.

**Files:**
- Create: `console/packages/shared/src/contact.ts`
- Modify: `console/packages/shared/src/index.ts`
- Create: `console/api/src/contacts/parse.ts`
- Test: `console/api/test/contacts-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ParsedContact = { e164: string; externalRef: string | null; sourceLine: number }`
  - `RejectedContact = { raw: string; reason: string; sourceLine: number }`
  - `ParseResult = { accepted: ParsedContact[]; rejected: RejectedContact[]; duplicatesInInput: RejectedContact[] }`
  - `parseContactCsv(csv: string, defaultCountry: string): ParseResult`
  - `parseContactText(text: string, defaultCountry: string): ParseResult`
  - `MAX_CONTACTS_PER_CAMPAIGN = 10_000`

- [ ] **Step 1: Add the dependencies**

Run:

```bash
cd console
npm install --workspace @console/api csv-parse libphonenumber-js
```

- [ ] **Step 2: Add the shared contact schemas**

`console/packages/shared/src/contact.ts`:

```ts
import { z } from "zod";

export const MAX_CONTACTS_PER_CAMPAIGN = 10_000;

export const parsedContactSchema = z.object({
  e164: z.string(),
  externalRef: z.string().nullable(),
  sourceLine: z.number().int(),
});
export type ParsedContact = z.infer<typeof parsedContactSchema>;

export const rejectedContactSchema = z.object({
  raw: z.string(),
  reason: z.string(),
  sourceLine: z.number().int(),
});
export type RejectedContact = z.infer<typeof rejectedContactSchema>;

export const contactPreviewRequestSchema = z.union([
  z.object({ csv: z.string().min(1) }),
  z.object({ text: z.string().min(1) }),
]);
export type ContactPreviewRequest = z.infer<typeof contactPreviewRequestSchema>;

export const contactPreviewResponseSchema = z.object({
  accepted: z.array(parsedContactSchema),
  rejected: z.array(rejectedContactSchema),
  duplicatesInInput: z.array(rejectedContactSchema),
  alreadyInCampaign: z.array(rejectedContactSchema),
});
export type ContactPreviewResponse = z.infer<typeof contactPreviewResponseSchema>;

export const contactImportRequestSchema = z.object({
  rows: z.array(parsedContactSchema).min(1),
});
export type ContactImportRequest = z.infer<typeof contactImportRequestSchema>;
```

Add to `console/packages/shared/src/index.ts`:

```ts
export * from "./contact.js";
```

- [ ] **Step 3: Write the failing parse test**

`console/api/test/contacts-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseContactCsv, parseContactText } from "../src/contacts/parse.js";

describe("parseContactText", () => {
  it("accepts one E.164 number per line", () => {
    const result = parseContactText("+37060000001\n+37060000002", "LT");
    expect(result.accepted.map((c) => c.e164)).toEqual([
      "+37060000001",
      "+37060000002",
    ]);
  });

  it("normalises a national-format number using the campaign country", () => {
    const result = parseContactText("860000001", "LT");
    expect(result.accepted[0]?.e164).toBe("+37060000001");
  });

  it("strips spaces, dashes, and parentheses", () => {
    const result = parseContactText("+370 (6) 00-000-01", "LT");
    expect(result.accepted[0]?.e164).toBe("+37060000001");
  });

  it("splits on commas as well as newlines", () => {
    const result = parseContactText("+37060000001, +37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("ignores blank lines without reporting them as rejected", () => {
    const result = parseContactText("+37060000001\n\n  \n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it("rejects an unparseable number with its line number", () => {
    const result = parseContactText("+37060000001\nnot-a-number", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0]?.sourceLine).toBe(2);
    expect(result.rejected[0]?.raw).toBe("not-a-number");
  });

  it("rejects a number that parses but is not a valid subscriber number", () => {
    const result = parseContactText("+37011", "LT");
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/not a valid phone number/);
  });

  it("reports a repeated number as a duplicate, keeping the first occurrence", () => {
    const result = parseContactText("+37060000001\n+37060000001", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicatesInInput).toHaveLength(1);
    expect(result.duplicatesInInput[0]?.sourceLine).toBe(2);
  });

  it("treats two spellings of the same number as one duplicate", () => {
    const result = parseContactText("+37060000001\n860000001", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicatesInInput).toHaveLength(1);
  });
});

describe("parseContactCsv", () => {
  it("uses the first column when there is no header", () => {
    const result = parseContactCsv("+37060000001\n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("finds a phone column by header name", () => {
    const csv = "name,phone\nAlice,+37060000001\nBob,+37060000002";
    const result = parseContactCsv(csv, "LT");
    expect(result.accepted.map((c) => c.e164)).toEqual([
      "+37060000001",
      "+37060000002",
    ]);
  });

  it("accepts number and msisdn as header aliases", () => {
    expect(parseContactCsv("number\n+37060000001", "LT").accepted).toHaveLength(1);
    expect(parseContactCsv("msisdn\n+37060000001", "LT").accepted).toHaveLength(1);
  });

  it("is case and whitespace insensitive about the header", () => {
    const result = parseContactCsv(" Phone \n+37060000001", "LT");
    expect(result.accepted).toHaveLength(1);
  });

  it("captures an optional ref column", () => {
    const csv = "phone,ref\n+37060000001,customer-7";
    const result = parseContactCsv(csv, "LT");
    expect(result.accepted[0]?.externalRef).toBe("customer-7");
  });

  it("leaves externalRef null when there is no ref column", () => {
    const result = parseContactCsv("phone\n+37060000001", "LT");
    expect(result.accepted[0]?.externalRef).toBeNull();
  });

  it("reports the line number from the file, header included", () => {
    const csv = "phone\n+37060000001\nbroken";
    const result = parseContactCsv(csv, "LT");
    expect(result.rejected[0]?.sourceLine).toBe(3);
  });

  it("rejects a row whose phone cell is empty", () => {
    const csv = "phone,ref\n,customer-7";
    const result = parseContactCsv(csv, "LT");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/empty/);
  });

  it("handles CRLF line endings, which is what Excel produces", () => {
    const result = parseContactCsv("phone\r\n+37060000001\r\n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("returns everything rejected rather than throwing on malformed CSV", () => {
    const result = parseContactCsv('phone\n"unclosed', "LT");
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- contacts-parse`
Expected: FAIL - cannot resolve `../src/contacts/parse.js`.

- [ ] **Step 5: Implement parse.ts**

`console/api/src/contacts/parse.ts`:

```ts
import type { ParsedContact, RejectedContact } from "@console/shared";
import { parse as parseCsv } from "csv-parse/sync";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface ParseResult {
  accepted: ParsedContact[];
  rejected: RejectedContact[];
  duplicatesInInput: RejectedContact[];
}

const PHONE_HEADERS = new Set(["phone", "number", "msisdn", "phone_number"]);
const REF_HEADERS = new Set(["ref", "external_ref", "reference", "id"]);

interface RawRow {
  phone: string;
  ref: string | null;
  sourceLine: number;
}

/**
 * Turns raw rows into a result, doing normalisation and duplicate detection in
 * one place so CSV and pasted text can never disagree about what is valid.
 */
function normalise(rows: RawRow[], defaultCountry: string): ParseResult {
  const accepted: ParsedContact[] = [];
  const rejected: RejectedContact[] = [];
  const duplicatesInInput: RejectedContact[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const raw = row.phone.trim();
    if (raw.length === 0) {
      rejected.push({
        raw: row.phone,
        reason: "phone value is empty",
        sourceLine: row.sourceLine,
      });
      continue;
    }

    const parsed = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
    if (!parsed || !parsed.isValid()) {
      rejected.push({
        raw,
        reason: "not a valid phone number for this campaign's country",
        sourceLine: row.sourceLine,
      });
      continue;
    }

    // Compare after normalisation so +37060000001 and 860000001 collide.
    const e164 = parsed.number;
    if (seen.has(e164)) {
      duplicatesInInput.push({
        raw,
        reason: `duplicate of ${e164} earlier in this list`,
        sourceLine: row.sourceLine,
      });
      continue;
    }

    seen.add(e164);
    accepted.push({ e164, externalRef: row.ref, sourceLine: row.sourceLine });
  }

  return { accepted, rejected, duplicatesInInput };
}

export function parseContactText(
  text: string,
  defaultCountry: string,
): ParseResult {
  const rows: RawRow[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    for (const piece of line.split(",")) {
      const value = piece.trim();
      // A blank line is not an error, it is just a blank line.
      if (value.length === 0) continue;
      rows.push({ phone: value, ref: null, sourceLine: index + 1 });
    }
  });

  return normalise(rows, defaultCountry);
}

export function parseContactCsv(
  csv: string,
  defaultCountry: string,
): ParseResult {
  let records: string[][];
  try {
    records = parseCsv(csv, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch (error) {
    // Malformed CSV is a user mistake, not a server error, so it comes back as
    // a rejection they can read.
    return {
      accepted: [],
      rejected: [
        {
          raw: csv.slice(0, 80),
          reason: `could not read the file as CSV: ${
            error instanceof Error ? error.message : String(error)
          }`,
          sourceLine: 1,
        },
      ],
      duplicatesInInput: [],
    };
  }

  const [first, ...rest] = records;
  if (!first) {
    return { accepted: [], rejected: [], duplicatesInInput: [] };
  }

  const header = first.map((cell) => cell.trim().toLowerCase());
  const phoneIndex = header.findIndex((cell) => PHONE_HEADERS.has(cell));
  const hasHeader = phoneIndex !== -1;
  const refIndex = hasHeader
    ? header.findIndex((cell) => REF_HEADERS.has(cell))
    : -1;

  // Without a recognised header the first column is the number and the first
  // row is data, not a heading.
  const dataRows = hasHeader ? rest : records;
  const lineOffset = hasHeader ? 2 : 1;
  const column = hasHeader ? phoneIndex : 0;

  const rows: RawRow[] = dataRows.map((record, index) => ({
    phone: record[column] ?? "",
    ref: refIndex === -1 ? null : (record[refIndex]?.trim() ?? null) || null,
    sourceLine: index + lineOffset,
  }));

  return normalise(rows, defaultCountry);
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/api -- contacts-parse`
Expected: PASS, 20 tests.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 10: Contact import routes

Preview and commit are separate endpoints because nothing is written until the
operator has seen what would be written.

**Files:**
- Create: `console/api/src/contacts/queries.ts`
- Create: `console/api/src/contacts/routes.ts`
- Modify: `console/api/src/app.ts` (register the routes)
- Modify: `console/api/test/tenant-isolation.test.ts` (add contact cases)
- Test: `console/api/test/contacts-routes.test.ts`

**Interfaces:**
- Consumes: `parseContactCsv`/`parseContactText` from Task 9, `requireTenant`/`HttpError` from Task 5, `findCampaign` from Task 7.
- Produces:
  - `listContacts(pool, tenantId, campaignId): Promise<Contact[]>` where `Contact = { id: string; e164: string; externalRef: string | null; status: "pending" | "dialing" | "done" }`
  - `findExistingNumbers(pool, tenantId, campaignId, e164s): Promise<Set<string>>`
  - `insertContacts(pool, tenantId, campaignId, rows): Promise<number>` - returns the number actually inserted
  - `countContacts(pool, tenantId, campaignId): Promise<number>`
  - `deleteContact(pool, tenantId, campaignId, contactId): Promise<boolean>`

- [ ] **Step 1: Implement the contact queries**

`console/api/src/contacts/queries.ts`:

```ts
import type { ParsedContact } from "@console/shared";
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { parseExactlyOne, parseRows } from "../db/rows.js";

const contactRow = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  external_ref: z.string().nullable(),
  status: z.enum(["pending", "dialing", "done"]),
});

export interface Contact {
  id: string;
  e164: string;
  externalRef: string | null;
  status: "pending" | "dialing" | "done";
}

function toContact(row: z.infer<typeof contactRow>): Contact {
  return {
    id: row.id,
    e164: row.e164,
    externalRef: row.external_ref,
    status: row.status,
  };
}

export async function listContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<Contact[]> {
  const result = await pool.query(
    `SELECT ct.id, ct.e164, ct.external_ref, ct.status
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2
      ORDER BY ct.created_at, ct.e164`,
    [tenantId, campaignId],
  );
  return parseRows(contactRow, result).map(toContact);
}

export async function countContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2`,
    [tenantId, campaignId],
  );
  return parseExactlyOne(z.object({ n: z.number().int() }), result).n;
}

/** Which of these numbers the campaign already holds. Used by the preview. */
export async function findExistingNumbers(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  e164s: string[],
): Promise<Set<string>> {
  if (e164s.length === 0) return new Set();
  const result = await pool.query(
    `SELECT ct.e164
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2 AND ct.e164 = ANY($3::text[])`,
    [tenantId, campaignId, e164s],
  );
  return new Set(
    parseRows(z.object({ e164: z.string() }), result).map((row) => row.e164),
  );
}

/**
 * Inserts in one statement. ON CONFLICT DO NOTHING makes a re-submitted import
 * idempotent rather than a 500, which matters because the preview the operator
 * saw may be seconds stale.
 */
export async function insertContacts(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  rows: ParsedContact[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, external_ref)
     SELECT c.id, input.e164, input.external_ref
       FROM campaigns c
       JOIN unnest($3::text[], $4::text[]) AS input(e164, external_ref)
         ON true
      WHERE c.tenant_id = $1 AND c.id = $2
     ON CONFLICT (campaign_id, e164) DO NOTHING`,
    [
      tenantId,
      campaignId,
      rows.map((row) => row.e164),
      rows.map((row) => row.externalRef),
    ],
  );
  return result.rowCount ?? 0;
}

export async function deleteContact(
  pool: Pool,
  tenantId: string,
  campaignId: string,
  contactId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM contacts ct
      USING campaigns c
      WHERE c.id = ct.campaign_id
        AND c.tenant_id = $1 AND ct.campaign_id = $2 AND ct.id = $3`,
    [tenantId, campaignId, contactId],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 2: Write the failing contact route test**

`console/api/test/contacts-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let campaignId: string;

beforeAll(async () => {
  const config = testConfig();
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
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);
  const created = await app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie },
    payload: {
      name: "Survey",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    },
  });
  campaignId = created.json().id;
});

function preview(payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/contacts/preview`,
    headers: { cookie },
    payload,
  });
}

function importRows(rows: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/contacts`,
    headers: { cookie },
    payload: { rows },
  });
}

describe("POST /api/campaigns/:id/contacts/preview", () => {
  it("returns accepted rows for a pasted list", async () => {
    const response = await preview({ text: "+37060000001\n+37060000002" });
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toHaveLength(2);
  });

  it("returns accepted rows for a CSV with a header", async () => {
    const response = await preview({ csv: "phone,ref\n+37060000001,c-1" });
    expect(response.json().accepted[0].externalRef).toBe("c-1");
  });

  it("separates rejected rows with their reasons", async () => {
    const response = await preview({ text: "+37060000001\nrubbish" });
    expect(response.json().accepted).toHaveLength(1);
    expect(response.json().rejected).toHaveLength(1);
    expect(response.json().rejected[0].sourceLine).toBe(2);
  });

  it("writes nothing to the database", async () => {
    await preview({ text: "+37060000001" });
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    expect(list.json()).toEqual([]);
  });

  it("flags numbers the campaign already holds", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const response = await preview({ text: "+37060000001\n+37060000002" });
    expect(response.json().alreadyInCampaign).toHaveLength(1);
    expect(response.json().accepted).toHaveLength(1);
  });

  it("rejects a body with neither csv nor text", async () => {
    expect((await preview({})).statusCode).toBe(400);
  });

  it("uses the campaign's default country to normalise", async () => {
    const response = await preview({ text: "860000001" });
    expect(response.json().accepted[0].e164).toBe("+37060000001");
  });
});

describe("POST /api/campaigns/:id/contacts", () => {
  it("imports the confirmed rows", async () => {
    const response = await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
      { e164: "+37060000002", externalRef: "c-2", sourceLine: 2 },
    ]);
    expect(response.statusCode).toBe(201);
    expect(response.json().imported).toBe(2);
  });

  it("is idempotent when the same rows are submitted twice", async () => {
    const rows = [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }];
    await importRows(rows);
    const second = await importRows(rows);
    expect(second.statusCode).toBe(201);
    expect(second.json().imported).toBe(0);
  });

  it("refuses a row whose e164 is not in E.164 form", async () => {
    const response = await importRows([
      { e164: "060000001", externalRef: null, sourceLine: 1 },
    ]);
    expect(response.statusCode).toBe(400);
  });

  it("refuses an import that would exceed the campaign cap", async () => {
    await pool.query(
      `INSERT INTO contacts (campaign_id, e164)
       SELECT $1, '+3706' || lpad(g::text, 7, '0')
         FROM generate_series(1, 10000) AS g`,
      [campaignId],
    );
    const response = await importRows([
      { e164: "+37069999999", externalRef: null, sourceLine: 1 },
    ]);
    expect(response.statusCode).toBe(409);
  });

  it("rejects an empty rows array", async () => {
    expect((await importRows([])).statusCode).toBe(400);
  });
});

describe("GET and DELETE contacts", () => {
  it("lists imported contacts as pending", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    expect(response.json()[0].status).toBe("pending");
  });

  it("deletes one contact", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/contacts/${list.json()[0].id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);
  });

  it("returns 404 deleting an unknown contact", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/contacts/11111111-1111-4111-8111-111111111111`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- contacts-routes`
Expected: FAIL - 404 on every route.

- [ ] **Step 4: Implement the contact routes**

`console/api/src/contacts/routes.ts`:

```ts
import {
  contactImportRequestSchema,
  contactPreviewRequestSchema,
  MAX_CONTACTS_PER_CAMPAIGN,
  type RejectedContact,
} from "@console/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import { findCampaign } from "../campaigns/queries.js";
import { parseCampaignId } from "../campaigns/routes.js";
import type { Pool } from "../db/client.js";
import { parseContactCsv, parseContactText } from "./parse.js";
import {
  countContacts,
  deleteContact,
  findExistingNumbers,
  insertContacts,
  listContacts,
} from "./queries.js";

const contactIdSchema = z.object({ cid: z.string().uuid() });
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function registerContactRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  async function requireOwnedCampaign(tenantId: string, params: unknown) {
    const id = parseCampaignId(params);
    const campaign = await findCampaign(pool, tenantId, id);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  app.get("/api/campaigns/:id/contacts", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaign = await requireOwnedCampaign(tenantId, request.params);
    return listContacts(pool, tenantId, campaign.id);
  });

  app.post("/api/campaigns/:id/contacts/preview", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaign = await requireOwnedCampaign(tenantId, request.params);

    const parsed = contactPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "send either csv or text");

    const result =
      "csv" in parsed.data
        ? parseContactCsv(parsed.data.csv, campaign.defaultCountry)
        : parseContactText(parsed.data.text, campaign.defaultCountry);

    // Checked against the database, not just within the submitted list, so the
    // operator sees the true effect of confirming.
    const existing = await findExistingNumbers(
      pool,
      tenantId,
      campaign.id,
      result.accepted.map((row) => row.e164),
    );

    const accepted = result.accepted.filter((row) => !existing.has(row.e164));
    const alreadyInCampaign: RejectedContact[] = result.accepted
      .filter((row) => existing.has(row.e164))
      .map((row) => ({
        raw: row.e164,
        reason: "already in this campaign",
        sourceLine: row.sourceLine,
      }));

    return {
      accepted,
      rejected: result.rejected,
      duplicatesInInput: result.duplicatesInInput,
      alreadyInCampaign,
    };
  });

  app.post("/api/campaigns/:id/contacts", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaign = await requireOwnedCampaign(tenantId, request.params);

    const parsed = contactImportRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid contact rows");

    // The rows come back from a client that could have edited them, so E.164
    // form is re-checked here rather than trusted from the preview.
    for (const row of parsed.data.rows) {
      if (!E164.test(row.e164)) {
        throw new HttpError(400, `${row.e164} is not in E.164 form`);
      }
    }

    const current = await countContacts(pool, tenantId, campaign.id);
    if (current + parsed.data.rows.length > MAX_CONTACTS_PER_CAMPAIGN) {
      throw new HttpError(
        409,
        `a campaign holds at most ${MAX_CONTACTS_PER_CAMPAIGN} contacts`,
      );
    }

    const imported = await insertContacts(
      pool,
      tenantId,
      campaign.id,
      parsed.data.rows,
    );
    return reply.status(201).send({ imported });
  });

  app.delete("/api/campaigns/:id/contacts/:cid", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaign = await requireOwnedCampaign(tenantId, request.params);
    const parsed = contactIdSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid contact id");

    const deleted = await deleteContact(
      pool,
      tenantId,
      campaign.id,
      parsed.data.cid,
    );
    if (!deleted) throw new HttpError(404, "contact not found");
    return reply.status(204).send();
  });
}
```

- [ ] **Step 5: Register the routes**

In `console/api/src/app.ts`:

```ts
import { registerContactRoutes } from "./contacts/routes.js";
```

```ts
  registerAudioRoutes(app, { ...deps, s3 });
  registerContactRoutes(app, deps);
```

- [ ] **Step 6: Run the contact route tests**

Run: `cd console && npm run test --workspace @console/api -- contacts-routes`
Expected: PASS, 15 tests.

- [ ] **Step 7: Add contact cases to the isolation suite**

Append inside the `describe("tenant isolation")` block in
`console/api/test/tenant-isolation.test.ts`:

```ts
  it("returns 404 when previewing contacts against another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts/preview`,
      headers: { cookie: globexCookie },
      payload: { text: "+37060000001" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when importing into another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: globexCookie },
      payload: {
        rows: [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("imports nothing into the campaign it refused", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: globexCookie },
      payload: {
        rows: [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }],
      },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: acmeCookie },
    });
    expect(list.json()).toEqual([]);
  });
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green. The isolation suite is now 12 tests.

---

### Task 11: Web scaffold, API client, and login

**Files:**
- Create: `console/web/package.json`, `console/web/tsconfig.json`, `console/web/vite.config.ts`, `console/web/index.html`
- Create: `console/web/src/main.tsx`, `console/web/src/App.tsx`, `console/web/src/index.css`
- Create: `console/web/src/api/client.ts`
- Create: `console/web/src/auth/useSession.ts`
- Create: `console/web/src/routes/Login.tsx`
- Create: `console/web/src/components/RequireAuth.tsx`
- Test: `console/web/test/client.test.ts`

**Interfaces:**
- Consumes: the HTTP surface from Tasks 5, 7, 8, 10; shared schemas from `@console/shared`.
- Produces:
  - `apiFetch<T>(path: string, options?: { method?, body?, schema? }): Promise<T>` - throws `ApiError` with `status` and `message`.
  - `useSession()` - TanStack Query hook returning `{ user, isLoading }`.
  - `<RequireAuth>` - redirects to `/login` when unauthenticated.

- [ ] **Step 1: Create the web package**

`console/web/package.json`:

```json
{
  "name": "@console/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@console/shared": "*",
    "@tanstack/react-query": "^5.59.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.53.0",
    "react-router": "^7.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`console/web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Create the Vite config**

`console/web/vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in the browser, so the session cookie is sent without any
    // CORS configuration on the API.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
```

`console/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`console/web/src/index.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 3: Write the failing API client test**

`console/web/test/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch } from "../src/api/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response> & { jsonValue?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.jsonValue,
    })),
  );
}

describe("apiFetch", () => {
  it("returns the parsed body", async () => {
    stubFetch({ jsonValue: { id: "1" } });
    expect(await apiFetch<{ id: string }>("/api/thing")).toEqual({ id: "1" });
  });

  it("validates against a schema when one is given", async () => {
    stubFetch({ jsonValue: { id: 1 } });
    await expect(
      apiFetch("/api/thing", { schema: z.object({ id: z.string() }) }),
    ).rejects.toThrow(/response did not match/);
  });

  it("throws ApiError carrying the status", async () => {
    stubFetch({ ok: false, status: 401, jsonValue: { error: "unauthorized" } });
    await expect(apiFetch("/api/thing")).rejects.toMatchObject({
      status: 401,
      message: "unauthorized",
    });
  });

  it("still throws ApiError when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      })),
    );
    await expect(apiFetch("/api/thing")).rejects.toBeInstanceOf(ApiError);
  });

  it("sends credentials so the session cookie travels", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/thing");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("serialises a JSON body and sets the content type", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/thing", { method: "POST", body: { a: 1 } });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("returns null for a 204 rather than trying to parse it", async () => {
    stubFetch({ status: 204 });
    expect(await apiFetch("/api/thing", { method: "DELETE" })).toBeNull();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/web`
Expected: FAIL - cannot resolve `../src/api/client.js`.

- [ ] **Step 5: Implement the API client**

`console/web/src/api/client.ts`:

```ts
import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** When given, the response is validated, so a backend change surfaces here. */
  schema?: ZodType<T>;
  /** For multipart uploads, which must not get a JSON content type. */
  formData?: FormData;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiOptions<T> = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    // The session is a cookie, so every call must send it.
    credentials: "same-origin",
  };

  if (options.formData) {
    init.body = options.formData;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }

  const response = await fetch(path, init);

  if (!response.ok) {
    let message = `request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // A non-JSON error body is still an error; keep the status message.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return null as T;

  const body = (await response.json()) as unknown;
  if (!options.schema) return body as T;

  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, `response did not match schema: ${path}`);
  }
  return parsed.data;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/web`
Expected: PASS, 7 tests.

- [ ] **Step 7: Implement the session hook**

`console/web/src/auth/useSession.ts`:

```ts
import { meResponseSchema, type MeResponse } from "@console/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client.js";

export function useSession() {
  const query = useQuery<MeResponse | null>({
    queryKey: ["session"],
    retry: false,
    queryFn: async () => {
      try {
        return await apiFetch("/api/auth/me", { schema: meResponseSchema });
      } catch (error) {
        // A 401 is the normal logged-out state, not a failure to report.
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });

  return { user: query.data ?? null, isLoading: query.isLoading };
}
```

- [ ] **Step 8: Implement the login screen and the auth guard**

`console/web/src/routes/Login.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await navigate("/campaigns");
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "could not sign in",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg bg-white p-8 shadow"
      >
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>

        <label className="block text-sm">
          <span className="text-slate-700">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Signing in" : "Sign in"}
        </button>

        <p className="text-xs text-slate-500">
          Accounts are created by an administrator. There is no self-service
          registration.
        </p>
      </form>
    </div>
  );
}
```

`console/web/src/components/RequireAuth.tsx`:

```tsx
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useSession } from "../auth/useSession.js";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 9: Implement App and main**

`console/web/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireAuth } from "./components/RequireAuth.js";
import { Login } from "./routes/Login.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/campaigns"
            element={
              <RequireAuth>
                <div className="p-8">Campaigns land here in Task 12.</div>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/campaigns" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

`console/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 10: Verify login works against the real API**

Start the API (`cd console/api && npm run dev`) and the web dev server
(`cd console/web && npm run dev`), then open `http://localhost:5173/login` and
sign in with the credentials printed by the CLI in Task 6.

Expected: redirect to `/campaigns` showing the placeholder. Reloading the page
keeps you signed in. Visiting `/campaigns` in a private window redirects to
`/login`.

- [ ] **Step 11: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 12: Campaign list and the authoring wizard

The wizard writes a draft campaign at step one, so a refresh never loses work.
Launch is Plan 2, so the review step ends at "ready" and says so.

**Files:**
- Create: `console/web/src/api/campaigns.ts`
- Create: `console/web/src/components/AppShell.tsx`
- Create: `console/web/src/routes/Campaigns.tsx`
- Create: `console/web/src/routes/CampaignWizard.tsx`
- Create: `console/web/src/routes/wizard/DetailsStep.tsx`
- Create: `console/web/src/routes/wizard/AudioStep.tsx`
- Create: `console/web/src/routes/wizard/ContactsStep.tsx`
- Create: `console/web/src/routes/wizard/ReviewStep.tsx`
- Modify: `console/web/src/App.tsx` (routes)
- Test: `console/web/test/readiness.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from Task 11; the campaign, audio, and contact endpoints from Tasks 7, 8, 10.
- Produces:
  - `useCampaigns()`, `useCampaign(id)`, `useCreateCampaign()`, `useQuestions(id)`, `useContacts(id)` hooks in `api/campaigns.ts`.
  - `campaignReadiness(campaign): { ready: boolean; blockers: string[] }` - the single definition of "this campaign could be launched", used by the review step and reused by Plan 2's launch button.

- [ ] **Step 1: Write the failing readiness test**

`console/web/test/readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { campaignReadiness } from "../src/api/campaigns.js";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Survey",
  language: "lt",
  defaultCountry: "LT",
  silenceMs: 2500,
  status: "draft" as const,
  thanksUploaded: true,
  questionCount: 2,
  contactCount: 5,
  createdAt: "2026-08-04T00:00:00.000Z",
};

describe("campaignReadiness", () => {
  it("is ready when audio, thanks, and contacts are all present", () => {
    expect(campaignReadiness(base)).toEqual({ ready: true, blockers: [] });
  });

  it("blocks with no questions", () => {
    const result = campaignReadiness({ ...base, questionCount: 0 });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("Upload at least one question");
  });

  it("blocks with no thanks audio", () => {
    const result = campaignReadiness({ ...base, thanksUploaded: false });
    expect(result.blockers).toContain("Upload the thank-you audio");
  });

  it("blocks with no contacts", () => {
    const result = campaignReadiness({ ...base, contactCount: 0 });
    expect(result.blockers).toContain("Import at least one contact");
  });

  it("lists every blocker at once rather than one at a time", () => {
    const result = campaignReadiness({
      ...base,
      questionCount: 0,
      thanksUploaded: false,
      contactCount: 0,
    });
    expect(result.blockers).toHaveLength(3);
  });

  it("caps questions at ten, matching the Worker", () => {
    const result = campaignReadiness({ ...base, questionCount: 11 });
    expect(result.blockers).toContain("A campaign holds at most 10 questions");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/web -- readiness`
Expected: FAIL - `campaignReadiness` is not exported.

- [ ] **Step 3: Implement the campaign hooks and readiness**

`console/web/src/api/campaigns.ts`:

```ts
import {
  campaignSchema,
  MAX_QUESTIONS,
  type Campaign,
  type ContactPreviewResponse,
  type CreateCampaignRequest,
  type ParsedContact,
} from "@console/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "./client.js";

const questionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  originalFilename: z.string(),
  bytes: z.number().int(),
});
export type Question = z.infer<typeof questionSchema>;

const contactSchema = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  externalRef: z.string().nullable(),
  status: z.enum(["pending", "dialing", "done"]),
});
export type Contact = z.infer<typeof contactSchema>;

/**
 * The single definition of "could this campaign be launched". Plan 2's launch
 * button reads the same function, so the UI and the server cannot drift on
 * what a complete campaign means.
 */
export function campaignReadiness(campaign: Campaign): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (campaign.questionCount === 0) blockers.push("Upload at least one question");
  if (campaign.questionCount > MAX_QUESTIONS) {
    blockers.push(`A campaign holds at most ${MAX_QUESTIONS} questions`);
  }
  if (!campaign.thanksUploaded) blockers.push("Upload the thank-you audio");
  if (campaign.contactCount === 0) blockers.push("Import at least one contact");
  return { ready: blockers.length === 0, blockers };
}

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () =>
      apiFetch("/api/campaigns", { schema: z.array(campaignSchema) }),
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", id],
    enabled: id !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${id}`, { schema: campaignSchema }),
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCampaignRequest) =>
      apiFetch("/api/campaigns", {
        method: "POST",
        body,
        schema: campaignSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function useUpdateCampaign(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CreateCampaignRequest>) =>
      apiFetch(`/api/campaigns/${id}`, {
        method: "PATCH",
        body,
        schema: campaignSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export function useQuestions(campaignId: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "questions"],
    enabled: campaignId !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/questions`, {
        schema: z.array(questionSchema),
      }),
  });
}

export function useUploadAudio(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { file: File; kind: "question" | "thanks" }) => {
      const formData = new FormData();
      formData.append("file", args.file);
      const path =
        args.kind === "question"
          ? `/api/campaigns/${campaignId}/questions`
          : `/api/campaigns/${campaignId}/thanks`;
      return apiFetch(path, {
        method: args.kind === "question" ? "POST" : "PUT",
        formData,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useDeleteQuestion(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (questionId: string) =>
      apiFetch(`/api/campaigns/${campaignId}/questions/${questionId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useReorderQuestions(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch(`/api/campaigns/${campaignId}/questions/order`, {
        method: "PATCH",
        body: { ids },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useContacts(campaignId: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "contacts"],
    enabled: campaignId !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/contacts`, {
        schema: z.array(contactSchema),
      }),
  });
}

export function previewContacts(
  campaignId: string,
  body: { csv: string } | { text: string },
): Promise<ContactPreviewResponse> {
  return apiFetch(`/api/campaigns/${campaignId}/contacts/preview`, {
    method: "POST",
    body,
  });
}

export function useImportContacts(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rows: ParsedContact[]) =>
      apiFetch<{ imported: number }>(`/api/campaigns/${campaignId}/contacts`, {
        method: "POST",
        body: { rows },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd console && npm run test --workspace @console/web -- readiness`
Expected: PASS, 6 tests.

- [ ] **Step 5: Implement the shell and the campaign list**

`console/web/src/components/AppShell.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { apiFetch } from "../api/client.js";
import { useSession } from "../auth/useSession.js";

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    queryClient.clear();
    await navigate("/login");
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <Link to="/campaigns" className="font-semibold text-slate-900">
          Console
        </Link>
        <div className="flex items-center gap-4 text-sm text-slate-600">
          <span>{user?.email}</span>
          <button onClick={() => void signOut()} className="underline">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
```

`console/web/src/routes/Campaigns.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { useCampaigns, useCreateCampaign } from "../api/campaigns.js";
import { AppShell } from "../components/AppShell.js";

export function Campaigns() {
  const { data: campaigns, isLoading } = useCampaigns();
  const createCampaign = useCreateCampaign();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function create() {
    const campaign = await createCampaign.mutateAsync({
      name: "Untitled campaign",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    });
    await navigate(`/campaigns/${campaign.id}/edit`);
  }

  return (
    <AppShell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Campaigns</h1>
        <button
          onClick={() => {
            setCreating(true);
            void create().finally(() => setCreating(false));
          }}
          disabled={creating}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          New campaign
        </button>
      </div>

      {isLoading && <p className="text-slate-500">Loading</p>}

      {campaigns?.length === 0 && (
        <p className="text-slate-500">
          No campaigns yet. Create one to upload audio and import contacts.
        </p>
      )}

      <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
        {campaigns?.map((campaign) => (
          <li key={campaign.id}>
            <button
              onClick={() => void navigate(`/campaigns/${campaign.id}/edit`)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
            >
              <span>
                <span className="font-medium text-slate-900">{campaign.name}</span>
                <span className="ml-3 text-sm text-slate-500">
                  {campaign.questionCount} questions, {campaign.contactCount}{" "}
                  contacts
                </span>
              </span>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs uppercase text-slate-600">
                {campaign.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
```

- [ ] **Step 6: Implement the wizard steps**

`console/web/src/routes/wizard/DetailsStep.tsx`:

```tsx
import type { Campaign } from "@console/shared";
import { useState } from "react";
import { useUpdateCampaign } from "../../api/campaigns.js";

export function DetailsStep({ campaign }: { campaign: Campaign }) {
  const update = useUpdateCampaign(campaign.id);
  const [name, setName] = useState(campaign.name);
  const [language, setLanguage] = useState(campaign.language);
  const [defaultCountry, setDefaultCountry] = useState(campaign.defaultCountry);
  const [silenceMs, setSilenceMs] = useState(campaign.silenceMs);

  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-6">
      <label className="block text-sm">
        <span className="text-slate-700">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="text-slate-700">Language</span>
          <span className="block text-xs text-slate-500">
            Two letters, used as the transcription hint. Example: lt
          </span>
          <input
            value={language}
            maxLength={2}
            onChange={(e) => setLanguage(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">Number country</span>
          <span className="block text-xs text-slate-500">
            Used to read local-format numbers in your contact list. Example: LT
          </span>
          <input
            value={defaultCountry}
            maxLength={2}
            onChange={(e) => setDefaultCountry(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-slate-700">Silence before the next question (ms)</span>
        <input
          type="number"
          min={500}
          max={10000}
          step={100}
          value={silenceMs}
          onChange={(e) => setSilenceMs(Number(e.target.value))}
          className="mt-1 w-40 rounded border border-slate-300 px-3 py-2"
        />
      </label>

      <button
        onClick={() =>
          update.mutate({ name, language, defaultCountry, silenceMs })
        }
        disabled={update.isPending}
        className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {update.isPending ? "Saving" : "Save"}
      </button>
      {update.isError && (
        <p className="text-sm text-red-600">{String(update.error)}</p>
      )}
    </div>
  );
}
```

`console/web/src/routes/wizard/AudioStep.tsx`:

```tsx
import type { Campaign } from "@console/shared";
import { useRef } from "react";
import {
  useDeleteQuestion,
  useQuestions,
  useReorderQuestions,
  useUploadAudio,
} from "../../api/campaigns.js";

export function AudioStep({ campaign }: { campaign: Campaign }) {
  const { data: questions } = useQuestions(campaign.id);
  const upload = useUploadAudio(campaign.id);
  const remove = useDeleteQuestion(campaign.id);
  const reorder = useReorderQuestions(campaign.id);
  const questionInput = useRef<HTMLInputElement>(null);
  const thanksInput = useRef<HTMLInputElement>(null);

  function move(index: number, direction: -1 | 1) {
    if (!questions) return;
    const ids = questions.map((question) => question.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const a = ids[index];
    const b = ids[target];
    if (!a || !b) return;
    ids[index] = b;
    ids[target] = a;
    reorder.mutate(ids);
  }

  return (
    <div className="space-y-6 rounded border border-slate-200 bg-white p-6">
      <section>
        <h2 className="mb-2 font-medium text-slate-900">Questions</h2>
        <ol className="mb-3 divide-y divide-slate-200 rounded border border-slate-200">
          {questions?.map((question, index) => (
            <li
              key={question.id}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span>
                <span className="mr-2 text-slate-400">{question.position}</span>
                {question.originalFilename}
              </span>
              <span className="flex gap-2">
                <button onClick={() => move(index, -1)} className="text-slate-500">
                  Up
                </button>
                <button onClick={() => move(index, 1)} className="text-slate-500">
                  Down
                </button>
                <button
                  onClick={() => remove.mutate(question.id)}
                  className="text-red-600"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
        {questions?.length === 0 && (
          <p className="mb-3 text-sm text-slate-500">No questions yet.</p>
        )}

        <input
          ref={questionInput}
          type="file"
          accept="audio/mpeg,audio/wav"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind: "question" });
            if (questionInput.current) questionInput.current.value = "";
          }}
          className="text-sm"
        />
      </section>

      <section>
        <h2 className="mb-2 font-medium text-slate-900">Thank-you audio</h2>
        <p className="mb-2 text-sm text-slate-500">
          {campaign.thanksUploaded ? "Uploaded" : "Not uploaded yet"}
        </p>
        <input
          ref={thanksInput}
          type="file"
          accept="audio/mpeg,audio/wav"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind: "thanks" });
            if (thanksInput.current) thanksInput.current.value = "";
          }}
          className="text-sm"
        />
      </section>

      {upload.isError && (
        <p className="text-sm text-red-600">{String(upload.error)}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Implement the contacts and review steps**

`console/web/src/routes/wizard/ContactsStep.tsx`:

```tsx
import type { Campaign, ContactPreviewResponse } from "@console/shared";
import { useState } from "react";
import {
  previewContacts,
  useContacts,
  useImportContacts,
} from "../../api/campaigns.js";

export function ContactsStep({ campaign }: { campaign: Campaign }) {
  const { data: contacts } = useContacts(campaign.id);
  const importContacts = useImportContacts(campaign.id);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ContactPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview(body: { csv: string } | { text: string }) {
    setError(null);
    try {
      setPreview(await previewContacts(campaign.id, body));
    } catch (caught) {
      setError(String(caught));
    }
  }

  return (
    <div className="space-y-6 rounded border border-slate-200 bg-white p-6">
      <section>
        <h2 className="mb-2 font-medium text-slate-900">Add numbers</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="+37060000001"
          className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => void runPreview({ text })}
            disabled={text.trim().length === 0}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Preview pasted list
          </button>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await runPreview({ csv: await file.text() });
            }}
            className="text-sm"
          />
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {preview && (
        <section className="space-y-3">
          <h2 className="font-medium text-slate-900">Preview</h2>
          <p className="text-sm text-slate-600">
            {preview.accepted.length} will be imported,{" "}
            {preview.rejected.length} rejected,{" "}
            {preview.duplicatesInInput.length} duplicated in the list,{" "}
            {preview.alreadyInCampaign.length} already in this campaign.
          </p>

          {preview.rejected.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded border border-red-200 bg-red-50 p-3 text-sm">
              {preview.rejected.map((row) => (
                <li key={`${row.sourceLine}-${row.raw}`}>
                  Line {row.sourceLine}: {row.raw} - {row.reason}
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() =>
              importContacts.mutate(preview.accepted, {
                onSuccess: () => {
                  setPreview(null);
                  setText("");
                },
              })
            }
            disabled={preview.accepted.length === 0 || importContacts.isPending}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Import {preview.accepted.length} contacts
          </button>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-medium text-slate-900">
          In this campaign ({contacts?.length ?? 0})
        </h2>
        <ul className="max-h-64 overflow-y-auto rounded border border-slate-200 text-sm">
          {contacts?.map((contact) => (
            <li
              key={contact.id}
              className="flex justify-between border-b border-slate-100 px-3 py-1.5 last:border-0"
            >
              <span className="font-mono">{contact.e164}</span>
              <span className="text-slate-500">{contact.externalRef ?? ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

`console/web/src/routes/wizard/ReviewStep.tsx`:

```tsx
import type { Campaign } from "@console/shared";
import { campaignReadiness } from "../../api/campaigns.js";

export function ReviewStep({ campaign }: { campaign: Campaign }) {
  const { ready, blockers } = campaignReadiness(campaign);

  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-6">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-slate-500">Name</dt>
        <dd className="text-slate-900">{campaign.name}</dd>
        <dt className="text-slate-500">Language</dt>
        <dd className="text-slate-900">{campaign.language}</dd>
        <dt className="text-slate-500">Number country</dt>
        <dd className="text-slate-900">{campaign.defaultCountry}</dd>
        <dt className="text-slate-500">Silence</dt>
        <dd className="text-slate-900">{campaign.silenceMs} ms</dd>
        <dt className="text-slate-500">Questions</dt>
        <dd className="text-slate-900">{campaign.questionCount}</dd>
        <dt className="text-slate-500">Thank-you audio</dt>
        <dd className="text-slate-900">
          {campaign.thanksUploaded ? "Uploaded" : "Missing"}
        </dd>
        <dt className="text-slate-500">Contacts</dt>
        <dd className="text-slate-900">{campaign.contactCount}</dd>
      </dl>

      {ready ? (
        <p className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">
          This campaign is complete. Launching is not available yet - calling
          arrives with the dispatch work.
        </p>
      ) : (
        <ul className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Implement the wizard shell and wire the routes**

`console/web/src/routes/CampaignWizard.tsx`:

```tsx
import { useState } from "react";
import { useParams } from "react-router";
import { useCampaign } from "../api/campaigns.js";
import { AppShell } from "../components/AppShell.js";
import { AudioStep } from "./wizard/AudioStep.js";
import { ContactsStep } from "./wizard/ContactsStep.js";
import { DetailsStep } from "./wizard/DetailsStep.js";
import { ReviewStep } from "./wizard/ReviewStep.js";

const STEPS = ["Details", "Audio", "Contacts", "Review"] as const;

export function CampaignWizard() {
  const { id } = useParams();
  const { data: campaign, isLoading } = useCampaign(id);
  const [step, setStep] = useState(0);

  if (isLoading) return <AppShell>Loading</AppShell>;
  if (!campaign) return <AppShell>Campaign not found.</AppShell>;

  return (
    <AppShell>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">
        {campaign.name}
      </h1>

      <nav className="mb-6 flex gap-2">
        {STEPS.map((label, index) => (
          <button
            key={label}
            onClick={() => setStep(index)}
            className={
              index === step
                ? "rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                : "rounded bg-white px-3 py-1.5 text-sm text-slate-600 ring-1 ring-slate-200"
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {step === 0 && <DetailsStep campaign={campaign} />}
      {step === 1 && <AudioStep campaign={campaign} />}
      {step === 2 && <ContactsStep campaign={campaign} />}
      {step === 3 && <ReviewStep campaign={campaign} />}
    </AppShell>
  );
}
```

In `console/web/src/App.tsx`, replace the placeholder `/campaigns` element and
add the wizard route:

```tsx
import { Campaigns } from "./routes/Campaigns.js";
import { CampaignWizard } from "./routes/CampaignWizard.js";
```

```tsx
          <Route
            path="/campaigns"
            element={
              <RequireAuth>
                <Campaigns />
              </RequireAuth>
            }
          />
          <Route
            path="/campaigns/:id/edit"
            element={
              <RequireAuth>
                <CampaignWizard />
              </RequireAuth>
            }
          />
```

- [ ] **Step 9: Verify the whole authoring flow by hand**

With the API, MinIO, Postgres, and the Vite dev server running, sign in and:

1. Create a campaign, rename it on the Details step, save.
2. Upload two mp3 files as questions and one as the thank-you.
3. Reorder them with Up and Down, then delete one and confirm the positions
   renumber to 1 and 2 with no gap.
4. Paste `+37060000001`, `860000001`, and `rubbish` and preview.
   Expected: one accepted, one duplicate, one rejected on line 3.
5. Import, then re-run the same preview.
   Expected: the number now appears under "already in this campaign".
6. Open Review.
   Expected: no blockers, and the note that launching is not available yet.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `cd console && npm run test && npm run typecheck`
Expected: all green.

---

### Task 13: Production compose and documentation

The `worker` service is not created here - it has nothing to run until Plan 2
adds the dispatcher. Adding an empty container now would mean a restart loop in
production.

**Files:**
- Create: `console/api/Dockerfile`
- Create: `console/web/Dockerfile`
- Create: `console/Caddyfile`
- Create: `console/docker-compose.prod.yml`
- Create: `console/.env.prod.example`
- Create: `console/.dockerignore`
- Create: `console/README.md`

**Interfaces:**
- Consumes: every task above.
- Produces: a deployable stack and the operator documentation for it.

- [ ] **Step 1: Write the ignore file**

`console/.dockerignore`:

```
node_modules
**/node_modules
**/dist
.env
.env.*
!.env.example
!.env.prod.example
```

- [ ] **Step 2: Write the API Dockerfile**

`console/api/Dockerfile`:

```dockerfile
FROM node:24.11.0-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json ./
# Every workspace named in the root package.json must have its manifest present
# or npm ci fails, even for workspaces this image does not install.
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace @console/shared --workspace @console/api --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace @console/shared

FROM build AS runtime
COPY api api
# Type stripping means no build step for the API itself; the shared package is
# compiled because it is imported through its package exports.
CMD ["node", "--experimental-strip-types", "api/src/server.ts"]
```

Build context is `console/`, not `console/api/`, because the workspace root
holds the lockfile.

- [ ] **Step 3: Write the web Dockerfile**

`console/web/Dockerfile`:

```dockerfile
FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# As in api/Dockerfile: every workspace manifest must exist for npm ci.
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
COPY api/package.json api/
RUN npm ci --workspace @console/shared --workspace @console/web --include-workspace-root
COPY packages/shared packages/shared
RUN npm run build --workspace @console/shared
COPY web web
RUN npm run build --workspace @console/web

# The output is static files only. Caddy serves them; there is no Node process.
FROM alpine:3 AS dist
WORKDIR /dist
COPY --from=build /app/web/dist ./
```

- [ ] **Step 4: Write the Caddyfile**

`console/Caddyfile`:

```
{$CONSOLE_DOMAIN} {
	encode gzip

	# The API first, so it wins over the SPA fallback.
	handle /api/* {
		reverse_proxy api:3000
	}

	# Plan 2 adds /callbacks/worker here, reached by the Cloudflare Worker.
	handle /callbacks/* {
		reverse_proxy api:3000
	}

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

Caddy obtains and renews a certificate automatically, which is what makes the
Worker able to POST callbacks over HTTPS in Plan 2.

- [ ] **Step 5: Write the production compose file**

`console/docker-compose.prod.yml`:

```yaml
name: console

services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    image: ghcr.io/amacneil/dbmate:2
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: ${DATABASE_URL}
    volumes: ["./db:/db"]
    command: ["--wait", "up"]

  api:
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
      NODE_ENV: production
      PORT: 3000
    # No S3_ENDPOINT and no AWS keys: the SDK uses the EC2 instance role.

  web:
    build:
      context: .
      dockerfile: web/Dockerfile
    # Mounted at /out, not /dist: mounting over /dist would hide the very
    # assets this container exists to publish.
    volumes: ["webdist:/out"]
    command: ["sh", "-c", "rm -rf /out/* && cp -r /dist/. /out/ && echo web assets published"]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [api, web]
    ports: ["80:80", "443:443"]
    environment:
      CONSOLE_DOMAIN: ${CONSOLE_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - webdist:/srv:ro
      - caddydata:/data
      - caddyconfig:/config

volumes:
  pgdata:
  webdist:
  caddydata:
  caddyconfig:
```

The `web` service is a one-shot that publishes the built assets into a shared
volume Caddy reads. There is no long-running Node process for the frontend.

- [ ] **Step 6: Write the production env example**

`console/.env.prod.example`:

```
CONSOLE_DOMAIN=console.example.com

POSTGRES_USER=console
POSTGRES_PASSWORD=generate-a-long-random-value
POSTGRES_DB=console
DATABASE_URL=postgres://console:generate-a-long-random-value@postgres:5432/console?sslmode=disable

SESSION_SECRET=generate-at-least-32-random-characters

S3_BUCKET=your-production-bucket
S3_REGION=eu-central-1
```

No AWS keys appear here. The EC2 instance role supplies them, and adding keys
would defeat that.

- [ ] **Step 7: Write the README**

`console/README.md`:

```markdown
# Console

Multi-tenant operations app for the Telnyx voice survey Worker in `../cf-worker`.

This is the foundation: tenants log in, build a campaign from audio files and a
contact list, and see whether it is complete. Placing calls, the number pool,
recording ingest, and transcription arrive in later work.

## Layout

    api/               Fastify API, raw SQL over pg
    web/               React 19 + Vite 8 single page app
    packages/shared/   zod schemas shared by both
    db/migrations/     dbmate SQL

## Local development

Node 24.11.0 is required; `.nvmrc` pins it.

    npm install
    cp .env.example api/.env
    npm run infra:up          # postgres + minio
    npm run migrate           # dbmate up

Then in two terminals:

    npm run dev --workspace @console/api
    npm run dev --workspace @console/web

The app is on http://localhost:5173 and proxies `/api` to port 3000, so the
session cookie is same-origin and no CORS configuration exists anywhere.

MinIO's console is on http://localhost:9001 with `console` / `consoleconsole`.

### Creating accounts

There is no registration endpoint. Accounts are created on the box:

    cd api
    npm run cli -- create-tenant --name "Acme" --slug acme
    npm run cli -- create-user --email a@acme.com --tenant acme
    npm run cli -- create-user --email ops@example.com --platform-admin
    npm run cli -- reset-password --email a@acme.com

Generated passwords are printed once and are not recoverable.

## Tests

    npm test
    npm run typecheck

The API suite needs Postgres and MinIO running, because the number of things
worth testing here that do not touch either is small. Run `npm run infra:up`
first.

## Production

One EC2 instance running `docker-compose.prod.yml`: Postgres, a dbmate one-shot
that must finish before the API starts, the API, a one-shot that publishes the
built frontend into a volume, and Caddy terminating TLS.

    cp .env.prod.example .env
    # edit .env, then
    docker compose -f docker-compose.prod.yml up -d --build

S3 is reached through the instance's IAM role. No AWS keys belong on the box.

## Known limitations

- Campaigns cannot be launched. The Review step reports readiness and stops
  there.
- Question reordering uses Up and Down buttons rather than drag and drop.
- A failed audio upload can leave an orphaned S3 object. This is deliberate:
  writing S3 before the database row means a row can never point at a missing
  object, and an orphan costs only storage.
- There is no pagination. A campaign is capped at 10,000 contacts and the
  contact list renders all of them.
```

- [ ] **Step 8: Verify the production build**

Run:

```bash
cd console
cp .env.prod.example .env
docker compose -f docker-compose.prod.yml build
```

Expected: both images build with no errors. Do not start the stack unless a
real domain points at the host - Caddy will fail to obtain a certificate and
retry in a loop.

- [ ] **Step 9: Final verification of the whole plan**

Run:

```bash
cd console
npm run infra:up
npm run migrate
npm test
npm run typecheck
```

Expected: every suite passes and typecheck is clean. Confirm the counts:

| Suite | Tests |
|---|---|
| `config` | 5 |
| `rows` | 9 |
| `passwords` | 5 |
| `sessions` | 5 |
| `auth-routes` | 9 |
| `cli-commands` | 11 |
| `campaigns` | 12 |
| `tenant-isolation` | 12 |
| `audio-keys` | 6 |
| `audio-routes` | 12 |
| `contacts-parse` | 20 |
| `contacts-routes` | 15 |
| `client` (web) | 7 |
| `readiness` (web) | 6 |

134 tests total.

---

## Plan self-review

Checked against `docs/superpowers/specs/2026-08-04-console-design.md`, Plan 1
scope:

| Spec requirement | Task |
|---|---|
| Workspace, Node 24.11.0, React 19, Vite 8 | 1, 11 |
| Both compose files | 1, 13 |
| dbmate schema and migrations | 2 |
| `pg` client and zod row boundary | 3 |
| Auth with sessions, argon2id, 7-day absolute expiry | 4, 5 |
| Account provisioning CLI | 6 |
| Tenant scoping and its test suite | 5, 7, and extended in 8 and 10 |
| React shell with login | 11 |
| Campaign CRUD | 7 |
| Audio upload to S3 | 8 |
| Contact import with preview | 9, 10 |

Deliberately deferred, and named as such in the tasks that touch them:
`add-number` on the CLI (Task 6) and the `worker` service (Task 13) both wait
for Plan 2's tables and dispatcher. `POST /api/campaigns/:id/launch` is Plan 2;
Task 12's Review step says so on screen rather than showing a dead button.

