import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { encodeState } from "../src/state";
import type { AudioManifest } from "../src/flow";

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

const AUDIO: AudioManifest = {
  questions: ["https://cdn.example/q1.mp3", "https://cdn.example/q2.mp3"],
  thanks: "https://cdn.example/thanks.mp3",
};

/** Records every URL the Worker sends to a session object. */
let sessionCalls: string[] = [];
/** What the fake session object hands back from GET /manifest. */
let storedManifest: AudioManifest | null = AUDIO;
/** Whether POST /init succeeds. */
let seedOk = true;
/** What the Worker actually seeded. */
let seededManifest: AudioManifest | null = null;

function env(): Env {
  sessionCalls = [];
  storedManifest = AUDIO;
  seedOk = true;
  seededManifest = null;

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        sessionCalls.push(url);

        if (url.endsWith("/init")) {
          if (!seedOk) return new Response("boom", { status: 500 });
          seededManifest = JSON.parse(String(init?.body)) as AudioManifest;
          return new Response("ok");
        }
        if (url.endsWith("/manifest")) {
          if (!storedManifest) return new Response("no manifest", { status: 404 });
          return new Response(JSON.stringify(storedManifest), { status: 200 });
        }
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
    expect(url.searchParams.get("origin")).toBeNull();
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

  it("plays the seeded manifest's first question", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(await answeredWebhook(), env(), ctx);

    const body = JSON.parse(spy.mock.calls[2]![1].body);
    expect(body.audio_url).toBe(AUDIO.questions[0]);
  });

  it("hangs up when the session has no manifest", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();
    storedManifest = null;

    const response = await worker.fetch(await answeredWebhook(), e, ctx);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("/actions/hangup");
  });

  it("wipes the session on call.hangup", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();

    const request = await signedWebhook({
      data: {
        event_type: "call.hangup",
        payload: {
          call_control_id: "ccid-1",
          client_state: encodeState({ step: "done" }),
        },
      },
    });
    await worker.fetch(request, e, ctx);

    expect(sessionCalls.some((u) => u.endsWith("/end"))).toBe(true);
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
  function dialSpy() {
    return vi.fn(
      async (_url: string, _init: { method: string; body: string }) =>
        new Response(JSON.stringify({ data: { call_control_id: "ccid-9" } }), {
          status: 200,
        }),
    );
  }

  function callRequest(body: unknown) {
    return new Request("https://w.example.dev/calls", {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing or wrong bearer token", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const headerCases: Record<string, string>[] = [
      {},
      { Authorization: "Bearer wrong" },
    ];
    for (const headers of headerCases) {
      const response = await worker.fetch(
        new Request("https://w.example.dev/calls", {
          method: "POST",
          headers,
          body: JSON.stringify({ to: "+37060000000", audio: AUDIO }),
        }),
        env(),
        ctx,
      );
      expect(response.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("dials via Telnyx and returns the call_control_id", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({ to: "+37060000000", audio: AUDIO }),
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

  it("seeds the session with the manifest after dialling", async () => {
    vi.stubGlobal("fetch", dialSpy());

    await worker.fetch(
      callRequest({ to: "+37060000000", audio: AUDIO }),
      env(),
      ctx,
    );

    expect(sessionCalls.some((u) => u.endsWith("/init"))).toBe(true);
    expect(seededManifest).toEqual(AUDIO);
  });

  it("hangs up and returns 502 when seeding fails", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);
    const e = env();
    seedOk = false;

    const response = await worker.fetch(
      callRequest({ to: "+37060000000", audio: AUDIO }),
      e,
      ctx,
    );

    expect(response.status).toBe(502);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes("/actions/hangup")),
    ).toBe(true);
  });

  it("puts a custom silenceMs on the webhook_url", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    await worker.fetch(
      callRequest({ to: "+37069625082", silenceMs: 3000, audio: AUDIO }),
      env(),
      ctx,
    );

    const sent = JSON.parse(spy.mock.calls[0]![1].body);
    expect(sent.webhook_url).toContain("silenceMs=3000");
  });

  it("rejects a body with no `to`", async () => {
    const response = await worker.fetch(callRequest({ audio: AUDIO }), env(), ctx);
    expect(response.status).toBe(400);
  });

  it("rejects a body with no audio and does not dial", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({ to: "+37060000000" }),
      env(),
      ctx,
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an http audio url and does not dial", async () => {
    const spy = dialSpy();
    vi.stubGlobal("fetch", spy);

    const response = await worker.fetch(
      callRequest({
        to: "+37060000000",
        audio: {
          questions: ["http://cdn.example/q1.mp3"],
          thanks: AUDIO.thanks,
        },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
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
