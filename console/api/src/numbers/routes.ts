import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requirePlatformAdmin } from "../auth/middleware.js";
import type { Pool } from "../db/client.js";
import { listTenants } from "../tenants/queries.js";
import { insertNumber, listNumbers, updateNumber } from "./queries.js";

const createSchema = z.object({
  e164: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  telnyxNumberId: z.string().min(1).nullable().default(null),
  tenantId: z.string().uuid().nullable().default(null),
  maxConcurrent: z.number().int().min(1).max(10).default(1),
});

const updateSchema = z.object({
  status: z.enum(["active", "paused", "released"]).optional(),
  tenantId: z.string().uuid().nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(10).optional(),
});

const idSchema = z.object({ id: z.string().uuid() });

export function registerNumberRoutes(
  app: FastifyInstance,
  deps: { pool: Pool },
): void {
  const { pool } = deps;

  app.get("/api/admin/numbers", async (request) => {
    requirePlatformAdmin(request);
    return listNumbers(pool);
  });

  app.post("/api/admin/numbers", async (request, reply) => {
    requirePlatformAdmin(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid number payload");

    try {
      const number = await insertNumber(pool, parsed.data);
      return reply.status(201).send(number);
    } catch (error) {
      if (String(error).includes("phone_numbers_e164_key")) {
        throw new HttpError(409, `${parsed.data.e164} is already in the pool`);
      }
      throw error;
    }
  });

  app.patch("/api/admin/numbers/:id", async (request) => {
    requirePlatformAdmin(request);
    const params = idSchema.safeParse(request.params);
    if (!params.success) throw new HttpError(400, "invalid number id");
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid number payload");

    const number = await updateNumber(pool, params.data.id, parsed.data);
    if (!number) throw new HttpError(404, "number not found");
    return number;
  });

  app.get("/api/admin/tenants", async (request) => {
    requirePlatformAdmin(request);
    return listTenants(pool);
  });
}
