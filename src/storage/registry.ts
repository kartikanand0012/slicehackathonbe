/**
 * Storage backend registry. Same pattern as `src/ai/registry.ts`.
 *
 * Selection:
 *   1. `STORAGE_BACKEND` env (`local` | `s3`) picks the preferred backend.
 *   2. If the preferred backend isn't configured (e.g. `s3` with no
 *      bucket env vars), we fall back to `local` so receipts never lose
 *      the ability to be saved.
 *
 * Per-row `Receipt.storageBackend` carries which backend each receipt was
 * written under. That value is what drives reads and presign-url builds —
 * never `getStorageBackend()` directly — so old receipts keep working
 * after a config flip.
 */

import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { LocalStorageBackend } from "./local";
import { S3StorageBackend } from "./s3";
import type { StorageBackend, StorageBackendName } from "./types";

const ALL: Record<StorageBackendName, () => StorageBackend> = {
  local: () => new LocalStorageBackend(),
  s3: () => new S3StorageBackend(),
};

let writeCache: StorageBackend | null = null;
const readCache = new Map<StorageBackendName, StorageBackend>();

/** Backend used for NEW writes. Honours STORAGE_BACKEND with a local fallback. */
export function getStorageBackend(): StorageBackend {
  if (writeCache) return writeCache;
  const preferred = env.STORAGE_BACKEND;
  const candidate = ALL[preferred]();
  if (candidate.isConfigured()) {
    logger.info({ backend: candidate.name }, "Storage backend selected for writes");
    writeCache = candidate;
    return candidate;
  }
  logger.warn(
    { preferred, fallback: "local" },
    "Preferred storage backend not configured — falling back to LOCAL",
  );
  writeCache = new LocalStorageBackend();
  return writeCache;
}

/** Backend for READS — looked up by the per-row enum from the DB. */
export function getStorageBackendByName(name: StorageBackendName): StorageBackend {
  let inst = readCache.get(name);
  if (!inst) {
    inst = ALL[name]();
    readCache.set(name, inst);
  }
  return inst;
}

/** Test hook. */
export function resetStorageCache(): void {
  writeCache = null;
  readCache.clear();
}
