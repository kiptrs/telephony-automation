import { describe, expect, it } from "vitest";
import { parseContactCsv, parseContactText } from "../src/contacts/parse.js";

describe("parseContactText", () => {
  it("accepts one E.164 number per line", () => {
    const result = parseContactText("+37060000001\n+37060000002", "LT");
    expect(result.accepted.map((c) => c.e164)).toEqual([
      "+37060000001",
      "+37060000002",
    ]);
  });

  it("normalises a national-format number using the campaign country", () => {
    const result = parseContactText("860000001", "LT");
    expect(result.accepted[0]?.e164).toBe("+37060000001");
  });

  it("strips spaces, dashes, and parentheses", () => {
    const result = parseContactText("+370 (6) 00-000-01", "LT");
    expect(result.accepted[0]?.e164).toBe("+37060000001");
  });

  it("splits on commas as well as newlines", () => {
    const result = parseContactText("+37060000001, +37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("ignores blank lines without reporting them as rejected", () => {
    const result = parseContactText("+37060000001\n\n  \n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it("rejects an unparseable number with its line number", () => {
    const result = parseContactText("+37060000001\nnot-a-number", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0]?.sourceLine).toBe(2);
    expect(result.rejected[0]?.raw).toBe("not-a-number");
  });

  it("rejects a number that parses but is not a valid subscriber number", () => {
    const result = parseContactText("+37011", "LT");
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/not a valid phone number/);
  });

  it("reports a repeated number as a duplicate, keeping the first occurrence", () => {
    const result = parseContactText("+37060000001\n+37060000001", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicatesInInput).toHaveLength(1);
    expect(result.duplicatesInInput[0]?.sourceLine).toBe(2);
  });

  it("treats two spellings of the same number as one duplicate", () => {
    const result = parseContactText("+37060000001\n860000001", "LT");
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicatesInInput).toHaveLength(1);
  });
});

describe("parseContactCsv", () => {
  it("uses the first column when there is no header", () => {
    const result = parseContactCsv("+37060000001\n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("finds a phone column by header name", () => {
    const csv = "name,phone\nAlice,+37060000001\nBob,+37060000002";
    const result = parseContactCsv(csv, "LT");
    expect(result.accepted.map((c) => c.e164)).toEqual([
      "+37060000001",
      "+37060000002",
    ]);
  });

  it("accepts number and msisdn as header aliases", () => {
    expect(parseContactCsv("number\n+37060000001", "LT").accepted).toHaveLength(1);
    expect(parseContactCsv("msisdn\n+37060000001", "LT").accepted).toHaveLength(1);
  });

  it("is case and whitespace insensitive about the header", () => {
    const result = parseContactCsv(" Phone \n+37060000001", "LT");
    expect(result.accepted).toHaveLength(1);
  });

  it("captures an optional ref column", () => {
    const csv = "phone,ref\n+37060000001,customer-7";
    const result = parseContactCsv(csv, "LT");
    expect(result.accepted[0]?.externalRef).toBe("customer-7");
  });

  it("leaves externalRef null when there is no ref column", () => {
    const result = parseContactCsv("phone\n+37060000001", "LT");
    expect(result.accepted[0]?.externalRef).toBeNull();
  });

  it("reports the line number from the file, header included", () => {
    const csv = "phone\n+37060000001\nbroken";
    const result = parseContactCsv(csv, "LT");
    expect(result.rejected[0]?.sourceLine).toBe(3);
  });

  it("rejects a row whose phone cell is empty", () => {
    const csv = "phone,ref\n,customer-7";
    const result = parseContactCsv(csv, "LT");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/empty/);
  });

  it("handles CRLF line endings, which is what Excel produces", () => {
    const result = parseContactCsv("phone\r\n+37060000001\r\n+37060000002", "LT");
    expect(result.accepted).toHaveLength(2);
  });

  it("returns everything rejected rather than throwing on malformed CSV", () => {
    const result = parseContactCsv('phone\n"unclosed', "LT");
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
});
