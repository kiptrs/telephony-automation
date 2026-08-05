# Console Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four defects found in the 2026-08-05 review of `console/`:
password reset that does not revoke sessions, manual retry that dead-ends on
completed campaigns, an unbounded automatic redial loop on dial failure, and
the lease sweeper stranding contacts in `dialing`.

**Architecture:** Four independent, surgical fixes to the existing API - no new
tables, no new modules. Plus one config guard: `PUBLIC_BASE_URL` must be https
when the real dialer is selected, because the Worker rejects http callback URLs
with 400 and every dial would fail.

**Tech Stack:** As the console plans: Node 24.11.0, TypeScript strict, Fastify,
`pg`, zod, vitest 4. Tests run on the host against the compose Postgres and
MinIO (`docker compose -f docker-compose.dev.yml up -d postgres minio minio-init dbmate`).

**Spec:** `docs/superpowers/specs/2026-08-04-console-design.md`. Where this plan
touches behaviour the spec left contradictory (dispatch failure says "return
the contact to `pending` so the operator can retry it manually", but `pending`
is the auto-dial state), the resolution chosen here is recorded under Decisions.

## Decisions taken for this plan

| Question | Choice | Why |
|---|---|---|
| How does retry reach a completed campaign? | `POST /api/calls/:id/retry` flips the campaign `completed` back to `running` | Completion is automatic and often precedes the operator even seeing outcomes; retry declaring new work is the smallest honest fix. A `paused` campaign is NOT revived - pause is an explicit operator choice. |
| Dial-failure policy | Auto-redial up to attempt 3, then mark the contact `done` | Contact `done` + call `failed` keeps the existing Retry button as the manual path the spec intended, while still absorbing transient Worker blips. |
| Sweeper and the contact | Expired lease marks the contact `done` as well as the call `ended`/`unknown` | Matches the spec's meaning of done ("we are finished with this number for now"); the swept call is `ended`, so the Retry button already offers recovery. |

## Global Constraints

