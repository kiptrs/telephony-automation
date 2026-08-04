import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  findCallByCcid,
  markAnswered,
  markContactDone,
  markEnded,
} from "../calls/queries.js";
import { deriveOutcome, encodeStep } from "../calls/outcome.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import type { JobQueue } from "../jobs/queue.js";
import { insertRecording } from "../media/queries.js";
import { releaseLeaseForCall } from "../numbers/pool.js";
import { pickRecordingUrl } from "../telnyx.js";
import { verifyCallbackSignature } from "./verify.js";

const bodySchema = z.object({
  event: z.string(),
  call_control_id: z.string().min(1),
  occurred_at: z.string(),
  step: z.union([z.number().int(), z.literal("done")]).nullable(),
  payload: z.record(z.unknown()).default({}),
});

export function registerCallbackRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: Config; queue: JobQueue },
): void {
  const { pool, config, queue } = deps;

  // The raw body is needed for HMAC verification, so this route opts out of
  // Fastify's JSON parsing rather than re-serialising and changing the bytes.
  app.post(
    "/callbacks/worker",
    { config: { rawBody: true } },
    async (request, reply) => {
      // request.body is the parsed JSON; fastify-raw-body puts the untouched
      // bytes on request.rawBody, and only those verify against the signature.
      const raw = request.rawBody;
      const rawBody =
        typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";

      const ok = verifyCallbackSignature({
        secret: config.worker.hmacSecret,
        timestamp:
          (request.headers["x-console-timestamp"] as string | undefined) ?? null,
        signature:
          (request.headers["x-console-signature"] as string | undefined) ?? null,
        rawBody,
      });
      if (!ok) return reply.status(401).send({ error: "invalid signature" });

      let parsed: z.infer<typeof bodySchema>;
      try {
        parsed = bodySchema.parse(JSON.parse(rawBody));
      } catch {
        return reply.status(400).send({ error: "invalid callback body" });
      }

      const call = await findCallByCcid(pool, parsed.call_control_id);
      // A callback for a call we never recorded is not an error worth retrying.
      if (!call) {
        request.log.warn(
          { ccid: parsed.call_control_id, event: parsed.event },
          "callback for unknown call",
        );
        return { ok: true };
      }

      switch (parsed.event) {
        case "call.answered":
          await markAnswered(pool, call.id);
          break;

        case "call.hangup": {
          const hangupCause =
            typeof parsed.payload.hangup_cause === "string"
              ? parsed.payload.hangup_cause
              : null;

          await markEnded(pool, {
            callId: call.id,
            outcome: deriveOutcome({
              step: parsed.step,
              answered: call.answered,
              hangupCause,
            }),
            lastStep: encodeStep(parsed.step),
            hangupCause,
          });
          await markContactDone(pool, call.id);
          // Freeing the number promptly is the whole reason this endpoint
          // exists rather than a polling loop.
          await releaseLeaseForCall(pool, call.id);
          break;
        }

        case "call.recording.saved": {
          const telnyxRecordingId = parsed.payload.recording_id;
          if (typeof telnyxRecordingId !== "string") {
            request.log.warn(
              { ccid: parsed.call_control_id },
              "recording saved without a recording_id",
            );
            break;
          }

          const recording = await insertRecording(pool, {
            callId: call.id,
            telnyxRecordingId,
            sourceUrl: pickRecordingUrl(parsed.payload),
            channels:
              typeof parsed.payload.channels === "string"
                ? parsed.payload.channels
                : null,
          });

          // Null means the unique constraint absorbed a replay, so the ingest
          // job was already enqueued and must not be enqueued twice.
          if (recording) {
            await queue.enqueue("ingest_recording", { recordingId: recording.id });
          }
          break;
        }

        default:
          break;
      }

      return { ok: true };
    },
  );
}
