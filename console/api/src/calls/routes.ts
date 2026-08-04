import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import type { Pool } from "../db/client.js";
import { parseOne } from "../db/rows.js";
import { campaignProgress, listCallsForCampaign } from "./queries.js";

const idSchema = z.object({ id: z.string().uuid() });

export function registerCallRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  app.get("/api/campaigns/:id/calls", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid campaign id");
    return listCallsForCampaign(pool, tenantId, parsed.data.id);
  });

  app.get("/api/campaigns/:id/progress", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid campaign id");
    return campaignProgress(pool, tenantId, parsed.data.id);
  });

  app.post("/api/calls/:id/retry", async (request) => {
    const { tenantId } = requireTenant(request);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid call id");

    // Joined through campaigns so another tenant's call id is simply not found.
    const found = await pool.query(
      `SELECT ca.id, ca.status, ca.contact_id
         FROM calls ca
         JOIN campaigns c ON c.id = ca.campaign_id
        WHERE c.tenant_id = $1 AND ca.id = $2`,
      [tenantId, parsed.data.id],
    );
    const call = parseOne(
      z.object({
        id: z.string().uuid(),
        status: z.string(),
        contact_id: z.string().uuid(),
      }),
      found,
    );
    if (!call) throw new HttpError(404, "call not found");
    if (call.status !== "ended" && call.status !== "failed") {
      throw new HttpError(409, "only a finished call can be retried");
    }

    // The old call row stays as history; the dispatcher creates a new one with
    // the next attempt number.
    await pool.query(`UPDATE contacts SET status = 'pending' WHERE id = $1`, [
      call.contact_id,
    ]);

    return { ok: true };
  });
}
