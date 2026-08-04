import { describe, expect, it } from "vitest";
import { campaignReadiness } from "../src/api/campaigns.js";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Survey",
  language: "lt",
  defaultCountry: "LT",
  silenceMs: 2500,
  status: "draft" as const,
  thanksUploaded: true,
  questionCount: 2,
  contactCount: 5,
  createdAt: "2026-08-04T00:00:00.000Z",
};

describe("campaignReadiness", () => {
  it("is ready when audio, thanks, and contacts are all present", () => {
    expect(campaignReadiness(base)).toEqual({ ready: true, blockers: [] });
  });

  it("blocks with no questions", () => {
    const result = campaignReadiness({ ...base, questionCount: 0 });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("Upload at least one question");
  });

  it("blocks with no thanks audio", () => {
    const result = campaignReadiness({ ...base, thanksUploaded: false });
    expect(result.blockers).toContain("Upload the thank-you audio");
  });

  it("blocks with no contacts", () => {
    const result = campaignReadiness({ ...base, contactCount: 0 });
    expect(result.blockers).toContain("Import at least one contact");
  });

  it("lists every blocker at once rather than one at a time", () => {
    const result = campaignReadiness({
      ...base,
      questionCount: 0,
      thanksUploaded: false,
      contactCount: 0,
    });
    expect(result.blockers).toHaveLength(3);
  });

  it("caps questions at ten, matching the Worker", () => {
    const result = campaignReadiness({ ...base, questionCount: 11 });
    expect(result.blockers).toContain("A campaign holds at most 10 questions");
  });
});
