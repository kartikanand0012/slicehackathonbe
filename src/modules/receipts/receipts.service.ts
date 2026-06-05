import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageBackend as StorageBackendEnum } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { logger } from "@/lib/logger";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { sha256Hex } from "@/lib/sha256";
import { getReceiptExtractor } from "@/ai/registry";
import { env } from "@/config/env";
import {
  getStorageBackend,
  getStorageBackendByName,
  type StorageBackendName,
} from "@/storage";
import * as expensesService from "@/modules/expenses/expenses.service";
import { sanitizeExtractedReceipt } from "./receipts.sanitizer";
import type {
  ConvertReceiptBody,
  ListReceiptsQuery,
} from "./receipts.schemas";

const RECEIPT_PUBLIC_SELECT = {
  id: true,
  uploadedById: true,
  groupId: true,
  status: true,
  aiProvider: true,
  attemptCount: true,
  isDuplicate: true,
  duplicateOfId: true,
  errorReason: true,
  originalName: true,
  mimeType: true,
  fileSize: true,
  merchantName: true,
  occurredAt: true,
  subtotalPaise: true,
  taxPaise: true,
  tipPaise: true,
  totalPaise: true,
  hint: true,
  processingStartedAt: true,
  processingFinishedAt: true,
  storageBackend: true,
  imagePath: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      name: true,
      quantity: true,
      unitPaise: true,
      totalPaise: true,
      sortOrder: true,
      tags: true,
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

/**
 * Build the URL the FE should use to render the receipt image.
 *
 *   - S3-backed receipt → presigned GET URL (TTL = S3_PRESIGN_EXPIRY_SECONDS)
 *   - Local-backed receipt → authenticated API URL `/receipts/:id/image`
 *
 * Returning a URL (not bytes) keeps list/get responses cheap and lets the
 * FE pull images directly. We read the per-row `storageBackend` enum so
 * old LOCAL receipts keep working even after prod flips STORAGE_BACKEND=s3.
 */
async function buildImageUrl(receipt: {
  id: string;
  imagePath: string;
  storageBackend: StorageBackendEnum;
}): Promise<string> {
  const backendName = receipt.storageBackend.toLowerCase() as StorageBackendName;
  if (backendName === "s3") {
    try {
      const url = await getStorageBackendByName("s3").signedGetUrl(
        receipt.imagePath,
        env.S3_PRESIGN_EXPIRY_SECONDS,
      );
      if (url) return url;
    } catch (err) {
      logger.warn({ err, receiptId: receipt.id }, "Presign failed; falling back to API URL");
    }
  }
  return `${env.PUBLIC_BASE_URL}/api/v1/receipts/${receipt.id}/image`;
}

type ReceiptRow = {
  id: string;
  imagePath: string;
  storageBackend: StorageBackendEnum;
  [k: string]: unknown;
};

async function withImageUrl<T extends ReceiptRow>(r: T): Promise<T & { imageUrl: string }> {
  return { ...r, imageUrl: await buildImageUrl(r) };
}

async function withImageUrls<T extends ReceiptRow>(rows: T[]) {
  return Promise.all(rows.map((r) => withImageUrl(r)));
}

const MAX_EXTRACTION_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 2000, 5000];

/** Window inside which a hash match counts as a duplicate. */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Step 1 — synchronous: dedup-check, persist to the active storage backend,
 * return immediately with status PROCESSING. Caller polls `GET /receipts/:id`.
 *
 * Step 2 — background: `runExtraction(receiptId)` (kicked off via
 * setImmediate so the HTTP response can flush first).
 */
