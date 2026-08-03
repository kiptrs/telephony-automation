import { describe, expect, it } from "vitest";
import { decodeState, encodeState, type FlowState } from "../src/state";

describe("encodeState / decodeState", () => {
  it("round-trips every valid step and phase combination", () => {
    const steps: FlowState["step"][] = [1, 2, 3, "done"];
    const phases: FlowState["phase"][] = ["playing", "listening"];
    for (const step of steps) {
      for (const phase of phases) {
        expect(decodeState(encodeState({ step, phase }))).toEqual({ step, phase });
      }
    }
  });

  it("produces base64 that is not plain JSON", () => {
    expect(encodeState({ step: 1, phase: "playing" })).not.toContain("{");
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
    expect(decodeState(btoa(JSON.stringify({ step: 9, phase: "playing" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: "nope", phase: "playing" })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ phase: "playing" })))).toBeNull();
  });

  it("returns null for a missing or invalid phase", () => {
    expect(decodeState(btoa(JSON.stringify({ step: 1 })))).toBeNull();
    expect(decodeState(btoa(JSON.stringify({ step: 1, phase: "waiting" })))).toBeNull();
  });
});
