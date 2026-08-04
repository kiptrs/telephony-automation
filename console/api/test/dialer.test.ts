import { afterEach, describe, expect, it, vi } from "vitest";
import { CfWorkerDialer, DialError, createDialer } from "../src/dispatch/dialer.js";
import { testConfig } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const args = {
  to: "+37060000001",
  from: "+37069000001",
  silenceMs: 2500,
  audio: {
    questions: ["https://s3.example/q1.mp3?X-Amz-Signature=x"],
    thanks: "https://s3.example/thanks.mp3?X-Amz-Signature=x",
  },
  callbackUrl: "https://console.example/callbacks/worker",
};

function stub(response: { ok: boolean; status: number; body: unknown }) {
  // The parameters are declared so vi.fn types mock.calls as [input, init].
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("CfWorkerDialer", () => {
  it("returns the call control id the Worker issued", async () => {
    stub({ ok: true, status: 200, body: { call_control_id: "ccid-9" } });
    const dialer = new CfWorkerDialer(testConfig());
    expect(await dialer.dial(args)).toEqual({ callControlId: "ccid-9" });
  });

  it("posts to the Worker's /calls with the trigger secret", async () => {
    const spy = stub({ ok: true, status: 200, body: { call_control_id: "x" } });
    await new CfWorkerDialer(testConfig()).dial(args);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://worker.example/calls");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer trigger-secret",
    );
  });

  it("sends every field the Worker needs", async () => {
    const spy = stub({ ok: true, status: 200, body: { call_control_id: "x" } });
    await new CfWorkerDialer(testConfig()).dial(args);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      to: args.to,
      from: args.from,
      silenceMs: args.silenceMs,
      audio: args.audio,
      callbackUrl: args.callbackUrl,
    });
  });

  it("throws DialError carrying the status on a rejection", async () => {
    stub({ ok: false, status: 400, body: { error: "audio.questions[0] expired" } });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("puts the Worker's message in the error, so a failed dial is diagnosable", async () => {
    stub({ ok: false, status: 400, body: { error: "audio.questions[0] expired" } });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toThrow(
      /expired/,
    );
  });

  it("throws DialError when the Worker returns no call_control_id", async () => {
    stub({ ok: true, status: 200, body: {} });
    await expect(new CfWorkerDialer(testConfig()).dial(args)).rejects.toBeInstanceOf(
      DialError,
    );
  });
});

describe("createDialer", () => {
  it("returns the fake when DIALER is fake", async () => {
    // The fake keeps delivering callbacks after dial() resolves, so this waits
    // for its sequence to finish rather than leaking events into the next test.
    const delivered: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        delivered.push(JSON.parse(String(init.body)).event);
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    const result = await dialer.dial(args);
    expect(result.callControlId).toMatch(/^fake-/);
    await vi.waitFor(() => expect(delivered).toContain("call.hangup"), {
      timeout: 5000,
    });
  });

  it("returns the real dialer when DIALER is cf-worker", () => {
    const dialer = createDialer({ ...testConfig(), dialer: "cf-worker" });
    expect(dialer).toBeInstanceOf(CfWorkerDialer);
  });
});

describe("FakeDialer", () => {
  it("delivers answered then hangup for each dial", async () => {
    const delivered: string[] = [];
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        delivered.push(JSON.parse(String(init.body)).event);
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await dialer.dial(args);
    await vi.waitFor(() => expect(delivered).toContain("call.hangup"), {
      timeout: 5000,
    });

    expect(delivered).toEqual([
      "call.answered",
      "call.recording.saved",
      "call.hangup",
    ]);
  });

  it("signs its callbacks the same way the Worker does", async () => {
    const headers: Record<string, string>[] = [];
    const dialer = createDialer({ ...testConfig(), dialer: "fake" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await dialer.dial(args);
    await vi.waitFor(() => expect(headers.length).toBeGreaterThan(0));
    expect(headers[0]!["x-console-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
