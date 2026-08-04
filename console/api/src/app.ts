import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import { z } from "zod";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerAudioRoutes } from "./audio/routes.js";
import { registerCallbackRoutes } from "./callbacks/routes.js";
import { registerCallRoutes } from "./calls/routes.js";
import { PgJobQueue } from "./jobs/pg-queue.js";
import { registerMediaRoutes } from "./media/routes.js";
import { registerNumberRoutes } from "./numbers/routes.js";
import { registerCampaignRoutes } from "./campaigns/routes.js";
import { registerContactRoutes } from "./contacts/routes.js";
import { createS3 } from "./s3.js";
import { HttpError, SESSION_COOKIE } from "./auth/middleware.js";
import { findUserBySession } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Pool } from "./db/client.js";
import { RowParseError } from "./db/rows.js";

const uuidSchema = z.string().uuid();

export interface AppDeps {
  pool: Pool;
  config: Config;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.nodeEnv !== "test" });

  app.register(cookie);
  app.register(rawBody, { field: "rawBody", global: false, runFirst: true });
  app.register(multipart);

  // Resolves the session once per request. Routes then call requireUser or
  // requireTenant, so an unauthenticated request never reaches tenant data.
  app.addHook("onRequest", async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    // A cookie is attacker-controlled; sending a non-uuid straight to Postgres
    // would raise 22P02 rather than a clean 401.
    if (!uuidSchema.safeParse(raw).success) return;
    const user = await findUserBySession(deps.pool, raw);
    if (user) request.user = user;
  });

  // Annotated because Fastify 5 infers `unknown` for an unannotated handler.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error instanceof RowParseError) {
      request.log.error({ err: error }, "database row did not match schema");
      return reply.status(500).send({ error: "internal error" });
    }
    if (error.validation) {
      return reply.status(400).send({ error: "invalid request" });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "internal error" });
  });

  const s3 = createS3(deps.config);

  registerAuthRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerAudioRoutes(app, { ...deps, s3 });
  registerContactRoutes(app, deps);
  registerCallRoutes(app, deps);
  registerNumberRoutes(app, deps);

  // Inside a plugin so it loads after fastify-raw-body. onRoute hooks fire the
  // moment a route is added, and that plugin's hook does not exist until its
  // own deferred registration has run - a route added before it never gets a
  // rawBody, and the signature check then verifies an empty string.
  const queue = new PgJobQueue(deps.pool);
  registerMediaRoutes(app, { ...deps, s3, queue });

  app.register(async (instance) => {
    registerCallbackRoutes(instance, { ...deps, queue });
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
