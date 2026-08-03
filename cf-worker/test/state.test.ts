import { describe, expect, it } from "vitest";
import { decodeState, encodeState, type FlowState } from "../src/state";

describe("encodeState / decodeState", () => {
  it("round-trips every valid step", () => {
    const steps: FlowState["step"][] = [1, 2, 3, "done"];
    for (const step of steps) {
      expect(decodeState(encodeState({ step }))).toEqual({ step });
    }
  });

  it("produces base64 that is not plain JSON", () => {
    expect(encodeState({ step: 1 })).not.toContain("{");
  });

  it("returns null for absent input", () => {
    expect(decodeState(null)).toBeNull();
    expect(decodeState(undefined)).toBeNull();
    expect(decodeState("")).toBeNull();
  });

  it("returns null for non-base64 garbage without throwing", () => {
    expect(decodeState("!!!not base64!!!")).toBeNull();
  });

  it("returns null for base64 that is not JSON", () => {
    expect(decodeState(btoa("hello"))).toBeNull();
  });

  it("returns null for an out-of-range step", () => {
    expect(decodeState(btoa(JSON.stringify({ step: 9 })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: "nope" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({})))).toBeNull();
  });
});
