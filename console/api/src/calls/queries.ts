import type { Call, CallOutcome, CampaignProgress } from "@console/shared";
import { z } from "zod";
import type { Pool, PoolClient } from "../db/client.js";
import { parseExactlyOne, parseOne, parseRows } from "../db/rows.js";
import { decodeStep } from "./outcome.js";

const callRow = z.object({
  id: z.string().uuid(),
  contact_id: z.string().uuid(),
  e164: z.string(),
  external_ref: z.string().nullable(),
  from_e164: z.string().nullable(),
  attempt: z.number().int(),
  status: z.enum(["queued", "dialing", "in_progress", "ended", "failed"]),
  outcome: z
    .enum(["completed", "abandoned", "no_answer", "busy", "failed", "unknown"])
    .nullable(),
  last_step: z.number().int().nullable(),
  hangup_cause: z.string().nullable(),
  created_at: z.date(),
  answered_at: z.date().nullable(),
  ended_at: z.date().nullable(),
  has_recording: z.boolean(),
  transcript_status: z
    .enum(["pending", "running", "done", "failed"])
    .nullable(),
});

function toCall(row: z.infer<typeof callRow>): Call {
  return {
    id: row.id,
    contactId: row.contact_id,
    e164: row.e164,
    externalRef: row.external_ref,
    fromE164: row.from_e164,
    attempt: row.attempt,
    status: row.status,
    outcome: row.outcome,
    lastStep: decodeStep(row.last_step),
    hangupCause: row.hangup_cause,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    hasRecording: row.has_recording,
    transcriptStatus: row.transcript_status,
  };
}

const SELECT_CALL = `
  SELECT ca.id, ca.contact_id, ct.e164, ct.external_ref, pn.e164 AS from_e164,
         ca.attempt, ca.status, ca.outcome, ca.last_step, ca.hangup_cause,
         ca.created_at, ca.answered_at, ca.ended_at,
         -- ingested_at, not "a row exists": a recording that has not been
         -- ingested has nothing to play.
         r.ingested_at IS NOT NULL AS has_recording,
         t.status AS transcript_status
    FROM calls ca
    JOIN contacts ct ON ct.id = ca.contact_id
    LEFT JOIN phone_numbers pn ON pn.id = ca.phone_number_id
    LEFT JOIN recordings r ON r.call_id = ca.id
    LEFT JOIN transcripts t ON t.recording_id = r.id
`;

export async function listCallsForCampaign(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<Call[]> {
  const result = await pool.query(
    `${SELECT_CALL}
       JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.tenant_id = $1 AND ca.campaign_id = $2
      ORDER BY ca.created_at DESC`,
    [tenantId, campaignId],
  );
  return parseRows(callRow, result).map(toCall);
}

export async function campaignProgress(
  pool: Pool,
  tenantId: string,
  campaignId: string,
): Promise<CampaignProgress> {
  const result = await pool.query(
    `SELECT count(*) FILTER (WHERE ct.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE ct.status = 'dialing')::int AS dialing,
            count(*) FILTER (WHERE ct.status = 'done')::int    AS done,
            count(*)::int                                      AS total
       FROM contacts ct
       JOIN campaigns c ON c.id = ct.campaign_id
      WHERE c.tenant_id = $1 AND ct.campaign_id = $2`,
    [tenantId, campaignId],
  );
  return parseExactlyOne(
    z.object({
      pending: z.number().int(),
      dialing: z.number().int(),
      done: z.number().int(),
      total: z.number().int(),
    }),
    result,
  );
}

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

export async function markDialing(
  pool: Pool,
  callId: string,
  callControlId: string,
): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'dialing', telnyx_call_control_id = $2,
            dialed_at = now()
      WHERE id = $1`,
    [callId, callControlId],
  );
}

export async function markFailed(pool: Pool, callId: string): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'failed', outcome = 'failed', ended_at = now()
      WHERE id = $1`,
    [callId],
  );
}

export async function findCallByCcid(
  pool: Pool,
  callControlId: string,
): Promise<{ id: string; answered: boolean; status: string } | null> {
  const result = await pool.query(
    `SELECT id, answered_at IS NOT NULL AS answered, status
       FROM calls WHERE telnyx_call_control_id = $1`,
    [callControlId],
  );
  return parseOne(
    z.object({
      id: z.string().uuid(),
      answered: z.boolean(),
      status: z.string(),
    }),
    result,
  );
}

/**
 * Forward-only: a replayed call.answered after the call has ended must not
 * reopen it. This is what makes callback delivery idempotent without a
 * separate dedupe table.
 */
export async function markAnswered(pool: Pool, callId: string): Promise<void> {
  await pool.query(
    `UPDATE calls SET status = 'in_progress', answered_at = COALESCE(answered_at, now())
      WHERE id = $1 AND status IN ('queued', 'dialing')`,
    [callId],
  );
}

export async function markEnded(
  pool: Pool,
  args: {
    callId: string;
    outcome: CallOutcome;
    lastStep: number | null;
    hangupCause: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE calls
        SET status = 'ended', outcome = $2, last_step = $3, hangup_cause = $4,
            ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND status <> 'ended'`,
    [args.callId, args.outcome, args.lastStep, args.hangupCause],
  );
}

export async function markContactDone(
  pool: Pool,
  callId: string,
): Promise<void> {
  await pool.query(
    `UPDATE contacts SET status = 'done'
      WHERE id = (SELECT contact_id FROM calls WHERE id = $1)`,
    [callId],
  );
}
