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
