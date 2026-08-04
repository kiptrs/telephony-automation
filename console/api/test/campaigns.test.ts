import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPool, type Pool } from "../src/db/client.js";
import { loginAs, resetDatabase, seedTenant, testConfig } from "./helpers.js";

let pool: Pool;
let app: FastifyInstance;
let cookie: string;

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
});

const valid = {
  name: "August survey",
  language: "lt",
  defaultCountry: "LT",
  silenceMs: 3000,
};

// `object` rather than `unknown`: an unknown payload makes Fastify's inject
// overloads resolve to the chainable form, which has no statusCode.
async function createCampaign(body: object = valid) {
  return app.inject({
    method: "POST",
    url: "/api/campaigns",
    headers: { cookie },
    payload: body,
  });
}

describe("POST /api/campaigns", () => {
  it("creates a draft campaign", async () => {
    const response = await createCampaign();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("draft");
    expect(body.questionCount).toBe(0);
    expect(body.contactCount).toBe(0);
    expect(body.thanksUploaded).toBe(false);
  });

  it("defaults silenceMs to 2500 when omitted", async () => {
    const { silenceMs: _omitted, ...rest } = valid;
    const response = await createCampaign(rest);
    expect(response.json().silenceMs).toBe(2500);
  });

  it("rejects a silenceMs outside the Worker's accepted range", async () => {
    expect((await createCampaign({ ...valid, silenceMs: 250 })).statusCode).toBe(400);
    expect((await createCampaign({ ...valid, silenceMs: 20000 })).statusCode).toBe(400);
  });

  it("rejects an empty name", async () => {
    expect((await createCampaign({ ...valid, name: "  " })).statusCode).toBe(400);
  });

  it("normalises language to lower case and country to upper case", async () => {
    const response = await createCampaign({
      ...valid,
      language: "LT",
      defaultCountry: "lt",
    });
    expect(response.json().language).toBe("lt");
    expect(response.json().defaultCountry).toBe("LT");
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      payload: valid,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/campaigns", () => {
  it("lists newest first", async () => {
    await createCampaign({ ...valid, name: "first" });
    await createCampaign({ ...valid, name: "second" });
    const response = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { cookie },
    });
    expect(response.json().map((c: { name: string }) => c.name)).toEqual([
      "second",
      "first",
    ]);
  });
});

describe("PATCH /api/campaigns/:id", () => {
  it("updates only the given fields", async () => {
    const created = (await createCampaign()).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
      payload: { name: "renamed" },
    });
    expect(response.json().name).toBe("renamed");
    expect(response.json().language).toBe("lt");
  });

  it("returns 404 for an unknown id", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/campaigns/11111111-1111-4111-8111-111111111111",
      headers: { cookie },
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed id rather than 500", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/campaigns/not-a-uuid",
      headers: { cookie },
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("DELETE /api/campaigns/:id", () => {
  it("deletes a draft", async () => {
    const created = (await createCampaign()).json();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);
  });

  it("refuses to delete a campaign that has been launched", async () => {
    const created = (await createCampaign()).json();
    await pool.query("UPDATE campaigns SET status = 'running' WHERE id = $1", [
      created.id,
    ]);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});
