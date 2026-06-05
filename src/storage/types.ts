/**
 * Storage layer types.
 *
 * Mirrors the AI provider registry pattern: small interface, two concrete
 * backends (Local, S3), env-driven selection. Per-row backend tracking on
 * the Receipt model means receipts uploaded in the LOCAL era keep working
 * forever — no migration script needed when prod flips to S3.
 */

export type StorageBackendName = "local" | "s3";

export type PutInput = {
  /** Storage key. Backend-relative. e.g. `receipts/<userId>/<uuid>.png` */
  key: string;
  body: Buffer;
  mimeType: string;
};

export type PutResult = {
  /** The key the object lives under (may differ slightly from input if the backend rewrites). */
  key: string;
  /** Bytes written. */
  size: number;
};

export interface StorageBackend {
  readonly name: StorageBackendName;
  /** True when the backend has everything it needs (bucket configured, etc.). */
  isConfigured(): boolean;
  /** Write a blob. Idempotent — overwrites silently. */
  put(input: PutInput): Promise<PutResult>;
  /** Fetch the bytes back. */
  get(key: string): Promise<Buffer>;
  /** Delete the object. Idempotent — missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Build a URL the FE can use to fetch the object.
   *
   * - S3 backend → returns a presigned URL pointing directly at S3 (TTL=`ttlSeconds`)
   * - Local backend → returns null so the receipts service can fall back to
   *   building an authenticated API URL (`<PUBLIC_BASE_URL>/api/v1/receipts/:id/image`).
   *
   * Returning null keeps the contract honest: local files don't have a
   * "signed URL" concept — auth is the API layer's job.
   */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
}
