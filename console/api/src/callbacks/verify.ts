import { createHmac, timingSafeEqual } from "node:crypto";

/** Generous enough for clock drift, tight enough that a capture goes stale. */
const MAX_SKEW_SECONDS = 300;

export function verifyCallbackSignature(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody } = args;
  const nowMs = args.nowMs ?? Date.now();

  if (!timestamp || !signature) return false;
  if (!signature.startsWith("sha256=")) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(nowMs / 1000 - sent) > MAX_SKEW_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");

  // timingSafeEqual throws on a length mismatch, which an attacker controls.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
