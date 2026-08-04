import { describe, expect, it } from "vitest";
import { parseManifest, presignedExpiryMs, requiredRunwayMs } from "../src/manifest";
import { MAX_QUESTIONS } from "../src/state";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

function amzDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** A SigV4 pre-signed URL signed at `signedAtMs`, valid for `ttlSeconds`. */
function presigned(ttlSeconds: number, signedAtMs = NOW): string {
  return (
    "https://bucket.s3.amazonaws.com/q.mp3" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    `&X-Amz-Date=${amzDate(signedAtMs)}` +
    `&X-Amz-Expires=${ttlSeconds}` +
    "&X-Amz-Signature=deadbeef"
  );
}

/** An hour of runway, which is the agreed signing TTL. */
function goodUrl(): string {
  return presigned(3600);
}

function manifest(overrides: Record<string, unknown> = {}) {
  return { questions: [goodUrl()], thanks: goodUrl(), ...overrides };
}

describe("requiredRunwayMs", () => {
  it("scales with the question count", () => {
    expect(requiredRunwayMs(10)).toBeGreaterThan(requiredRunwayMs(1));
  });

  it("stays well inside a 60 minute signing TTL at the maximum count", () => {
    expect(requiredRunwayMs(MAX_QUESTIONS)).toBeLessThan(60 * 60 * 1000);
  });
});

describe("presignedExpiryMs", () => {
  it("computes expiry from X-Amz-Date and X-Amz-Expires", () => {
    const url = new URL(presigned(3600));
    expect(presignedExpiryMs(url)).toBe(NOW + 3600 * 1000);
  });

  it("returns null for a URL that is not pre-signed", () => {
    expect(presignedExpiryMs(new URL("https://cdn.example/q.mp3"))).toBeNull();
  });

  it("returns null for a malformed X-Amz-Date rather than throwing", () => {
    const url = new URL(
      "https://b.s3.amazonaws.com/q.mp3?X-Amz-Date=nonsense&X-Amz-Expires=3600",
    );
    expect(presignedExpiryMs(url)).toBeNull();
  });
});

describe("parseManifest - shape", () => {
  it("accepts a valid manifest", () => {
    const result = parseManifest(manifest(), NOW);
    expect(result).toEqual({
      manifest: { questions: [goodUrl()], thanks: goodUrl() },
    });
  });

  it("accepts the maximum question count", () => {
    const questions = Array.from({ length: MAX_QUESTIONS }, () => goodUrl());
    const result = parseManifest(manifest({ questions }), NOW);
    expect("manifest" in result).toBe(true);
  });

  it.each([undefined, null, "string", 42])("rejects %s as the audio value", (bad) => {
    const result = parseManifest(bad, NOW);
    expect(result).toEqual({ error: { field: "audio", reason: "is required" } });
  });

  it("rejects questions that is not an array", () => {
    const result = parseManifest(manifest({ questions: "one" }), NOW);
    expect("error" in result && result.error.field).toBe("audio.questions");
  });

  it("rejects an empty questions array", () => {
    const result = parseManifest(manifest({ questions: [] }), NOW);
    expect("error" in result && result.error.reason).toContain("empty");
  });

  it("rejects more than MAX_QUESTIONS entries", () => {
    const questions = Array.from({ length: MAX_QUESTIONS + 1 }, () => goodUrl());
    const result = parseManifest(manifest({ questions }), NOW);
    expect("error" in result && result.error.reason).toContain("at most");
  });

  it("rejects a missing thanks", () => {
    const result = parseManifest({ questions: [goodUrl()] }, NOW);
    expect("error" in result && result.error.field).toBe("audio.thanks");
  });

  it("names the offending question by index", () => {
    const result = parseManifest(
      manifest({ questions: [goodUrl(), "not a url"] }),
      NOW,
    );
    expect("error" in result && result.error.field).toBe("audio.questions[1]");
  });
});

describe("parseManifest - URL rules", () => {
  it("rejects http", () => {
    const result = parseManifest(
      manifest({ questions: ["http://cdn.example/q.mp3"] }),
      NOW,
    );
    expect("error" in result && result.error.reason).toContain("https");
  });

  it("accepts a plain public https URL as opaque", () => {
    const result = parseManifest(
      { questions: ["https://cdn.example/q.mp3"], thanks: "https://cdn.example/t.mp3" },
      NOW,
    );
    expect("manifest" in result).toBe(true);
  });

  it("rejects an already expired pre-signed URL", () => {
    const expired = presigned(60, NOW - 10 * 60 * 1000);
    const result = parseManifest(manifest({ questions: [expired] }), NOW);
    expect("error" in result && result.error.reason).toContain("expires in");
  });

  it("rejects a pre-signed URL whose TTL is too short for the survey", () => {
    const questions = Array.from({ length: MAX_QUESTIONS }, () => presigned(300));
    const result = parseManifest(manifest({ questions }), NOW);
    expect("error" in result).toBe(true);
  });

  it("accepts a TTL just inside the required runway", () => {
    const needed = requiredRunwayMs(1);
    const ttl = Math.ceil(needed / 1000) + 10;
    const result = parseManifest(
      { questions: [presigned(ttl)], thanks: presigned(ttl) },
      NOW,
    );
    expect("manifest" in result).toBe(true);
  });

  it("rejects a TTL just outside the required runway", () => {
    const needed = requiredRunwayMs(1);
    const ttl = Math.floor(needed / 1000) - 10;
    const result = parseManifest(
      { questions: [presigned(ttl)], thanks: presigned(ttl) },
      NOW,
    );
    expect("error" in result).toBe(true);
  });

  it("checks the thanks URL too, not just the questions", () => {
    const result = parseManifest(
      { questions: [goodUrl()], thanks: presigned(60, NOW - 10 * 60 * 1000) },
      NOW,
    );
    expect("error" in result && result.error.field).toBe("audio.thanks");
  });
});
