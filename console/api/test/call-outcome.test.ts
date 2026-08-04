import { describe, expect, it } from "vitest";
import { decodeStep, deriveOutcome, encodeStep } from "../src/calls/outcome.js";

describe("deriveOutcome", () => {
  it("calls a finished thank-you a completed survey", () => {
    expect(
      deriveOutcome({ step: "done", answered: true, hangupCause: "normal_clearing" }),
    ).toBe("completed");
  });

  it("calls a hangup mid-survey abandoned", () => {
    expect(
      deriveOutcome({ step: 2, answered: true, hangupCause: "normal_clearing" }),
    ).toBe("abandoned");
  });

  it("calls an answered call with no step abandoned, not completed", () => {
    // Answered but nothing played is still the caller leaving early.
    expect(
      deriveOutcome({ step: null, answered: true, hangupCause: "normal_clearing" }),
    ).toBe("abandoned");
  });

  it("reads user_busy as busy", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "user_busy" }),
    ).toBe("busy");
  });

  it("reads an unanswered call as no_answer", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "no_answer" }),
    ).toBe("no_answer");
  });

  it("reads a timeout as no_answer", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "timeout" }),
    ).toBe("no_answer");
  });

  it("reads an unanswered call with no cause at all as no_answer", () => {
    expect(deriveOutcome({ step: null, answered: false, hangupCause: null })).toBe(
      "no_answer",
    );
  });

  it("reads call_rejected as busy, because the callee actively declined", () => {
    expect(
      deriveOutcome({ step: null, answered: false, hangupCause: "call_rejected" }),
    ).toBe("busy");
  });

  it("trusts the step over the answered flag when they disagree", () => {
    // A step can only exist if audio played, which can only happen after answer.
    expect(
      deriveOutcome({ step: "done", answered: false, hangupCause: null }),
    ).toBe("completed");
  });
});

describe("step encoding", () => {
  it("stores done as 0, because the column is an integer", () => {
    expect(encodeStep("done")).toBe(0);
  });

  it("stores a question number as itself", () => {
    expect(encodeStep(3)).toBe(3);
  });

  it("stores no step as null", () => {
    expect(encodeStep(null)).toBeNull();
  });

  it("round-trips done", () => {
    expect(decodeStep(encodeStep("done"))).toBe("done");
  });

  it("round-trips a question number", () => {
    expect(decodeStep(encodeStep(7))).toBe(7);
  });

  it("round-trips null", () => {
    expect(decodeStep(encodeStep(null))).toBeNull();
  });
});
