import { z } from "zod";

export const MAX_CONTACTS_PER_CAMPAIGN = 10_000;

export const parsedContactSchema = z.object({
  e164: z.string(),
  externalRef: z.string().nullable(),
  sourceLine: z.number().int(),
});
export type ParsedContact = z.infer<typeof parsedContactSchema>;

export const rejectedContactSchema = z.object({
  raw: z.string(),
  reason: z.string(),
  sourceLine: z.number().int(),
});
export type RejectedContact = z.infer<typeof rejectedContactSchema>;

export const contactPreviewRequestSchema = z.union([
  z.object({ csv: z.string().min(1) }),
  z.object({ text: z.string().min(1) }),
]);
export type ContactPreviewRequest = z.infer<typeof contactPreviewRequestSchema>;

export const contactPreviewResponseSchema = z.object({
  accepted: z.array(parsedContactSchema),
  rejected: z.array(rejectedContactSchema),
  duplicatesInInput: z.array(rejectedContactSchema),
  alreadyInCampaign: z.array(rejectedContactSchema),
});
export type ContactPreviewResponse = z.infer<typeof contactPreviewResponseSchema>;

export const contactImportRequestSchema = z.object({
  rows: z.array(parsedContactSchema).min(1),
});
export type ContactImportRequest = z.infer<typeof contactImportRequestSchema>;