export async function uploadReceipt(input: {
  userId: string;
  groupId?: string;
  hint?: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
}): Promise<{
  receipt: Awaited<ReturnType<typeof readReceipt>>;
  wasDuplicate: boolean;
}> {
  if (!input.file.mimetype.startsWith("image/")) {
    throw new BadRequestError("Only image uploads are accepted");
  }

  const imageSha256 = sha256Hex(input.file.buffer);

  // Dedup: if the same user uploaded the same bytes recently, return that
  // existing receipt instead of re-running OCR (and re-writing to storage).
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await prisma.receipt.findFirst({
    where: {
      uploadedById: input.userId,
      imageSha256,
      createdAt: { gte: since },
      status: { in: ["PROCESSING", "COMPLETED"] },
      isDuplicate: false,
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    await prisma.auditEvent.create({
      data: {
        actorId: input.userId,
        groupId: input.groupId,
        action: "RECEIPT_DUPLICATE",
        entityId: existing.id,
      },
    });
    return {
      receipt: await readReceipt(existing.id),
      wasDuplicate: true,
    };
  }

  const backend = getStorageBackend();
  const ext = path.extname(input.file.originalname) || ".bin";
  const objectKey = `receipts/${input.userId}/${randomUUID()}${ext}`;
  await backend.put({
    key: objectKey,
    body: input.file.buffer,
    mimeType: input.file.mimetype,
  });

  const receipt = await prisma.receipt.create({
    data: {
      uploadedById: input.userId,
      groupId: input.groupId,
      imagePath: objectKey,
      storageBackend: backend.name === "s3" ? "S3" : "LOCAL",
      imageSha256,
      originalName: input.file.originalname,
      mimeType: input.file.mimetype,
      fileSize: input.file.size,
      hint: input.hint,
      status: "PENDING",
    },
    select: { id: true },
  });

  await prisma.auditEvent.create({
    data: {
      actorId: input.userId,
      groupId: input.groupId,
      action: "RECEIPT_UPLOADED",
      entityId: receipt.id,
    },
  });

  // Kick off extraction without blocking the HTTP response. The image buffer
  // is captured by closure so we don't re-read from disk.
  setImmediate(() => {
    runExtraction(receipt.id, input.file.buffer, input.file.mimetype, input.hint).catch(
      (err) => {
        logger.error({ err, receiptId: receipt.id }, "Background extraction threw");
      },
    );
  });

  return {
    receipt: await readReceipt(receipt.id),
    wasDuplicate: false,
  };
}

/**
 * Background OCR runner. Retries transient failures with exponential backoff;
 * persists a terminal FAILED status (with errorReason) on giving up.
 */
async function runExtraction(
  receiptId: string,
  imageBuffer: Buffer,
  mimeType: string,
  hint: string | undefined,
): Promise<void> {
  await prisma.receipt.update({
    where: { id: receiptId },
    data: { status: "PROCESSING", processingStartedAt: new Date() },
  });

  const extractor = getReceiptExtractor();

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const { extracted, raw } = await extractor.extract({
        imageBuffer,
        mimeType,
        hint,
      });
      const { receipt: safe, warnings } = sanitizeExtractedReceipt(extracted);
      if (warnings.length > 0) {
        logger.warn({ receiptId, warnings }, "Receipt sanitization warnings");
      }

      await prisma.$transaction(async (tx) => {
        await tx.receipt.update({
          where: { id: receiptId },
          data: {
            status: "COMPLETED",
            aiProvider: extractor.name,
            attemptCount: attempt,
            processingFinishedAt: new Date(),
            merchantName: safe.merchantName,
            occurredAt: safe.occurredAt ? new Date(safe.occurredAt) : undefined,
            subtotalPaise: safe.subtotalPaise,
            taxPaise: safe.taxPaise,
            tipPaise: safe.tipPaise,
            totalPaise: safe.totalPaise,
            rawResponse: raw as never,
          },
        });
        // Replace any items from previous failed attempts.
        await tx.receiptItem.deleteMany({ where: { receiptId } });
        if (safe.items.length > 0) {
          await tx.receiptItem.createMany({
            data: safe.items.map((it, i) => ({
              receiptId,
              name: it.name,
              quantity: it.quantity,
              unitPaise: it.unitPaise,
              totalPaise: it.totalPaise,
              sortOrder: i,
              tags: it.tags ?? [],
            })),
          });
        }
        await tx.auditEvent.create({
          data: {
            action: "RECEIPT_EXTRACTED",
            entityId: receiptId,
            metadata: {
              provider: extractor.name,
              attempt,
              warnings,
            },
          },
        });
      });
      return;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, receiptId, attempt },
        "Receipt extraction attempt failed",
      );
      await prisma.receipt.update({
        where: { id: receiptId },
        data: { attemptCount: attempt },
      });
      if (attempt < MAX_EXTRACTION_ATTEMPTS) {
        await prisma.auditEvent.create({
          data: {
            action: "RECEIPT_RETRIED",
            entityId: receiptId,
            metadata: { attempt, error: (err as Error).message.slice(0, 200) },
          },
        });
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 5000);
      }
    }
  }

  await prisma.receipt.update({
    where: { id: receiptId },
    data: {
      status: "FAILED",
      aiProvider: extractor.name,
      processingFinishedAt: new Date(),
      errorReason: lastError?.message.slice(0, 500) ?? "Unknown error",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function readReceipt(receiptId: string) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: RECEIPT_PUBLIC_SELECT,
  });
  if (!r) throw new NotFoundError("Receipt not found");
  return withImageUrl(r);
}

