import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
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

/** Records every URL the Worker sends to a session object. */
let sessionCalls: string[] = [];

function env(): Env {
  sessionCalls = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (input: string | Request) => {
        sessionCalls.push(typeof input === "string" ? input : input.url);
        return new Response("ok");
      },
    }),
  };

  return {
    TELNYX_API_KEY: "KEY",
    TELNYX_PUBLIC_KEY: publicKeyB64,
    TELNYX_CONNECTION_ID: "conn-1",
    TELNYX_FROM_NUMBER: "+15550000000",
    TRIGGER_SECRET: "s3cret",
    CALL_SESSIONS: namespace as unknown as DurableObjectNamespace,
  };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function fetchSpy() {
  // A fresh Response per call: sendCommand reads the body, and a body can only
  // be consumed once.
  return vi.fn(
    async (_url: string, _init: { method: string; body: string }) =>
      new Response("{}", { status: 200 }),
  );
}

async function signedWebhook(body: unknown, query = "") {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${timestamp}|${raw}`),
  );
  return new Request(`https://w.example.dev/webhooks/telnyx${query}`, {
    method: "POST",
    body: raw,
    headers: {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": bytesToB64(sig),
    },
  });
}

function answeredWebhook() {
  return signedWebhook({
    data: {
      event_type: "call.answered",
      payload: { call_control_id: "ccid-1" },
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

  it("issues record_start, streaming_start and playback_start on call.answered", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(await answeredWebhook(), env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]![0]).toContain("/actions/record_start");
    expect(spy.mock.calls[1]![0]).toContain("/actions/streaming_start");
    expect(spy.mock.calls[2]![0]).toContain("/actions/playback_start");
  });

  it("injects the call id into the stream url so audio and webhooks share a session", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(await answeredWebhook(), env(), ctx);

    const body = JSON.parse(spy.mock.calls[1]![1].body);
    const url = new URL(body.stream_url);
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("ccid")).toBe("ccid-1");
    expect(url.searchParams.get("origin")).toBe("https://w.example.dev");
  });

  it("carries silenceMs from the webhook query into the stream url", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook(
      {
        data: {
          event_type: "call.answered",
          payload: { call_control_id: "ccid-1" },
        },
      },
      "?silenceMs=3000",
    );
    await worker.fetch(request, env(), ctx);

    const body = JSON.parse(spy.mock.calls[1]![1].body);
    expect(new URL(body.stream_url).searchParams.get("silenceMs")).toBe("3000");
  });

  it("uses the request origin for the audio url", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(await answeredWebhook(), env(), ctx);

    const body = JSON.parse(spy.mock.calls[2]![1].body);
    expect(body.audio_url).toBe("https://w.example.dev/audio/q1.mp3");
  });

  it("arms the session when a question finishes playing", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();

    const request = await signedWebhook({
      data: {
        event_type: "call.playback.ended",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: 2 }),
        },
      },
    });
    await worker.fetch(request, e, ctx);

    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toContain("/arm?step=2");
    // The session, not the Worker, plays the next question.
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not arm the session after the thank-you, and hangs up instead", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();

    const request = await signedWebhook({
      data: {
        event_type: "call.playback.ended",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done" }),
        },
      },
    });
    await worker.fetch(request, e, ctx);

    expect(sessionCalls).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("/actions/hangup");
  });

  it("returns 200 and sends nothing for an unhandled event", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    const request = await signedWebhook({
      data: {
        event_type: "call.recording.saved",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done" }),
          recording_urls: { mp3: "https://rec.example/x.mp3" },
        },
      },
    });
    const response = await worker.fetch(request, env(), ctx);

    expect(response.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still returns 200 when a Telnyx command fails", async () => {
    const spy = vi.fn(
      async (_url: string, _init: { method: string; body: string }) =>
        new Response("boom", { status: 500 }),
    );
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(await answeredWebhook(), env(), ctx);

    expect(response.status).toBe(200);
  });
});

describe("GET /stream", () => {
  it("requires a ccid so the socket can find its session", async () => {
    const response = await worker.fetch(
      new Request("https://w.example.dev/stream"),
      env(),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("routes to the session identified by ccid", async () => {
    const e = env();
    const response = await worker.fetch(
      new Request("https://w.example.dev/stream?ccid=ccid-1"),
      e,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toContain("ccid=ccid-1");
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
    const spy = vi.fn(
      async (_url: string, _init: { method: string; body: string }) =>
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
    expect(await response.json()).toEqual({
      call_control_id: "ccid-9",
      silenceMs: 2500,
    });

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toBe(
      "https://w.example.dev/webhooks/telnyx?silenceMs=2500",
    );
    expect(sent.from).toBe("+15550000000");
  });

  it("puts a custom silenceMs on the webhook_url", async () => {
    const spy = vi.fn(
      async (_url: string, _init: { method: string; body: string }) =>
        new Response(JSON.stringify({ data: { call_control_id: "ccid-9" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      new Request("https://w.example.dev/calls", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: JSON.stringify({ to: "+37069625082", silenceMs: 3000 }),
      }),
      env(),
      ctx,
    );

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toContain("silenceMs=3000");
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
