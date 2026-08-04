import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** When given, the response is validated, so a backend change surfaces here. */
  schema?: ZodType<T>;
  /** For multipart uploads, which must not get a JSON content type. */
  formData?: FormData;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiOptions<T> = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    // The session is a cookie, so every call must send it.
    credentials: "same-origin",
  };

  if (options.formData) {
    init.body = options.formData;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }

  const response = await fetch(path, init);

  if (!response.ok) {
    let message = `request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // A non-JSON error body is still an error; keep the status message.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return null as T;

  const body = (await response.json()) as unknown;
  if (!options.schema) return body as T;

  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, `response did not match schema: ${path}`);
  }
  return parsed.data;
}
