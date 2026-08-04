import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseExactlyOne,
  parseOne,
  parseRows,
  RowParseError,
} from "../src/db/rows.js";

const userRow = z.object({
  id: z.string().uuid(),
  email: z.string(),
  created_at: z.date(),
});

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length } as never;
}

const validRow = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "a@b.c",
  created_at: new Date("2026-08-04T00:00:00Z"),
};

describe("parseRows", () => {
  it("parses every row", () => {
    const parsed = parseRows(userRow, result([validRow, validRow]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.email).toBe("a@b.c");
  });

  it("returns an empty array for no rows", () => {
    expect(parseRows(userRow, result([]))).toEqual([]);
  });

  it("throws on a column the schema does not describe as expected", () => {
    const bad = { ...validRow, created_at: "2026-08-04" };
    expect(() => parseRows(userRow, result([bad]))).toThrow(RowParseError);
  });

  it("names the offending column, because a silent shape drift is unfindable", () => {
    const bad = { ...validRow, created_at: "2026-08-04" };
    expect(() => parseRows(userRow, result([bad]))).toThrow(/created_at/);
  });
});

describe("parseOne", () => {
  it("returns the row when there is one", () => {
    expect(parseOne(userRow, result([validRow]))?.email).toBe("a@b.c");
  });

  it("returns null for no rows", () => {
    expect(parseOne(userRow, result([]))).toBeNull();
  });

  it("throws when a supposedly unique lookup returned several rows", () => {
    expect(() => parseOne(userRow, result([validRow, validRow]))).toThrow(
      /expected at most 1 row/,
    );
  });
});

describe("parseExactlyOne", () => {
  it("returns the row", () => {
    expect(parseExactlyOne(userRow, result([validRow])).email).toBe("a@b.c");
  });

  it("throws for no rows, so a failed RETURNING is never mistaken for success", () => {
    expect(() => parseExactlyOne(userRow, result([]))).toThrow(
      /expected exactly 1 row/,
    );
  });
});
