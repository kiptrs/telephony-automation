import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let cookie: string;
let campaignId: string;

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
  const tenant = await seedTenant(pool, "acme");
  cookie = await loginAs(app, tenant.email);
  const created = await app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie },
    payload: {
      name: "Survey",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    },
  });
  campaignId = created.json().id;
});

function preview(payload: object) {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/contacts/preview`,
    headers: { cookie },
    payload,
  });
}

function importRows(rows: unknown[]) {
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/contacts`,
    headers: { cookie },
    payload: { rows },
  });
}

describe("POST /api/campaigns/:id/contacts/preview", () => {
  it("returns accepted rows for a pasted list", async () => {
    const response = await preview({ text: "+37060000001\n+37060000002" });
    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toHaveLength(2);
  });

  it("returns accepted rows for a CSV with a header", async () => {
    const response = await preview({ csv: "phone,ref\n+37060000001,c-1" });
    expect(response.json().accepted[0].externalRef).toBe("c-1");
  });

  it("separates rejected rows with their reasons", async () => {
    const response = await preview({ text: "+37060000001\nrubbish" });
    expect(response.json().accepted).toHaveLength(1);
    expect(response.json().rejected).toHaveLength(1);
    expect(response.json().rejected[0].sourceLine).toBe(2);
  });

  it("writes nothing to the database", async () => {
    await preview({ text: "+37060000001" });
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    expect(list.json()).toEqual([]);
  });

  it("flags numbers the campaign already holds", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const response = await preview({ text: "+37060000001\n+37060000002" });
    expect(response.json().alreadyInCampaign).toHaveLength(1);
    expect(response.json().accepted).toHaveLength(1);
  });

  it("rejects a body with neither csv nor text", async () => {
    expect((await preview({})).statusCode).toBe(400);
  });

  it("uses the campaign's default country to normalise", async () => {
    const response = await preview({ text: "860000001" });
    expect(response.json().accepted[0].e164).toBe("+37060000001");
  });
});

describe("POST /api/campaigns/:id/contacts", () => {
  it("imports the confirmed rows", async () => {
    const response = await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
      { e164: "+37060000002", externalRef: "c-2", sourceLine: 2 },
    ]);
    expect(response.statusCode).toBe(201);
    expect(response.json().imported).toBe(2);
  });

  it("is idempotent when the same rows are submitted twice", async () => {
    const rows = [{ e164: "+37060000001", externalRef: null, sourceLine: 1 }];
    await importRows(rows);
    const second = await importRows(rows);
    expect(second.statusCode).toBe(201);
    expect(second.json().imported).toBe(0);
  });

  it("refuses a row whose e164 is not in E.164 form", async () => {
    const response = await importRows([
      { e164: "060000001", externalRef: null, sourceLine: 1 },
    ]);
    expect(response.statusCode).toBe(400);
  });

  it("refuses an import that would exceed the campaign cap", async () => {
    await pool.query(
      `INSERT INTO contacts (campaign_id, e164)
       SELECT $1, '+3706' || lpad(g::text, 7, '0')
         FROM generate_series(1, 10000) AS g`,
      [campaignId],
    );
    const response = await importRows([
      { e164: "+37069999999", externalRef: null, sourceLine: 1 },
    ]);
    expect(response.statusCode).toBe(409);
  });

  it("rejects an empty rows array", async () => {
    expect((await importRows([])).statusCode).toBe(400);
  });
});

describe("GET and DELETE contacts", () => {
  it("lists imported contacts as pending", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    expect(response.json()[0].status).toBe("pending");
  });

  it("deletes one contact", async () => {
    await importRows([
      { e164: "+37060000001", externalRef: null, sourceLine: 1 },
    ]);
    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/contacts`,
      headers: { cookie },
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/contacts/${list.json()[0].id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);
  });

  it("returns 404 deleting an unknown contact", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/contacts/11111111-1111-4111-8111-111111111111`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
