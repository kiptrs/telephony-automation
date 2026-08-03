import { beforeAll, describe, expect, it } from "vitest";
import { verifyTelnyxSignature } from "../src/verify";

let publicKeyB64: string;
let privateKey: CryptoKey;

function bytesToB64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function sign(timestamp: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${timestamp}|${body}`);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data);
  return bytesToB64(sig);
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyB64 = bytesToB64(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
});

describe("verifyTelnyxSignature", () => {
  const body = '{"data":{"event_type":"call.answered"}}';
  const nowMs = 1_700_000_000_000;
  const timestamp = String(nowMs / 1000);

  it("accepts a valid signature", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp, publicKeyB64, nowMs }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: '{"data":{"event_type":"call.hangup"}}',
        signature,
        timestamp,
        publicKeyB64,
        nowMs,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a missing signature or timestamp", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature: null, timestamp, publicKeyB64, nowMs }),
    ).resolves.toBe(false);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp: null, publicKeyB64, nowMs }),
    ).resolves.toBe(false);
  });

  it("rejects a replayed timestamp outside the tolerance", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature,
        timestamp,
        publicKeyB64,
        nowMs: nowMs + 6 * 60 * 1000,
      }),
    ).resolves.toBe(false);
  });

  it("accepts a timestamp inside the tolerance", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature,
        timestamp,
        publicKeyB64,
        nowMs: nowMs + 60 * 1000,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a non-numeric timestamp", async () => {
    const signature = await sign(timestamp, body);
    await expect(
      verifyTelnyxSignature({ rawBody: body, signature, timestamp: "abc", publicKeyB64, nowMs }),
    ).resolves.toBe(false);
  });

  it("rejects garbage signature bytes without throwing", async () => {
    await expect(
      verifyTelnyxSignature({
        rawBody: body,
        signature: "!!!not base64!!!",
        timestamp,
        publicKeyB64,
        nowMs,
      }),
    ).resolves.toBe(false);
  });
});
