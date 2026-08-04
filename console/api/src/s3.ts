import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";

export type { S3Client };

/**
 * In production no credentials are configured here at all - the SDK picks up
 * the EC2 instance role. Locally, S3_ENDPOINT points at MinIO and the
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY variables in .env are used.
 */
export function createS3(config: Config): S3Client {
  return new S3Client({
    region: config.s3.region,
    ...(config.s3.endpoint !== null
      ? {
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
        }
      : {}),
  });
}

export async function putObject(
  s3: S3Client,
  config: Config,
  args: { key: string; body: Buffer; contentType: string },
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
}

export async function getObject(
  s3: S3Client,
  config: Config,
  key: string,
): Promise<Buffer> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`object ${key} has no body`);
  return Buffer.from(await result.Body.transformToByteArray());
}

export function presignGet(
  s3: S3Client,
  config: Config,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
