/**
 * LocalStorageBackend — writes to the filesystem under `UPLOAD_DIR`.
 *
 * Used for dev when you don't want to bring MinIO up, and as the
 * last-resort fallback if S3 is misconfigured (selected via the registry).
 * Returns null from `signedGetUrl` — local files don't have presigned URLs;
 * the receipts service falls back to building an authenticated API URL.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import type { PutInput, PutResult, StorageBackend } from "./types";

export class LocalStorageBackend implements StorageBackend {
  readonly name = "local" as const;

  private resolveOnDiskPath(key: string): string {
    // Guard against path traversal: the resolved path must stay inside
    // UPLOAD_DIR. A malicious key like "../../etc/passwd" would resolve
    // outside; we refuse.
    const base = path.resolve(env.UPLOAD_DIR);
    const target = path.resolve(base, key);
    if (!target.startsWith(`${base}${path.sep}`) && target !== base) {
      throw new Error(`Refusing key with path-traversal: ${key}`);
    }
    return target;
  }

  isConfigured(): boolean {
    return true; // disk is always reachable
  }

  async put(input: PutInput): Promise<PutResult> {
    const target = this.resolveOnDiskPath(input.key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, input.body);
    return { key: input.key, size: input.body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveOnDiskPath(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolveOnDiskPath(key));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // idempotent
      logger.warn({ err, key }, "Local backend: delete failed");
      throw err;
    }
  }

  async signedGetUrl(_key: string, _ttlSeconds: number): Promise<string | null> {
    // Local files don't have presigned URLs. The receipts route builds an
    // authenticated `/receipts/:id/image` URL instead.
    return null;
  }
}
