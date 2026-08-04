import { randomUUID } from "node:crypto";

export type AudioExtension = "mp3" | "wav";

const CONTENT_TYPES: Record<string, AudioExtension> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export function extensionForContentType(
  contentType: string,
): AudioExtension | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPES[base] ?? null;
}

/**
 * A uuid segment makes every upload a new object. Replacing a question is then
 * a new key plus a row update rather than an overwrite, so a partially failed
 * upload can never leave a campaign pointing at a truncated object.
 */
export function questionKey(
  tenantId: string,
  campaignId: string,
  position: number,
  extension: AudioExtension,
): string {
  return `tenants/${tenantId}/campaigns/${campaignId}/questions/${position}-${randomUUID()}.${extension}`;
}

export function thanksKey(
  tenantId: string,
  campaignId: string,
  extension: AudioExtension,
): string {
  return `tenants/${tenantId}/campaigns/${campaignId}/thanks-${randomUUID()}.${extension}`;
}
