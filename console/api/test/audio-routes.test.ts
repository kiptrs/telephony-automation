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

/** A minimal multipart body. The bytes need not be real audio - nothing decodes them. */
function multipart(filename: string, contentType: string, bytes = 1024) {
  const boundary = "----consoletest";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const body = Buffer.alloc(bytes, 1);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(filename = "q1.mp3", contentType = "audio/mpeg") {
  const part = multipart(filename, contentType);
  return app.inject({
    method: "POST",
    url: `/api/campaigns/${campaignId}/questions`,
    headers: { ...part.headers, cookie },
    payload: part.payload,
  });
}

describe("POST /api/campaigns/:id/questions", () => {
  it("stores an mp3 and appends it at position 1", async () => {
    const response = await upload();
    expect(response.statusCode).toBe(201);
    expect(response.json().position).toBe(1);
    expect(response.json().originalFilename).toBe("q1.mp3");
  });

  it("appends subsequent uploads at the next position", async () => {
    await upload("q1.mp3");
    const second = await upload("q2.mp3");
    expect(second.json().position).toBe(2);
  });

  it("refuses a content type that is not audio", async () => {
    const response = await upload("notes.pdf", "application/pdf");
    expect(response.statusCode).toBe(400);
  });

  it("refuses an eleventh question, matching the Worker's MAX_QUESTIONS", async () => {
    for (let i = 0; i < 10; i++) await upload(`q${i + 1}.mp3`);
    const eleventh = await upload("q11.mp3");
    expect(eleventh.statusCode).toBe(409);
  });

  it("requires authentication", async () => {
    const part = multipart("q1.mp3", "audio/mpeg");
    const response = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: part.headers,
      payload: part.payload,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/campaigns/:id/questions", () => {
  it("lists in position order", async () => {
    await upload("q1.mp3");
    await upload("q2.mp3");
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: { cookie },
    });
    expect(
      response.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q1.mp3", "q2.mp3"]);
  });
});

describe("DELETE /api/campaigns/:id/questions/:qid", () => {
  it("closes the gap so positions stay contiguous", async () => {
    await upload("q1.mp3");
    const second = (await upload("q2.mp3")).json();
    await upload("q3.mp3");

    await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${campaignId}/questions/${second.id}`,
      headers: { cookie },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions`,
      headers: { cookie },
    });
    expect(list.json().map((q: { position: number }) => q.position)).toEqual([1, 2]);
    expect(
      list.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q1.mp3", "q3.mp3"]);
  });
});

describe("PATCH /api/campaigns/:id/questions/order", () => {
  it("reverses the order without tripping the unique constraint", async () => {
    const first = (await upload("q1.mp3")).json();
    const second = (await upload("q2.mp3")).json();
    const third = (await upload("q3.mp3")).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${campaignId}/questions/order`,
      headers: { cookie },
      payload: { ids: [third.id, second.id, first.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().map((q: { originalFilename: string }) => q.originalFilename),
    ).toEqual(["q3.mp3", "q2.mp3", "q1.mp3"]);
  });

  it("refuses a partial list rather than silently dropping questions", async () => {
    const first = (await upload("q1.mp3")).json();
    await upload("q2.mp3");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${campaignId}/questions/order`,
      headers: { cookie },
      payload: { ids: [first.id] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("PUT /api/campaigns/:id/thanks", () => {
  it("marks the campaign as having a thanks file", async () => {
    const part = multipart("thanks.mp3", "audio/mpeg");
    const response = await app.inject({
      method: "PUT",
      url: `/api/campaigns/${campaignId}/thanks`,
      headers: { ...part.headers, cookie },
      payload: part.payload,
    });
    expect(response.statusCode).toBe(200);

    const campaign = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}`,
      headers: { cookie },
    });
    expect(campaign.json().thanksUploaded).toBe(true);
  });
});

describe("GET /api/campaigns/:id/questions/:qid/url", () => {
  it("returns a presigned URL for playback", async () => {
    const question = (await upload()).json();
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions/${question.id}/url`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/X-Amz-Signature=/);
  });

  it("returns 404 for an unknown question", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/campaigns/${campaignId}/questions/11111111-1111-4111-8111-111111111111/url`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
