import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://console:console@localhost:5432/console",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  S3_BUCKET: "console-dev",
  S3_REGION: "us-east-1",
  NODE_ENV: "test",
  WORKER_BASE_URL: "https://worker.example",
  WORKER_TRIGGER_SECRET: "trigger-secret",
  WORKER_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  PUBLIC_BASE_URL: "https://console.example",
  DIALER: "fake",
  TELNYX_API_KEY: "telnyx-key",
  ELEVENLABS_API_KEY: "elevenlabs-key",
};

describe("loadConfig", () => {
  it("reads a valid environment", () => {
    const config = loadConfig(valid);
    expect(config.databaseUrl).toBe(valid.DATABASE_URL);
    expect(config.s3.bucket).toBe("console-dev");
    expect(config.port).toBe(3000);
  });

  it("defaults S3 to real AWS when no endpoint is given", () => {
    const config = loadConfig(valid);
    expect(config.s3.endpoint).toBeNull();
    expect(config.s3.forcePathStyle).toBe(false);
  });

  it("uses path style when an endpoint is set, because MinIO requires it", () => {
    const config = loadConfig({ ...valid, S3_ENDPOINT: "http://localhost:9000" });
    expect(config.s3.endpoint).toBe("http://localhost:9000");
    expect(config.s3.forcePathStyle).toBe(true);
  });

  it("throws when DATABASE_URL is missing rather than starting up broken", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects a session secret short enough to brute force", () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it("refuses an http PUBLIC_BASE_URL with the real dialer, which the Worker would 400", () => {
    expect(() =>
      loadConfig({
        ...valid,
        DIALER: "cf-worker",
        PUBLIC_BASE_URL: "http://console.example.com",
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("accepts an http PUBLIC_BASE_URL with the fake dialer, which dev compose relies on", () => {
    const config = loadConfig({
      ...valid,
      DIALER: "fake",
      PUBLIC_BASE_URL: "http://api:3000",
    });
    expect(config.publicBaseUrl).toBe("http://api:3000");
  });
});
