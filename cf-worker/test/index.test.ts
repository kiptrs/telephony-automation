import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { encodeState } from "../src/state";

let publicKeyB64: string;
let privateKey: CryptoKey;

function bytesToB64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyB64 = bytesToB64(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function env() {
  return {
    TELNYX_API_KEY: "KEY",
    TELNYX_PUBLIC_KEY: publicKeyB64,
    TELNYX_CONNECTION_ID: "conn-1",
    TELNYX_FROM_NUMBER: "+15550000000",
    TRIGGER_SECRET: "s3cret",
  };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function signedWebhook(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${timestamp}|${raw}`),
  );
  return new Request("https://w.example.dev/webhooks/telnyx", {
    method: "POST",
    body: raw,
    headers: {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": bytesToB64(sig),
    },
  });
}

describe("POST /webhooks/telnyx", () => {
  it("rejects an unsigned webhook with 401 and sends no commands", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const request = new Request("https://w.example.dev/webhooks/telnyx", {
      method: "POST",
      body: JSON.stringify({ data: { event_type: "call.answered" } }),
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("issues record_start, transcription_start and playback_start on a signed call.answered", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]![0]).toContain("/actions/record_start");
    expect(spy.mock.calls[1]![0]).toContain("/actions/transcription_start");
    expect(spy.mock.calls[2]![0]).toContain("/actions/playback_start");
  });

  it("uses the request origin for the audio url", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    await worker.fetch(request, env(), ctx);

    const body = JSON.parse(spy.mock.calls[2]![1].body);
    expect(body.audio_url).toBe("https://w.example.dev/audio/q1.mp3");
  });

  it("returns 200 and sends nothing for an unhandled event", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.recording.saved",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done", phase: "playing" }),
          recording_urls: { mp3: "https://rec.example/x.mp3" },
        },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still returns 200 when a Telnyx command fails", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "ccid-1" },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
  });
});

describe("POST /calls", () => {
  it("rejects a missing or wrong bearer token", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const headerCases: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }];
    for (const headers of headerCases) {
      const response = await worker.fetch(
        new Request("https://w.example.dev/calls", {
          method: "POST",
          headers,
          body: JSON.stringify({ to: "+37060000000" }),
        }),
        env(),
        ctx,
      );
      expect(response.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("dials via Telnyx and returns the call_control_id", async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { call_control_id: "ccid-9" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      new Request("https://w.example.dev/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37060000000" }),
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ call_control_id: "ccid-9" });

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toBe("https://w.example.dev/webhooks/telnyx");
    expect(sent.from).toBe("+15550000000");
  });

  it("rejects a body with no `to`", async () => {
    const response = await worker.fetch(
      new Request("https://w.example.dev/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({}),
      }),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const response = await worker.fetch(
      new Request("https://w.example.dev/nope"),
      env(),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});
