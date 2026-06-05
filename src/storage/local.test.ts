import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalStorageBackend } from "./local";

describe("LocalStorageBackend", () => {
  const ORIGINAL_UPLOAD_DIR = process.env.UPLOAD_DIR;
  let tmpDir: string;
  let backend: LocalStorageBackend;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "slicesplit-storage-"));
    process.env.UPLOAD_DIR = tmpDir;
    // Lazy-load AFTER env mutation so the backend reads the right path.
    const mod = await import("./local");
    backend = new mod.LocalStorageBackend();
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_UPLOAD_DIR === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = ORIGINAL_UPLOAD_DIR;
  });

  test("put → get round-trips bytes", async () => {
    const body = Buffer.from("hello world", "utf8");
    const { key, size } = await backend.put({
      key: "receipts/test1.txt",
      body,
      mimeType: "text/plain",
    });
    expect(key).toBe("receipts/test1.txt");
    expect(size).toBe(body.byteLength);

    const got = await backend.get(key);
    expect(got.equals(body)).toBe(true);
  });

  test("put creates nested directories", async () => {
    const body = Buffer.from("nested");
    await backend.put({
      key: "a/b/c/deep.txt",
      body,
      mimeType: "text/plain",
    });
    expect((await backend.get("a/b/c/deep.txt")).toString()).toBe("nested");
  });

  test("delete is idempotent (missing key is not an error)", async () => {
    await expect(backend.delete("does/not/exist.png")).resolves.toBeUndefined();
  });

  test("path traversal is refused", async () => {
    await expect(
      backend.put({
        key: "../../../etc/passwd",
        body: Buffer.from("nope"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow(/path-traversal/);
  });

  test("signedGetUrl returns null (local has no presign concept)", async () => {
    expect(await backend.signedGetUrl("anything", 60)).toBeNull();
  });
});
