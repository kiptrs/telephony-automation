import { describe, expect, it } from "vitest";
import { buildCallbackBody, signCallback, type CallbackEvent } from "../src/callback";

const SECRET = "a-long-shared-secret-value";

const event: CallbackEvent = {
  event: "call.hangup",
  call_control_id: "ccid-1",
  occurred_at: "2026-08-05T10:00:00.000Z",
  step: 2,
  payload: { hangup_cause: "normal_clearing" },
};

describe("signCallback", () => {
  it("produces lower-case hex", async () => {
    const signature = await signCallback(SECRET, "1000", "{}");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same inputs", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1000", "{}");
    expect(a).toBe(b);
  });

  it("changes when the body changes", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1000", '{"a":1}');
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes, so a capture cannot be replayed later", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback(SECRET, "1001", "{}");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", async () => {
    const a = await signCallback(SECRET, "1000", "{}");
    const b = await signCallback("different", "1000", "{}");
    expect(a).not.toBe(b);
  });

  it("binds the timestamp to the body rather than concatenating loosely", async () => {
    // Without a separator, ("10", "00{}") and ("1000", "{}") would sign the
    // same bytes and a timestamp could be shifted without detection.
    const a = await signCallback(SECRET, "10", "00{}");
    const b = await signCallback(SECRET, "1000", "{}");
    expect(a).not.toBe(b);
  });
});

describe("buildCallbackBody", () => {
  it("round-trips through JSON", () => {
    expect(JSON.parse(buildCallbackBody(event))).toEqual(event);
  });

  it("orders keys deterministically so the signed bytes are reproducible", () => {
    expect(buildCallbackBody(event)).toBe(
      buildCallbackBody({ ...event, payload: { hangup_cause: "normal_clearing" } }),
    );
  });

  it("keeps a null step, which is what an unanswered call reports", () => {
    const body = buildCallbackBody({ ...event, step: null });
    expect(JSON.parse(body).step).toBeNull();
  });
});
