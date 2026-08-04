import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let acmeCookie: string;
let globexCookie: string;
let acmeCampaignId: string;

beforeAll(async () => {
  const config = testConfig();
  pool = createPool(config);
  app = buildApp({ pool, config });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  const acme = await seedTenant(pool, "acme");
  const globex = await seedTenant(pool, "globex");
  acmeCookie = await loginAs(app, acme.email);
  globexCookie = await loginAs(app, globex.email);

  const created = await app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie: acmeCookie },
    payload: {
      name: "Acme survey",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    },
  });
  acmeCampaignId = created.json().id;
});

describe("tenant isolation", () => {
  it("hides another tenant's campaign from the list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { cookie: globexCookie },
    });
    expect(response.json()).toEqual([]);
  });

  // 404 and not 403 throughout: a 403 confirms the resource exists, which is
  // itself a cross-tenant leak.
  it("returns 404, not 403, when reading another tenant's campaign", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when patching another tenant's campaign", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
      payload: { name: "hijacked" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not modify the campaign it refused to patch", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
      payload: { name: "hijacked" },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.json().name).toBe("Acme survey");
  });

  it("returns 404 when deleting another tenant's campaign", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("still leaves the campaign intact for its owner after a refused delete", async () => {
    await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: globexCookie },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("returns 404 when listing another tenant's questions", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/questions`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when uploading into another tenant's campaign", async () => {
    const boundary = "----consoletest";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      Buffer.alloc(64, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/questions`,
      headers: {
        cookie: globexCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's thanks audio URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/thanks/url`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when previewing contacts against another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts/preview`,
      headers: { cookie: globexCookie },
      payload: { text: "+37060000001" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when importing into another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: globexCookie },
      payload: {
        rows: [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns an empty call list for another tenant's campaign", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/calls`,
      headers: { cookie: globexCookie },
    });
    expect(response.json()).toEqual([]);
  });

  it("returns 404 rather than launching another tenant's campaign", async () => {
    // launchBlockers reports "campaign not found", which the route turns into
    // a 404 - never a 409, which would confirm the campaign exists.
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/launch`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("leaves another tenant's campaign as a draft after a refused launch", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/launch`,
      headers: { cookie: globexCookie },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}`,
      headers: { cookie: acmeCookie },
    });
    expect(response.json().status).toBe("draft");
  });

  it("returns 404 when transcribing another tenant's campaign", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/transcribe`,
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's recording URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/recording",
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's transcript", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/calls/11111111-1111-4111-8111-111111111111/transcript",
      headers: { cookie: globexCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("imports nothing into the campaign it refused", async () => {
    await app.inject({
      method: "POST",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: globexCookie },
      payload: {
        rows: [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }],
      },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${acmeCampaignId}/contacts`,
      headers: { cookie: acmeCookie },
    });
    expect(list.json()).toEqual([]);
  });
});
