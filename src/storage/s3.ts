/**
 * S3StorageBackend — wraps `@aws-sdk/client-s3` for both real AWS S3 and
 * any S3-compatible service (MinIO, R2, Wasabi, …). The endpoint + path-
 * style flag are env-configurable so the same code targets all of them.
 *
 * Standard AWS credential chain (env, profile, IRSA) applies; we don't
 * touch credential discovery here.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import type { PutInput, PutResult, StorageBackend } from "./types";

export class S3StorageBackend implements StorageBackend {
  readonly name = "s3" as const;

  private readonly client: S3Client | null;
  private readonly bucket: string | undefined;

  constructor() {
    this.bucket = env.S3_BUCKET;
    const region = env.S3_REGION ?? env.AWS_REGION;
    if (!this.bucket || !region) {
      this.client = null;
      return;
    }
    this.client = new S3Client({
      region,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }

  isConfigured(): boolean {
    return this.client !== null && Boolean(this.bucket);
  }

  async put(input: PutInput): Promise<PutResult> {
    this.assertReady();
    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.mimeType,
        ContentLength: input.body.byteLength,
      }),
    );
    return { key: input.key, size: input.body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    this.assertReady();
    const resp = await this.client!.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!resp.Body) throw new Error(`S3 GetObject returned no body for ${key}`);
    // The SDK returns a readable stream; collect to Buffer.
    return Buffer.from(await resp.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    this.assertReady();
    try {
      await this.client!.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      logger.warn({ err, key }, "S3 backend: delete failed");
      throw err;
    }
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    this.assertReady();
    return getSignedUrl(
      this.client!,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private assertReady(): void {
    if (!this.client || !this.bucket) {
      throw new Error(
        "S3StorageBackend not configured. Set STORAGE_BACKEND=s3, S3_BUCKET, and S3_REGION (or AWS_REGION).",
      );
    }
  }
}
