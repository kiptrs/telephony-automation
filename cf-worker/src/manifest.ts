import { MAX_ANSWER_MS, type AudioManifest } from "./flow";
import { MAX_QUESTIONS } from "./state";

export interface ManifestError {
  field: string;
  reason: string;
}

export type ManifestResult =
  | { manifest: AudioManifest }
  | { error: ManifestError };

/** Telnyx rings this long before giving up. */
const RING_ALLOWANCE_MS = 60_000;
/** Generous upper bound on how long one recording takes to play. */
const PLAYBACK_ALLOWANCE_MS = 10_000;
const MARGIN_MS = 60_000;

/**
 * How much life a pre-signed URL needs at dial time. Telnyx fetches each
 * audio_url at the moment it plays, so the thank-you is fetched last and latest.
 * Computed from the question count rather than a flat constant, so a ten
 * question survey is checked properly and a one question survey is not
 * over-rejected.
 */
export function requiredRunwayMs(questionCount: number): number {
  return (
    RING_ALLOWANCE_MS +
    questionCount * (MAX_ANSWER_MS + PLAYBACK_ALLOWANCE_MS) +
    PLAYBACK_ALLOWANCE_MS +
    MARGIN_MS
  );
}

const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Expiry of a SigV4 pre-signed URL in epoch ms, or null if the URL is not one.
 * X-Amz-Date is ISO8601 basic format, which Date.parse does not handle
 * reliably, so it is parsed by hand. No AWS credentials are involved.
 */
export function presignedExpiryMs(url: URL): number | null {
  const date = url.searchParams.get("X-Amz-Date");
  const expires = url.searchParams.get("X-Amz-Expires");
  if (!date || !expires) return null;

  const match = AMZ_DATE.exec(date);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;

  const seconds = Number(expires);
  if (!Number.isFinite(seconds)) return null;

  const signedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return signedAt + seconds * 1000;
}

function checkUrl(
  raw: unknown,
  field: string,
  runwayMs: number,
  nowMs: number,
): ManifestError | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return { field, reason: "must be a non-empty string" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { field, reason: "is not a valid URL" };
  }

  // Telnyx needs public HTTPS anyway, and a pre-signed URL sent in clear text
  // leaks its own signature.
  if (url.protocol !== "https:") {
    return { field, reason: `must use https, got ${url.protocol}` };
  }

  const expiresAt = presignedExpiryMs(url);
  if (expiresAt !== null && expiresAt - nowMs < runwayMs) {
    const remaining = Math.round((expiresAt - nowMs) / 1000);
    const needed = Math.round(runwayMs / 1000);
    return {
      field,
      reason: `pre-signed URL expires in ${remaining}s, needs at least ${needed}s`,
    };
  }

  return null;
}

/**
 * Validate untrusted manifest input. `nowMs` is injectable purely so expiry
 * tests can control the clock, matching the convention in verify.ts.
 */
export function parseManifest(value: unknown, nowMs = Date.now()): ManifestResult {
  if (typeof value !== "object" || value === null) {
    return { error: { field: "audio", reason: "is required" } };
  }

  const { questions, thanks } = value as {
    questions?: unknown;
    thanks?: unknown;
  };

  if (!Array.isArray(questions)) {
    return { error: { field: "audio.questions", reason: "must be an array" } };
  }
  if (questions.length === 0) {
    return { error: { field: "audio.questions", reason: "must not be empty" } };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      error: {
        field: "audio.questions",
        reason: `must hold at most ${MAX_QUESTIONS} entries, got ${questions.length}`,
      },
    };
  }

  const runwayMs = requiredRunwayMs(questions.length);

  for (let i = 0; i < questions.length; i++) {
    const error = checkUrl(questions[i], `audio.questions[${i}]`, runwayMs, nowMs);
    if (error) return { error };
  }

  const thanksError = checkUrl(thanks, "audio.thanks", runwayMs, nowMs);
  if (thanksError) return { error: thanksError };

  return {
    manifest: {
      questions: questions as string[],
      thanks: thanks as string,
    },
  };
}
