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

export async function setCampaignStatus(
  pool: Pool,
  tenantId: string,
  id: string,
  from: readonly string[],
  to: "running" | "paused",
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE campaigns
        SET status = $4,
            launched_at = CASE WHEN $4 = 'running' AND launched_at IS NULL
                               THEN now() ELSE launched_at END
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[])`,
    [tenantId, id, from, to],
  );
  return (result.rowCount ?? 0) > 0;
}
