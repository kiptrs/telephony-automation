import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRecording,
  downloadRecording,
  pickRecordingUrl,
  TelnyxError,
} from "../src/telnyx.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickRecordingUrl", () => {
  it("prefers mp3", () => {
    expect(
      pickRecordingUrl({
        recording_urls: { mp3: "https://t.example/a.mp3", wav: "https://t.example/a.wav" },
      }),
    ).toBe("https://t.example/a.mp3");
  });

  it("falls back to wav when there is no mp3", () => {
    expect(
      pickRecordingUrl({ recording_urls: { wav: "https://t.example/a.wav" } }),
    ).toBe("https://t.example/a.wav");
  });

  it("reads public_recording_urls when recording_urls is absent", () => {
    expect(
      pickRecordingUrl({ public_recording_urls: { mp3: "https://t.example/p.mp3" } }),
    ).toBe("https://t.example/p.mp3");
  });

  it("returns null when there is no usable URL", () => {
    expect(pickRecordingUrl({ recording_urls: {} })).toBeNull();
    expect(pickRecordingUrl({})).toBeNull();
    expect(pickRecordingUrl(null)).toBeNull();
  });

  it("ignores a non-string URL rather than trusting it", () => {
    expect(pickRecordingUrl({ recording_urls: { mp3: 42 } })).toBeNull();
  });
});

describe("downloadRecording", () => {
  it("returns the bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "4" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      })),
    );
    const buffer = await downloadRecording("https://t.example/a.mp3");
    expect(buffer.byteLength).toBe(4);
  });

  it("throws on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "gone",
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toBeInstanceOf(
      TelnyxError,
    );
  });

  it("rejects an empty body, which would otherwise be uploaded as a valid file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "0" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects a truncated download, so a short file is never treated as ingested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "100" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).rejects.toThrow(
      /expected 100 bytes/,
    );
  });

  it("accepts a response with no content-length header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    await expect(downloadRecording("https://t.example/a.mp3")).resolves.toHaveLength(3);
  });
});

describe("deleteRecording", () => {
  it("issues a DELETE with the API key", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", spy);
    await deleteRecording("key-1", "rec-1");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/recordings/rec-1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
  });

  it("treats 404 as success, because the recording is already gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, text: async () => "not found" })),
    );
    await expect(deleteRecording("key-1", "rec-1")).resolves.toBeUndefined();
  });

  it("throws on any other failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    await expect(deleteRecording("key-1", "rec-1")).rejects.toBeInstanceOf(TelnyxError);
  });
});
