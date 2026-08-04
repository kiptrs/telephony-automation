import type { QueryResult } from "pg";
import type { ZodType } from "zod";

/**
 * Raised when the database returned a shape the caller did not expect. This is
 * always a bug - a migration and a query drifted apart - so it carries the
 * column path rather than a generic validation message.
 */
export class RowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowParseError";
  }
}

export function parseRows<T>(schema: ZodType<T>, result: QueryResult): T[] {
  return result.rows.map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new RowParseError(`row ${index} did not match schema - ${detail}`);
    }
    return parsed.data;
  });
}

export function parseOne<T>(schema: ZodType<T>, result: QueryResult): T | null {
  if (result.rows.length > 1) {
    throw new RowParseError(
      `expected at most 1 row, got ${result.rows.length}`,
    );
  }
  const [row] = parseRows(schema, result);
  return row ?? null;
}

export function parseExactlyOne<T>(schema: ZodType<T>, result: QueryResult): T {
  const row = parseOne(schema, result);
  if (row === null) throw new RowParseError("expected exactly 1 row, got 0");
  return row;
}
