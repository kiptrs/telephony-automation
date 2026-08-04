import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireTenant } from "../auth/middleware.js";
import { findCampaign } from "../campaigns/queries.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import type { JobQueue } from "../jobs/queue.js";
import { presignGet, type S3Client } from "../s3.js";
import { WHISPER_MODEL } from "./transcribe.js";
import {
  findRecordingForCall,
  findTranscriptForCall,
  recordingsAwaitingTranscript,
  upsertTranscript,
} from "./queries.js";

const idSchema = z.object({ id: z.string().uuid() });
const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; s3: S3Client; queue: JobQueue },
): void {
  const { pool, config, s3, queue } = deps;

  function parseId(params: unknown, label: string): string {
    const parsed = idSchema.safeParse(params);
    if (!parsed.success) throw new HttpError(400, `invalid ${label} id`);
    return parsed.data.id;
  }

  /**
   * On demand only. Whisper is billed per minute, so nothing here runs because
   * a call finished - an operator has to ask.
   */
  app.post("/api/campaigns/:id/transcribe", async (request, reply) => {
    const { tenantId } = requireTenant(request);
    const campaignId = parseId(request.params, "campaign");

    const campaign = await findCampaign(pool, tenantId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");

    const recordingIds = await recordingsAwaitingTranscript(
      pool,
      tenantId,
      campaignId,
    );

    for (const recordingId of recordingIds) {
      // The pending row exists before the job runs so the UI shows progress
      // immediately rather than after the first poll that catches it running.
      await upsertTranscript(pool, {
        recordingId,
        engine: WHISPER_MODEL,
        language: campaign.language,
      });
      await queue.enqueue("transcribe", { recordingId });
    }

    return reply.status(202).send({ enqueued: recordingIds.length });
  });

  app.get("/api/calls/:id/recording", async (request) => {
    const { tenantId } = requireTenant(request);
    const callId = parseId(request.params, "call");

    const recording = await findRecordingForCall(pool, tenantId, callId);
    if (!recording || recording.s3Key === null || recording.ingestedAt === null) {
      throw new HttpError(404, "no recording available for this call");
    }

    return {
      url: await presignGet(s3, config, recording.s3Key, PLAYBACK_URL_TTL_SECONDS),
    };
  });

  app.get("/api/calls/:id/transcript", async (request) => {
    const { tenantId } = requireTenant(request);
    const callId = parseId(request.params, "call");

    const transcript = await findTranscriptForCall(pool, tenantId, callId);
    if (!transcript) throw new HttpError(404, "no transcript for this call");
    return transcript;
  });
}
