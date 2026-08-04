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
