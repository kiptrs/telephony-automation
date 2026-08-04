import type { ParsedContact, RejectedContact } from "@console/shared";
import { parse as parseCsv } from "csv-parse/sync";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface ParseResult {
  accepted: ParsedContact[];
  rejected: RejectedContact[];
  duplicatesInInput: RejectedContact[];
}

const PHONE_HEADERS = new Set(["phone", "number", "msisdn", "phone_number"]);
const REF_HEADERS = new Set(["ref", "external_ref", "reference", "id"]);

interface RawRow {
  phone: string;
  ref: string | null;
  sourceLine: number;
}

/**
 * Turns raw rows into a result, doing normalisation and duplicate detection in
 * one place so CSV and pasted text can never disagree about what is valid.
 */
function normalise(rows: RawRow[], defaultCountry: string): ParseResult {
  const accepted: ParsedContact[] = [];
  const rejected: RejectedContact[] = [];
  const duplicatesInInput: RejectedContact[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const raw = row.phone.trim();
    if (raw.length === 0) {
      rejected.push({
        raw: row.phone,
        reason: "phone value is empty",
        sourceLine: row.sourceLine,
      });
      continue;
    }

    const parsed = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
    if (!parsed || !parsed.isValid()) {
      rejected.push({
        raw,
        reason: "not a valid phone number for this campaign's country",
        sourceLine: row.sourceLine,
      });
      continue;
    }

    // Compare after normalisation so +37060000001 and 860000001 collide.
    const e164 = parsed.number;
    if (seen.has(e164)) {
      duplicatesInInput.push({
        raw,
        reason: `duplicate of ${e164} earlier in this list`,
        sourceLine: row.sourceLine,
      });
      continue;
    }

    seen.add(e164);
    accepted.push({ e164, externalRef: row.ref, sourceLine: row.sourceLine });
  }

  return { accepted, rejected, duplicatesInInput };
}

export function parseContactText(
  text: string,
  defaultCountry: string,
): ParseResult {
  const rows: RawRow[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    for (const piece of line.split(",")) {
      const value = piece.trim();
      // A blank line is not an error, it is just a blank line.
      if (value.length === 0) continue;
      rows.push({ phone: value, ref: null, sourceLine: index + 1 });
    }
  });

  return normalise(rows, defaultCountry);
}

export function parseContactCsv(
  csv: string,
  defaultCountry: string,
): ParseResult {
  let records: string[][];
  try {
    records = parseCsv(csv, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch (error) {
    // Malformed CSV is a user mistake, not a server error, so it comes back as
    // a rejection they can read.
    return {
      accepted: [],
      rejected: [
        {
          raw: csv.slice(0, 80),
          reason: `could not read the file as CSV: ${
            error instanceof Error ? error.message : String(error)
          }`,
          sourceLine: 1,
        },
      ],
      duplicatesInInput: [],
    };
  }

  const [first, ...rest] = records;
  if (!first) {
    return { accepted: [], rejected: [], duplicatesInInput: [] };
  }

  const header = first.map((cell) => cell.trim().toLowerCase());
  const phoneIndex = header.findIndex((cell) => PHONE_HEADERS.has(cell));
  const hasHeader = phoneIndex !== -1;
  const refIndex = hasHeader
    ? header.findIndex((cell) => REF_HEADERS.has(cell))
    : -1;

  // Without a recognised header the first column is the number and the first
  // row is data, not a heading.
  const dataRows = hasHeader ? rest : records;
  const lineOffset = hasHeader ? 2 : 1;
  const column = hasHeader ? phoneIndex : 0;

  const rows: RawRow[] = dataRows.map((record, index) => ({
    phone: record[column] ?? "",
    ref: refIndex === -1 ? null : (record[refIndex]?.trim() ?? null) || null,
    sourceLine: index + lineOffset,
  }));

  return normalise(rows, defaultCountry);
}
