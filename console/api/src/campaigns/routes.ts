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
  setCampaignStatus,
  updateCampaign,
} from "./queries.js";
import { launchBlockers } from "./service.js";

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

  app.post("/api/campaigns/:id/launch", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);

    const blockers = await launchBlockers(pool, tenantId, id);
    if (blockers.includes("campaign not found")) {
      throw new HttpError(404, "campaign not found");
    }
    if (blockers.length > 0) {
      return reply.status(409).send({ error: "campaign is not ready", blockers });
    }

    // Only draft and paused may start; relaunching a running campaign would
    // double-dial nothing but is still a mistake worth refusing.
    const moved = await setCampaignStatus(
      pool,
      tenantId,
      id,
      ["draft", "paused"],
      "running",
    );
    if (!moved) throw new HttpError(409, "campaign is not in a launchable state");

    return findCampaign(pool, tenantId, id);
  });

  app.post("/api/campaigns/:id/pause", async (request) => {
    const { tenantId } = requireTenant(request);
    const id = parseCampaignId(request.params);

    const moved = await setCampaignStatus(pool, tenantId, id, ["running"], "paused");
    if (!moved) throw new HttpError(409, "only a running campaign can be paused");

    return findCampaign(pool, tenantId, id);
  });
}
