export interface VerifyArgs {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKeyB64: string;
  toleranceSeconds?: number;
  nowMs?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function verifyTelnyxSignature(args: VerifyArgs): Promise<boolean> {
  const {
    rawBody,
    signature,
    timestamp,
    publicKeyB64,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    nowMs = Date.now(),
  } = args;

  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      b64ToBytes(signature),
      new TextEncoder().encode(`${timestamp}|${rawBody}`),
    );
  } catch {
    return false;
  }
}
