import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_SECRET: z.string().min(32),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  WORKER_BASE_URL: z.string().url(),
  WORKER_TRIGGER_SECRET: z.string().min(8),
  WORKER_HMAC_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url(),
  DIALER: z.enum(["cf-worker", "fake"]).default("cf-worker"),
  TELNYX_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export interface Config {
  databaseUrl: string;
  port: number;
  sessionSecret: string;
  nodeEnv: "development" | "production" | "test";
  s3: {
    endpoint: string | null;
    region: string;
    bucket: string;
    /** MinIO cannot serve virtual-hosted-style buckets, so a custom endpoint implies path style. */
    forcePathStyle: boolean;
  };
  worker: {
    baseUrl: string;
    triggerSecret: string;
    hmacSecret: string;
  };
  /** Where the Cloudflare Worker reaches this console. Must be public https. */
  publicBaseUrl: string;
  dialer: "cf-worker" | "fake";
  /** The same key the Worker holds; the console needs it only to delete recordings. */
  telnyxApiKey: string;
  openaiApiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment: ${detail}`);
  }

  const value = parsed.data;

  if (
    value.DIALER === "cf-worker" &&
    !value.PUBLIC_BASE_URL.startsWith("https://")
  ) {
    throw new Error(
      "invalid environment: PUBLIC_BASE_URL must be https when DIALER=cf-worker" +
        " - the Worker rejects http callback URLs",
    );
  }

  const endpoint = value.S3_ENDPOINT ?? null;

  return {
    databaseUrl: value.DATABASE_URL,
    port: value.PORT,
    sessionSecret: value.SESSION_SECRET,
    nodeEnv: value.NODE_ENV,
    s3: {
      endpoint,
      region: value.S3_REGION,
      bucket: value.S3_BUCKET,
      forcePathStyle: endpoint !== null,
    },
    worker: {
      baseUrl: value.WORKER_BASE_URL,
      triggerSecret: value.WORKER_TRIGGER_SECRET,
      hmacSecret: value.WORKER_HMAC_SECRET,
    },
    publicBaseUrl: value.PUBLIC_BASE_URL,
    dialer: value.DIALER,
    telnyxApiKey: value.TELNYX_API_KEY,
    openaiApiKey: value.OPENAI_API_KEY,
  };
}
