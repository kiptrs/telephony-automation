import { describe, expect, it } from "vitest";
import {
  extensionForContentType,
  questionKey,
  thanksKey,
} from "../src/audio/keys.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const campaign = "22222222-2222-4222-8222-222222222222";

describe("extensionForContentType", () => {
  it("maps the accepted audio types", () => {
    expect(extensionForContentType("audio/mpeg")).toBe("mp3");
    expect(extensionForContentType("audio/wav")).toBe("wav");
    expect(extensionForContentType("audio/x-wav")).toBe("wav");
  });

  it("ignores parameters on the content type", () => {
    expect(extensionForContentType("audio/mpeg; charset=binary")).toBe("mp3");
  });

  it("returns null for anything else, so an upload is refused not guessed", () => {
    expect(extensionForContentType("application/pdf")).toBeNull();
    expect(extensionForContentType("audio/ogg")).toBeNull();
  });
});

describe("questionKey", () => {
  it("namespaces by tenant then campaign", () => {
    const key = questionKey(tenant, campaign, 3, "mp3");
    expect(
      key.startsWith(`tenants/${tenant}/campaigns/${campaign}/questions/3-`),
    ).toBe(true);
    expect(key.endsWith(".mp3")).toBe(true);
  });

  it("is unique per call, so re-uploading a position never overwrites in place", () => {
    expect(questionKey(tenant, campaign, 1, "mp3")).not.toBe(
      questionKey(tenant, campaign, 1, "mp3"),
    );
  });
});

describe("thanksKey", () => {
  it("sits beside the questions", () => {
    expect(
      thanksKey(tenant, campaign, "wav").startsWith(
        `tenants/${tenant}/campaigns/${campaign}/thanks-`,
      ),
    ).toBe(true);
  });
});