- Node **24.11.0**, TypeScript **strict** with `noUncheckedIndexedAccess`. Do not widen a type to make a build pass.
- **No ORM.** SQL lives only in `queries.ts` modules (route-local SQL already present in `calls/routes.ts` may be extended in place, matching the file's existing style).
- **Every database row is parsed through a zod schema** before leaving its query module.
- Tenant-owned query functions take `tenantId` first and include it in the `WHERE` clause.
- **No emojis** in source or docs.
- **Git is read-only.** No `git add`, `git commit`, `git checkout`. Every task ends with a verification step instead of a commit step.
- The API test suite needs the compose Postgres and MinIO running; suites truncate tables, so `fileParallelism` stays off.

## File Structure

```
console/api/src/cli/commands.ts        MODIFIED: reset-password revokes sessions
console/api/src/calls/routes.ts        MODIFIED: retry revives a completed campaign
console/api/src/calls/queries.ts       MODIFIED: insertQueuedCall returns attempt
console/api/src/dispatch/dispatcher.ts MODIFIED: attempt cap, sweep marks contact done
console/api/src/config.ts              MODIFIED: https guard for cf-worker dialer
console/api/test/cli-commands.test.ts  MODIFIED
console/api/test/call-retry.test.ts    NEW
console/api/test/dispatcher.test.ts    MODIFIED
console/api/test/config.test.ts        MODIFIED
```

---

### Task 1: Password reset revokes sessions

The spec's Authentication section: "Logout and password reset delete the rows,
so revocation is immediate - the reason this is not JWT."
`deleteSessionsForUser` already exists (`auth/sessions.ts:64`); nothing calls it.

**Files:**
- Modify: `console/api/src/cli/commands.ts:64-76`
- Test: `console/api/test/cli-commands.test.ts`

**Interfaces:**
- Consumes: `findUserByEmail(pool, email)` from `auth/queries.js`,
  `deleteSessionsForUser(pool, userId)` from `auth/sessions.js`,
  `createSession(pool, userId)` / `findUserBySession(pool, sessionId)` for the test.
- Produces: `resetPasswordCommand(pool, { email })` keeps its signature
  `Promise<{ email: string; password: string }>`; it now also deletes every
  session row for that user.

- [ ] **Step 1: Write the failing test**

In `console/api/test/cli-commands.test.ts`, extend the imports:

```ts
import {
  createSession,
  findUserBySession,
} from "../src/auth/sessions.js";
```

Append inside the existing `describe("resetPasswordCommand", ...)` block (or add
the block if the file groups differently - follow its current layout):

```ts
  it("revokes every live session, so a stolen cookie dies with the old password", async () => {
    await createTenantCommand(pool, { name: "Acme", slug: "acme" });
    await createUserCommand(pool, {
      email: "a@acme.com",
      tenantSlug: "acme",
      platformAdmin: false,
    });
    const user = await findUserByEmail(pool, "a@acme.com");
    const session = await createSession(pool, user!.id);

    await resetPasswordCommand(pool, { email: "a@acme.com" });

    expect(await findUserBySession(pool, session.id)).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- cli-commands`
Expected: FAIL - the session still resolves after the reset.

- [ ] **Step 3: Implement**

In `console/api/src/cli/commands.ts`, add to the imports from
`../auth/sessions.js` (new import line) and rewrite the command:

```ts
import { deleteSessionsForUser } from "../auth/sessions.js";
```

```ts
export async function resetPasswordCommand(
  pool: Pool,
  args: { email: string },
): Promise<{ email: string; password: string }> {
  const user = await findUserByEmail(pool, args.email);
  if (!user) throw new Error(`no user with email ${args.email}`);

  const password = generatePassword();
  const updated = await updatePasswordHash(
    pool,
    args.email,
    await hashPassword(password),
  );
  if (!updated) throw new Error(`no user with email ${args.email}`);

  // The whole reason sessions live in Postgres: a reset revokes immediately.
  await deleteSessionsForUser(pool, user.id);

  return { email: args.email, password };
}
```

- [ ] **Step 4: Verify**

Run: `cd console && npm run test --workspace @console/api -- cli-commands`
Expected: PASS, including the pre-existing reset-password cases.

---

### Task 2: Retry revives a completed campaign

`completeFinishedCampaigns` marks a campaign `completed` the moment the last
call ends. Retry then sets the contact `pending`, but the dispatcher only
serves `running` campaigns and launch refuses `completed` - so retry silently
does nothing exactly when it is most used.

**Files:**
- Modify: `console/api/src/calls/routes.ts:54-62`
- Test: `console/api/test/call-retry.test.ts` (new)

**Interfaces:**
- Consumes: `buildApp` from `src/app.js`, `loginAs`/`seedTenant`/`resetDatabase`/`testConfig` from `test/helpers.js`.
- Produces: unchanged route signature. New behaviour: after a successful
  retry, `contacts.status = 'pending'` AND, if the owning campaign was
  `completed`, `campaigns.status = 'running'`. A `paused` campaign stays paused.

- [ ] **Step 1: Write the failing test**

`console/api/test/call-retry.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

const config = testConfig();
let pool: Pool;
let app: FastifyInstance;
let tenantId: string;
let cookie: string;

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
  const seeded = await seedTenant(pool, "acme");
  tenantId = seeded.tenantId;
  cookie = await loginAs(app, seeded.email);
});

/** A finished campaign holding one done contact with one ended call. */
async function seedFinishedCall(status: "completed" | "paused") {
  const campaign = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, language, default_country,
                            thanks_s3_key, status, launched_at)
          VALUES ($1, 'c', 'lt', 'LT', 'tenants/t/thanks.mp3', $2, now())
       RETURNING id`,
    [tenantId, status],
  );
  const contact = await pool.query(
    `INSERT INTO contacts (campaign_id, e164, status)
          VALUES ($1, '+37060000001', 'done') RETURNING id`,
    [campaign.rows[0].id],
  );
  const call = await pool.query(
    `INSERT INTO calls (campaign_id, contact_id, status, outcome, ended_at)
          VALUES ($1, $2, 'ended', 'no_answer', now()) RETURNING id`,
    [campaign.rows[0].id, contact.rows[0].id],
  );
  return {
    campaignId: campaign.rows[0].id as string,
    contactId: contact.rows[0].id as string,
    callId: call.rows[0].id as string,
  };
}

