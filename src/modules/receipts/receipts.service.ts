import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { prisma } from "@/db/prisma";
import { logger } from "@/lib/logger";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { sha256Hex } from "@/lib/sha256";
import { getReceiptExtractor } from "@/ai/registry";
import { env } from "@/config/env";
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

const MAX_EXTRACTION_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 2000, 5000];

/** Window inside which a hash match counts as a duplicate. */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

async function ensureUploadDir(): Promise<string> {
  const dir = path.resolve(env.UPLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Step 1 — synchronous: dedup-check, persist the upload, return immediately
 * with status PROCESSING. Caller polls `GET /receipts/:id`.
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
  // existing receipt instead of re-running OCR.
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

  const dir = await ensureUploadDir();
  const ext = path.extname(input.file.originalname) || ".bin";
  const stored = `${randomUUID()}${ext}`;
  const imagePath = path.join(dir, stored);
  await fs.writeFile(imagePath, input.file.buffer);

  const receipt = await prisma.receipt.create({
    data: {
      uploadedById: input.userId,
      groupId: input.groupId,
      imagePath,
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
  return r;
}

export async function getReceipt(userId: string, receiptId: string) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { ...RECEIPT_PUBLIC_SELECT, uploadedById: true },
  });
  if (!r) throw new NotFoundError("Receipt not found");
  if (r.uploadedById !== userId) throw new NotFoundError("Receipt not found");
  return r;
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
  return { items: rows };
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
      status: true,
      items: true,
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
  if (body.splitMode === "ITEM") {
    throw new BadRequestError(
      "ITEM split is part of the guest-split flow; use EQUAL or call /commands for CONSTRAINT",
    );
  }

  const expense = await expensesService.createExpense(userId, r.groupId, {
    title: body.title,
    amountPaise: r.totalPaise,
    paidById: body.paidById,
    split: { mode: "EQUAL", userIds: body.userIds! },
  });

  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      groupId: r.groupId,
      action: "RECEIPT_CONVERTED",
      entityId: r.id,
      metadata: { expenseId: expense.id },
    },
  });

  return expense;
}

// Re-exported for routes.
export const uploadAndExtract = uploadReceipt;
