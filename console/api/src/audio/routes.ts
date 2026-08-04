import { MAX_QUESTIONS } from "@console/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import { findCampaign } from "../campaigns/queries.js";
import { parseCampaignId } from "../campaigns/routes.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { presignGet, putObject, type S3Client } from "../s3.js";
import { extensionForContentType, questionKey, thanksKey } from "./keys.js";
import {
  deleteQuestionAndClose,
  findQuestion,
  findThanksKey,
  insertQuestionAtEnd,
  listQuestions,
  reorderQuestions,
  setThanksKey,
} from "./queries.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

const questionIdSchema = z.object({ qid: z.string().uuid() });
const orderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

interface UploadedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

async function readUpload(request: FastifyRequest): Promise<UploadedFile> {
  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (!part) throw new HttpError(400, "a file part is required");

  const buffer = await part.toBuffer();
  // @fastify/multipart truncates rather than throwing, so an oversized upload
  // would otherwise be stored silently cut short.
  if (part.file.truncated) {
    throw new HttpError(413, "audio must be 10 MB or smaller");
  }
  return { buffer, filename: part.filename, contentType: part.mimetype };
}

export function registerAudioRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; s3: S3Client },
): void {
  const { pool, config, s3 } = deps;

  async function requireOwnedCampaign(
    tenantId: string,
    params: unknown,
  ): Promise<string> {
    const id = parseCampaignId(params);
    const campaign = await findCampaign(pool, tenantId, id);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return id;
  }

  app.get("/api/campaigns/:id/questions", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    return listQuestions(pool, tenantId, campaignId);
  });

  app.post("/api/campaigns/:id/questions", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const upload = await readUpload(request);
    const extension = extensionForContentType(upload.contentType);
    if (!extension) {
      throw new HttpError(400, "audio must be audio/mpeg or audio/wav");
    }

    const existing = await listQuestions(pool, tenantId, campaignId);
    if (existing.length >= MAX_QUESTIONS) {
      throw new HttpError(
        409,
        `a campaign holds at most ${MAX_QUESTIONS} questions`,
      );
    }

    const key = questionKey(tenantId, campaignId, existing.length + 1, extension);
    // S3 first: a row pointing at a missing object is worse than an orphaned
    // object, which costs only storage.
    await putObject(s3, config, {
      key,
      body: upload.buffer,
      contentType: upload.contentType,
    });

    const question = await insertQuestionAtEnd(pool, campaignId, {
      s3Key: key,
      originalFilename: upload.filename,
      bytes: upload.buffer.byteLength,
    });
    if (!question) {
      throw new HttpError(
        409,
        `a campaign holds at most ${MAX_QUESTIONS} questions`,
      );
    }

    return reply.status(201).send(question);
  });

  app.delete("/api/campaigns/:id/questions/:qid", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = questionIdSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid question id");

    const deleted = await deleteQuestionAndClose(
      pool,
      tenantId,
      campaignId,
      parsed.data.qid,
    );
    if (!deleted) throw new HttpError(404, "question not found");
    return reply.status(204).send();
  });

  app.patch("/api/campaigns/:id/questions/order", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid order payload");

    const ok = await reorderQuestions(pool, tenantId, campaignId, parsed.data.ids);
    if (!ok) throw new HttpError(400, "ids must list every question exactly once");
    return listQuestions(pool, tenantId, campaignId);
  });

  app.put("/api/campaigns/:id/thanks", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const upload = await readUpload(request);
    const extension = extensionForContentType(upload.contentType);
    if (!extension) {
      throw new HttpError(400, "audio must be audio/mpeg or audio/wav");
    }

    const key = thanksKey(tenantId, campaignId, extension);
    await putObject(s3, config, {
      key,
      body: upload.buffer,
      contentType: upload.contentType,
    });
    await setThanksKey(pool, tenantId, campaignId, key);
    return { ok: true };
  });

  app.get("/api/campaigns/:id/questions/:qid/url", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);
    const parsed = questionIdSchema.safeParse(request.params);
    if (!parsed.success) throw new HttpError(400, "invalid question id");

    const question = await findQuestion(pool, tenantId, campaignId, parsed.data.qid);
    if (!question) throw new HttpError(404, "question not found");

    return {
      url: await presignGet(s3, config, question.s3Key, PLAYBACK_URL_TTL_SECONDS),
    };
  });

  app.get("/api/campaigns/:id/thanks/url", async (request) => {
    const { tenantId } = requireTenant(request);
    const campaignId = await requireOwnedCampaign(tenantId, request.params);

    const key = await findThanksKey(pool, tenantId, campaignId);
    if (!key) throw new HttpError(404, "no thanks audio uploaded");
    return { url: await presignGet(s3, config, key, PLAYBACK_URL_TTL_SECONDS) };
  });
}
