import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCallbackSignature } from "../src/callbacks/verify.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = '{"event":"call.answered"}';
const NOW_MS = 1_800_000_000_000;
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));

function sign(timestamp: string, body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

describe("verifyCallbackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a body that was altered in flight", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY),
        rawBody: '{"event":"call.hangup"}',
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(TIMESTAMP, BODY, "wrong-secret-wrong-secret-wrong!"),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a replay from six minutes ago", () => {
    const old = String(Math.floor(NOW_MS / 1000) - 360);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: old,
        signature: sign(old, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("accepts a request four minutes old, allowing for clock drift", () => {
    const recent = String(Math.floor(NOW_MS / 1000) - 240);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: recent,
        signature: sign(recent, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a timestamp from the future beyond the tolerance", () => {
    const future = String(Math.floor(NOW_MS / 1000) + 360);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: future,
        signature: sign(future, BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: null,
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature without the sha256 prefix", () => {
    const bare = sign(TIMESTAMP, BODY).slice("sha256=".length);
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: bare,
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: "not-a-number",
        signature: sign("not-a-number", BODY),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(
      verifyCallbackSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: "sha256=abcd",
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});
