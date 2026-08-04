import { z } from "zod";

export const callStatusSchema = z.enum([
  "queued",
  "dialing",
  "in_progress",
  "ended",
  "failed",
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

export const callOutcomeSchema = z.enum([
  "completed",
  "abandoned",
  "no_answer",
  "busy",
  "failed",
  "unknown",
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

export const transcriptStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

export const transcriptSchema = z.object({
  status: transcriptStatusSchema,
  text: z.string().nullable(),
  language: z.string().nullable(),
  engine: z.string(),
  error: z.string().nullable(),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const callSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  e164: z.string(),
  externalRef: z.string().nullable(),
  fromE164: z.string().nullable(),
  attempt: z.number().int(),
  status: callStatusSchema,
  outcome: callOutcomeSchema.nullable(),
  lastStep: z.union([z.number().int(), z.literal("done")]).nullable(),
  hangupCause: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  hasRecording: z.boolean(),
  transcriptStatus: transcriptStatusSchema.nullable(),
});
export type Call = z.infer<typeof callSchema>;

export const campaignProgressSchema = z.object({
  pending: z.number().int(),
  dialing: z.number().int(),
  done: z.number().int(),
  total: z.number().int(),
});
export type CampaignProgress = z.infer<typeof campaignProgressSchema>;