async function statusOf(table: "campaigns" | "contacts", id: string) {
  const result = await pool.query(
    `SELECT status FROM ${table} WHERE id = $1`,
    [id],
  );
  return result.rows[0].status as string;
}

describe("POST /api/calls/:id/retry", () => {
  it("returns the contact to pending", async () => {
    const { callId, contactId } = await seedFinishedCall("completed");
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await statusOf("contacts", contactId)).toBe("pending");
  });

  it("revives a completed campaign so the dispatcher can see the retry", async () => {
    const { callId, campaignId } = await seedFinishedCall("completed");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(await statusOf("campaigns", campaignId)).toBe("running");
  });

  it("leaves a paused campaign paused, because pause is an operator choice", async () => {
    const { callId, campaignId } = await seedFinishedCall("paused");
    await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie },
    });
    expect(await statusOf("campaigns", campaignId)).toBe("paused");
  });

  it("gives another tenant's call a 404, not a 403", async () => {
    const { callId } = await seedFinishedCall("completed");
    const other = await seedTenant(pool, "globex");
    const otherCookie = await loginAs(app, other.email);
    const response = await app.inject({
      method: "POST",
      url: `/api/calls/${callId}/retry`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- call-retry`
Expected: FAIL on "revives a completed campaign" (campaign stays `completed`).
The other three should already pass - if one does not, stop and investigate
before touching the route.

- [ ] **Step 3: Implement**

In `console/api/src/calls/routes.ts`, directly after the
`UPDATE contacts SET status = 'pending' ...` statement inside the retry
handler, add:

```ts
    // Completion is automatic and usually precedes the operator seeing the
    // outcomes at all. A retry is new work, so it reopens the campaign;
    // paused stays paused because pause is an explicit operator choice.
    await pool.query(
      `UPDATE campaigns SET status = 'running'
        WHERE status = 'completed'
          AND id = (SELECT campaign_id FROM calls WHERE id = $1)`,
      [call.id],
    );
```

Tenant scoping is already satisfied: `call.id` was resolved through the
tenant-scoped join above it.

- [ ] **Step 4: Verify**

Run: `cd console && npm run test --workspace @console/api -- call-retry`
Expected: PASS, 4 tests.

---

### Task 3: Cap automatic redials at three attempts

On dial failure the dispatcher returns the contact to `pending`, which the next
tick re-claims: with a misconfigured `WORKER_TRIGGER_SECRET` or an unreachable
Worker this loops every 2 seconds indefinitely, growing `calls` without bound.

**Files:**
- Modify: `console/api/src/calls/queries.ts:106-118` (`insertQueuedCall`)
- Modify: `console/api/src/dispatch/dispatcher.ts:70-127`
- Test: `console/api/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: existing `markContactDone(pool, callId)` from `calls/queries.js`.
- Produces:
  - `insertQueuedCall(client, args): Promise<{ id: string; attempt: number }>` -
    was `Promise<string>`. The dispatcher is its only caller; update it in the
    same task.
  - `MAX_DIAL_ATTEMPTS = 3` exported from `dispatcher.ts`.

- [ ] **Step 1: Write the failing test**

In `console/api/test/dispatcher.test.ts`, append to the
`describe("dispatchOnce", ...)` block:

```ts
  it("stops redialling a contact after three failed dial attempts", async () => {
    await addContacts(1);
    await addNumbers(1);
    const failing = new RecordingDialer(new DialError(401, "bad secret"));

    for (let tick = 0; tick < 5; tick++) {
      await dispatchOnce(deps(failing));
    }

    // Three dials, then the contact is done and ticks 4 and 5 dial nothing.
    expect(dialled).toHaveLength(3);

    const contact = await pool.query("SELECT status FROM contacts");
    expect(contact.rows[0].status).toBe("done");

    const calls = await pool.query(
      "SELECT attempt, status FROM calls ORDER BY attempt",
    );
    expect(calls.rows.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(calls.rows.every((row) => row.status === "failed")).toBe(true);
  });

  it("still returns the contact to pending on an early failure, so a blip retries", async () => {
    await addContacts(1);
    await addNumbers(1);

    await dispatchOnce(deps(new RecordingDialer(new DialError(500, "down"))));

    const contact = await pool.query("SELECT status FROM contacts");
    expect(contact.rows[0].status).toBe("pending");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: FAIL - `dialled` has length 5 and the contact is still `pending`.

- [ ] **Step 3: Change insertQueuedCall to return the attempt**

In `console/api/src/calls/queries.ts`:

```ts
/** Attempt numbers count per contact, which is what manual retry increments. */
export async function insertQueuedCall(
  client: PoolClient,
  args: { campaignId: string; contactId: string; phoneNumberId: string },
): Promise<{ id: string; attempt: number }> {
  const result = await client.query(
    `INSERT INTO calls (campaign_id, contact_id, phone_number_id, attempt)
     SELECT $1, $2, $3,
            COALESCE((SELECT max(attempt) FROM calls WHERE contact_id = $2), 0) + 1
       RETURNING id, attempt`,
    [args.campaignId, args.contactId, args.phoneNumberId],
  );
  return parseExactlyOne(
    z.object({ id: z.string().uuid(), attempt: z.number().int() }),
    result,
  );
}
```

- [ ] **Step 4: Apply the cap in the dispatcher**

In `console/api/src/dispatch/dispatcher.ts`:

Add `markContactDone` to the import from `../calls/queries.js`, and export the
constant near `TICK_MS`:

```ts
/**
 * Automatic redials per contact. Failure here is a dial that never reached
 * Telnyx - a Worker outage or a secret mismatch - so a couple of retries
 * absorb a blip, and the cap stops a misconfiguration from looping forever.
 * After the cap the contact is done and the call's Retry button is the path.
 */
export const MAX_DIAL_ATTEMPTS = 3;
```

Update the claim to keep the attempt (the transaction callback changes from
`const callId = await insertQueuedCall(...)` to):

```ts
        const queued = await insertQueuedCall(client, {
          campaignId: campaign.id,
          contactId: contact.contactId,
          phoneNumberId: lease.phoneNumberId,
        });
        await attachLeaseToCall(client, lease.leaseId, queued.id);
        return { ...contact, callId: queued.id, attempt: queued.attempt };
```

And in the `catch` block, replace `await releaseContact(pool, claimed.contactId);`
with:

```ts
        if (claimed.attempt >= MAX_DIAL_ATTEMPTS) {
          // Terminal for this contact: done + a failed call keeps the manual
          // Retry button as the only way it dials again.
          await markContactDone(pool, claimed.callId);
        } else {
          await releaseContact(pool, claimed.contactId);
        }
```

- [ ] **Step 5: Verify**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: PASS, including every pre-existing dispatcher case.
Then: `cd console && npm run typecheck`
Expected: clean - proves no other caller of `insertQueuedCall` was missed.

---

### Task 4: Sweeper releases the contact, not just the lease

An expired lease (lost hangup callback) marks the call `ended`/`unknown` but
leaves the contact `dialing` forever, so the campaign never completes and
nothing surfaces the stuck state.

**Files:**
- Modify: `console/api/src/dispatch/dispatcher.ts:51-60`
- Test: `console/api/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `markContactDone(pool, callId)` - already imported in Task 3.
- Produces: no signature changes. After a sweep, the swept call's contact is
  `done`.

- [ ] **Step 1: Write the failing test**

In `console/api/test/dispatcher.test.ts`, append:

```ts
  it("marks the contact done when its lease expires, so the campaign can finish", async () => {
    await addContacts(1);
    await addNumbers(1);
    await dispatchOnce(deps(new RecordingDialer()));

    // The hangup callback never arrives; the lease times out instead.
    await pool.query("UPDATE number_leases SET expires_at = now() - interval '1 minute'");
    await dispatchOnce(deps(new RecordingDialer()));

    const contact = await pool.query("SELECT status FROM contacts");
    expect(contact.rows[0].status).toBe("done");

    const call = await pool.query("SELECT status, outcome FROM calls");
    expect(call.rows[0].status).toBe("ended");
    expect(call.rows[0].outcome).toBe("unknown");

    const campaign = await pool.query("SELECT status FROM campaigns");
    expect(campaign.rows[0].status).toBe("completed");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: FAIL - contact still `dialing`, campaign still `running`.

- [ ] **Step 3: Implement**

In `dispatchOnce`, extend the sweep loop:

```ts
  const strandedCallIds = await sweepExpiredLeases(pool);
  for (const callId of strandedCallIds) {
    await markEnded(pool, {
      callId,
      outcome: "unknown",
      lastStep: null,
      hangupCause: null,
    });
    // The hangup callback that normally does this never arrived. Done, not
    // pending: an unknown outcome must not auto-redial someone who may have
    // just finished the survey. The call is ended, so Retry stays available.
    await markContactDone(pool, callId);
  }
```

- [ ] **Step 4: Verify**

Run: `cd console && npm run test --workspace @console/api -- dispatcher`
Expected: PASS.

---

### Task 5: Refuse an http PUBLIC_BASE_URL when the real dialer is selected

The Worker rejects http `callbackUrl` values with 400, so `DIALER=cf-worker`
plus an http `PUBLIC_BASE_URL` makes every dial fail - which Task 3 now caps,
but the misconfiguration should die at boot, not at dial time. `DIALER=fake`
keeps accepting http because the dev compose posts callbacks to
`http://api:3000` on the compose network.

**Files:**
- Modify: `console/api/src/config.ts:45-78`
- Test: `console/api/test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadConfig` unchanged in signature; it now throws
  `invalid environment: PUBLIC_BASE_URL must be https when DIALER=cf-worker`.

- [ ] **Step 1: Write the failing test**

In `console/api/test/config.test.ts`, append to the main describe block
(the file's `valid` object already carries `PUBLIC_BASE_URL` and the worker
variables - reuse it):

```ts
  it("refuses an http PUBLIC_BASE_URL with the real dialer, which the Worker would 400", () => {
    expect(() =>
      loadConfig({
        ...valid,
        DIALER: "cf-worker",
        PUBLIC_BASE_URL: "http://console.example.com",
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("accepts an http PUBLIC_BASE_URL with the fake dialer, which dev compose relies on", () => {
    const config = loadConfig({
      ...valid,
      DIALER: "fake",
      PUBLIC_BASE_URL: "http://api:3000",
    });
    expect(config.publicBaseUrl).toBe("http://api:3000");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd console && npm run test --workspace @console/api -- config`
Expected: FAIL on the first new case (no error thrown).

- [ ] **Step 3: Implement**

In `console/api/src/config.ts`, inside `loadConfig` after the `safeParse`
success check and before the `return`:

```ts
  if (
    value.DIALER === "cf-worker" &&
    !value.PUBLIC_BASE_URL.startsWith("https://")
  ) {
    throw new Error(
      "invalid environment: PUBLIC_BASE_URL must be https when DIALER=cf-worker" +
        " - the Worker rejects http callback URLs",
    );
  }
```

- [ ] **Step 4: Verify**

Run: `cd console && npm run test --workspace @console/api -- config`
Expected: PASS.

---

### Task 6: Full verification

- [ ] **Step 1: Ensure infrastructure is up**

Run: `cd console && docker compose -f docker-compose.dev.yml up -d postgres minio minio-init dbmate`
Expected: postgres and minio healthy, dbmate exits 0.

- [ ] **Step 2: Run everything**

Run: `cd console && npm test && npm run typecheck`
Expected: all suites green (294 API tests before this plan, plus 10 new = 304,
plus 28 web) and a clean typecheck in all three workspaces.

- [ ] **Step 3: Report**

Summarise the four behaviour changes for the operator, flagging the two
decisions that alter spec-adjacent behaviour (retry revives completed
campaigns; dial failures cap at three attempts) so they can veto either.

## Out of scope

Deliberately not fixed here, recorded so they are not forgotten:

- `insertRecording` + ingest enqueue are not atomic; a crash between them
  strands one recording with no job and no self-healing replay.
- Two concurrent question uploads can race to the same position and surface a
  unique-violation 500 instead of a 409.
- `deleteContact` accepts a `dialing` contact, cascade-deleting a live call's
  row.
- The web UI still shows a Retry button during `retry.isPending` for all rows;
  cosmetic.
