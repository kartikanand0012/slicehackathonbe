import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  getStorageBackend,
  getStorageBackendByName,
  resetStorageCache,
} from "./registry";

describe("storage registry", () => {
  const ORIGINAL = {
    STORAGE_BACKEND: process.env.STORAGE_BACKEND,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_REGION: process.env.S3_REGION,
    AWS_REGION: process.env.AWS_REGION,
  };

  beforeEach(() => {
    resetStorageCache();
    delete process.env.STORAGE_BACKEND;
    delete process.env.S3_BUCKET;
    delete process.env.S3_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
    resetStorageCache();
  });

  test("defaults to local when STORAGE_BACKEND is unset", () => {
    expect(getStorageBackend().name).toBe("local");
  });

  test("falls back to local when s3 requested but not configured", () => {
    process.env.STORAGE_BACKEND = "s3";
    // S3_BUCKET intentionally absent → S3StorageBackend.isConfigured() returns false.
    expect(getStorageBackend().name).toBe("local");
  });

  test("getStorageBackendByName respects per-row backend even after global cache", () => {
    const local = getStorageBackendByName("local");
    expect(local.name).toBe("local");
    // s3 backend is constructed but unconfigured — still reachable by name.
    const s3 = getStorageBackendByName("s3");
    expect(s3.name).toBe("s3");
  });
});
