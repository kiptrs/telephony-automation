import { z } from "zod";

export const campaignStatusSchema = z.enum([
  "draft",
  "running",
  "paused",
  "completed",
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 10_000;
export const DEFAULT_SILENCE_MS = 2500;
export const MAX_QUESTIONS = 10;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // The transcription language hint, ISO-639-1.
  language: z.string().trim().length(2).toLowerCase(),
  // E.164 parsing region, ISO-3166-1 alpha-2.
  defaultCountry: z.string().trim().length(2).toUpperCase(),
  silenceMs: z
    .number()
    .int()
    .min(MIN_SILENCE_MS)
    .max(MAX_SILENCE_MS)
    .default(DEFAULT_SILENCE_MS),
});
export type CreateCampaignRequest = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = createCampaignSchema.partial();
export type UpdateCampaignRequest = z.infer<typeof updateCampaignSchema>;

export const campaignSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  language: z.string(),
  defaultCountry: z.string(),
  silenceMs: z.number().int(),
  status: campaignStatusSchema,
  thanksUploaded: z.boolean(),
  questionCount: z.number().int(),
  contactCount: z.number().int(),
  createdAt: z.string(),
});
export type Campaign = z.infer<typeof campaignSchema>;
