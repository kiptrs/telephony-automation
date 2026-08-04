import { MAX_QUESTIONS } from "@console/shared";
import type { Pool } from "../db/client.js";
import { findCampaign } from "./queries.js";

/**
 * The server's definition of a launchable campaign. The web wizard has its own
 * `campaignReadiness` for the same rules; this is the one that is authoritative,
 * because the client can be edited and the server cannot.
 */
export async function launchBlockers(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<string[]> {
  const campaign = await findCampaign(pool, tenantId, campaignId);
  if (!campaign) return ["campaign not found"];

  const blockers: string[] = [];
  if (campaign.questionCount === 0) blockers.push("upload at least one question");
  if (campaign.questionCount > MAX_QUESTIONS) {
    blockers.push(`a campaign holds at most ${MAX_QUESTIONS} questions`);
  }
  if (!campaign.thanksUploaded) blockers.push("upload the thank-you audio");
  if (campaign.contactCount === 0) blockers.push("import at least one contact");

  // Positions must be contiguous from 1, because the Worker indexes
  // questions[step - 1] and a gap would play the wrong file or nothing.
  const positions = await pool.query(
    `SELECT position FROM campaign_questions
      WHERE campaign_id = $1 ORDER BY position`,
    [campaignId],
  );
  const expected = positions.rows.map((_row, index) => index + 1);
  const actual = positions.rows.map((row) => Number(row.position));
  if (actual.join(",") !== expected.join(",")) {
    blockers.push("question positions must run from 1 with no gaps");
  }

  return blockers;
}
