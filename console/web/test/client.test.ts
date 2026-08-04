import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch } from "../src/api/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response> & { jsonValue?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.jsonValue,
    })),
  );
}

describe("apiFetch", () => {
  it("returns the parsed body", async () => {
    stubFetch({ jsonValue: { id: "1" } });
    expect(await apiFetch<{ id: string }>("/api/thing")).toEqual({ id: "1" });
  });

  it("validates against a schema when one is given", async () => {
    stubFetch({ jsonValue: { id: 1 } });
    await expect(
      apiFetch("/api/thing", { schema: z.object({ id: z.string() }) }),
    ).rejects.toThrow(/response did not match/);
  });

  it("throws ApiError carrying the status", async () => {
    stubFetch({ ok: false, status: 401, jsonValue: { error: "unauthorized" } });
    await expect(apiFetch("/api/thing")).rejects.toMatchObject({
      status: 401,
      message: "unauthorized",
    });
  });

  it("still throws ApiError when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      })),
    );
    await expect(apiFetch("/api/thing")).rejects.toBeInstanceOf(ApiError);
  });

  it("sends credentials so the session cookie travels", async () => {
    // The parameters are declared so vi.fn types mock.calls as [input, init].
    const spy = vi.fn(
      async (_input: string, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }),
    );
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/thing");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("serialises a JSON body and sets the content type", async () => {
    // The parameters are declared so vi.fn types mock.calls as [input, init].
    const spy = vi.fn(
      async (_input: string, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }),
    );
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/thing", { method: "POST", body: { a: 1 } });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("returns null for a 204 rather than trying to parse it", async () => {
    stubFetch({ status: 204 });
    expect(await apiFetch("/api/thing", { method: "DELETE" })).toBeNull();
  });
});
