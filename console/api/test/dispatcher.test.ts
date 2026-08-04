import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