export async function getReceipt(userId: string, receiptId: string) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { ...RECEIPT_PUBLIC_SELECT, uploadedById: true },
  });
  if (!r) throw new NotFoundError("Receipt not found");
  if (r.uploadedById !== userId) throw new NotFoundError("Receipt not found");
  return withImageUrl(r);
}

export async function listReceipts(userId: string, query: ListReceiptsQuery) {
  const rows = await prisma.receipt.findMany({
    where: {
      uploadedById: userId,
      ...(query.groupId ? { groupId: query.groupId } : {}),
    },
    select: RECEIPT_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
  return { items: await withImageUrls(rows) };
}

/**
 * Stream the raw image bytes from the per-row storage backend. Auth check
 * happens in the route. For S3-backed receipts the FE skips this endpoint
 * and hits the presigned S3 URL directly.
 */
export async function getReceiptImageBuffer(
  userId: string,
  receiptId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { uploadedById: true, imagePath: true, mimeType: true, storageBackend: true },
  });
  if (!r || r.uploadedById !== userId) throw new NotFoundError("Receipt not found");
  const backendName = r.storageBackend.toLowerCase() as StorageBackendName;
  const buffer = await getStorageBackendByName(backendName).get(r.imagePath);
  return { buffer, mimeType: r.mimeType };
}

export async function convertReceiptToExpense(
  userId: string,
  receiptId: string,
  body: ConvertReceiptBody,
) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true,
      uploadedById: true,
      groupId: true,
      totalPaise: true,
      subtotalPaise: true,
      taxPaise: true,
      tipPaise: true,
      status: true,
      items: {
        select: { name: true, totalPaise: true, tags: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!r || r.uploadedById !== userId) {
    throw new NotFoundError("Receipt not found");
  }
  if (!r.groupId) {
    throw new BadRequestError(
      "Receipt is not attached to a group — set groupId at upload time first",
    );
  }
  if (r.status !== "COMPLETED" || !r.totalPaise) {
    throw new BadRequestError("Receipt has not been extracted yet");
  }

  let split;
  if (body.splitMode === "EQUAL") {
    split = { mode: "EQUAL" as const, userIds: body.userIds! };
  } else {
    // CONSTRAINT — wire the receipt's tagged items + tax/tip directly into
    // the split engine. The common portion is everything in the total that
    // isn't covered by item totals (typically tax + tip + service).
    if (r.items.length === 0) {
      throw new BadRequestError(
        "Cannot do CONSTRAINT split on a receipt with no extracted items — use EQUAL or re-extract",
      );
    }
    const itemSum = r.items.reduce((s, it) => s + it.totalPaise, 0);
    const commonItemsPaise = r.totalPaise - itemSum;
    if (commonItemsPaise < 0) {
      throw new BadRequestError(
        `Receipt is inconsistent: item sum (${itemSum}) exceeds total (${r.totalPaise})`,
      );
    }
    split = {
      mode: "CONSTRAINT" as const,
      items: r.items.map((it) => ({
        name: it.name,
        totalPaise: it.totalPaise,
        tags: it.tags ?? [],
      })),
      participants: body.participants!,
      commonItemsPaise,
    };
  }

  const expense = await expensesService.createExpense(userId, r.groupId, {
    title: body.title,
    amountPaise: r.totalPaise,
    paidById: body.paidById,
    split,
  });

  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      groupId: r.groupId,
      action: "RECEIPT_CONVERTED",
      entityId: r.id,
      metadata: { expenseId: expense.id, splitMode: body.splitMode },
    },
  });

  return expense;
}

// Re-exported for routes.
export const uploadAndExtract = uploadReceipt;
