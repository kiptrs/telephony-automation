import { describe, expect, it } from "vitest";
import type { Call } from "@console/shared";
import { outcomeLabel } from "../src/components/OutcomeBadge.js";

const base: Call = {
  id: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  e164: "+37060000001",
  externalRef: null,
  fromE164: "+37069000001",
  attempt: 1,
  status: "ended",
  outcome: "completed",
  lastStep: "done",
  hangupCause: "normal_clearing",
  createdAt: "2026-08-05T10:00:00.000Z",
  answeredAt: "2026-08-05T10:00:05.000Z",
  endedAt: "2026-08-05T10:01:00.000Z",
  hasRecording: false,
  transcriptStatus: null,
};

describe("outcomeLabel", () => {
  it("labels a completed survey", () => {
    expect(outcomeLabel(base)).toBe("Completed");
  });

  it("says which question an abandoned call reached", () => {
    expect(outcomeLabel({ ...base, outcome: "abandoned", lastStep: 2 })).toBe(
      "Abandoned at question 2",
    );
  });

  it("labels an abandoned call with no step at all", () => {
    expect(outcomeLabel({ ...base, outcome: "abandoned", lastStep: null })).toBe(
      "Abandoned before question 1",
    );
  });

  it("labels no answer", () => {
    expect(outcomeLabel({ ...base, outcome: "no_answer", lastStep: null })).toBe(
      "No answer",
    );
  });

  it("labels busy", () => {
    expect(outcomeLabel({ ...base, outcome: "busy", lastStep: null })).toBe("Busy");
  });

  it("labels a dial that never happened", () => {
    expect(
      outcomeLabel({ ...base, status: "failed", outcome: "failed", lastStep: null }),
    ).toBe("Failed to dial");
  });

  it("labels a lost call honestly rather than guessing", () => {
    expect(outcomeLabel({ ...base, outcome: "unknown", lastStep: null })).toBe(
      "Unknown",
    );
  });

  it("shows in-flight calls by status, not by a missing outcome", () => {
    expect(
      outcomeLabel({ ...base, status: "in_progress", outcome: null, lastStep: 1 }),
    ).toBe("In progress");
  });

  it("shows a queued call as dialing", () => {
    expect(
      outcomeLabel({ ...base, status: "dialing", outcome: null, lastStep: null }),
    ).toBe("Dialing");
  });
});
