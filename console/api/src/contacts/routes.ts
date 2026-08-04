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
