import { afterEach, describe, expect, it, vi } from "vitest";
import { createCall, sendCommand, TelnyxError } from "../src/telnyx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("sendCommand", () => {
  it("posts to the action endpoint with the bearer key", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await sendCommand(
      "call-abc",
      { action: "hangup", params: { client_state: "xyz" } },
      "KEY123",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/calls/call-abc/actions/hangup");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer KEY123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ client_state: "xyz" });
  });

  it("throws TelnyxError with the status on failure", async () => {
    stubFetch(new Response("bad request", { status: 422 }));

    await expect(
      sendCommand("call-abc", { action: "hangup", params: {} }, "KEY123"),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 422 });
  });

  it("url-encodes the call control id", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));
    await sendCommand("a/b c", { action: "hangup", params: {} }, "K");
    expect(spy.mock.calls[0]![0]).toContain("a%2Fb%20c");
  });
});

describe("createCall", () => {
  it("posts the dial request and returns the call_control_id", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ data: { call_control_id: "ccid-1" } }), {
        status: 200,
      }),
    );

    const id = await createCall({
      to: "+37060000000",
      from: "+15550000000",
      connectionId: "conn-1",
      webhookUrl: "https://w.example.dev/webhooks/telnyx",
      apiKey: "KEY123",
    });

    expect(id).toBe("ccid-1");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/calls");
    expect(JSON.parse(init.body)).toEqual({
      to: "+37060000000",
      from: "+15550000000",
      connection_id: "conn-1",
      webhook_url: "https://w.example.dev/webhooks/telnyx",
      webhook_url_method: "POST",
    });
  });

  it("throws TelnyxError when the dial is rejected", async () => {
    stubFetch(new Response("nope", { status: 401 }));

    await expect(
      createCall({
        to: "+1",
        from: "+2",
        connectionId: "c",
        webhookUrl: "https://w",
        apiKey: "K",
      }),
    ).rejects.toBeInstanceOf(TelnyxError);
  });
});
