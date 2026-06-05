import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { prisma } from "@/db/prisma";
import { logger } from "@/lib/logger";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { getReceiptExtractor } from "@/ai/registry";
import type { ExtractedReceipt } from "@/ai/types";
import { env } from "@/config/env";
import * as expensesService from "@/modules/expenses/expenses.service";
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
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

async function ensureUploadDir(): Promise<string> {
  const dir = path.resolve(env.UPLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function sanitizeExtracted(raw: unknown): ExtractedReceipt {
  if (typeof raw !== "object" || raw === null) {
    throw new BadRequestError("AI provider returned malformed extraction");
  }
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    merchantName: typeof r.merchantName === "string" ? r.merchantName : null,
    occurredAt: typeof r.occurredAt === "string" ? r.occurredAt : null,
    currency: "INR",
    subtotalPaise:
      typeof r.subtotalPaise === "number" ? Math.round(r.subtotalPaise) : null,
    taxPaise: typeof r.taxPaise === "number" ? Math.round(r.taxPaise) : null,
    tipPaise: typeof r.tipPaise === "number" ? Math.round(r.tipPaise) : null,
    totalPaise:
      typeof r.totalPaise === "number" ? Math.round(r.totalPaise) : 0,
    items: items.map((it) => {
      const i = it as Record<string, unknown>;
      return {
        name: String(i.name ?? ""),
        quantity:
          typeof i.quantity === "number" ? Math.max(1, Math.round(i.quantity)) : 1,
        unitPaise:
          typeof i.unitPaise === "number" ? Math.round(i.unitPaise) : 0,
        totalPaise:
          typeof i.totalPaise === "number" ? Math.round(i.totalPaise) : 0,
      };
    }),
  };
}

export async function uploadAndExtract(input: {
  userId: string;
  groupId?: string;
  hint?: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
}) {
  if (!input.file.mimetype.startsWith("image/")) {
    throw new BadRequestError("Only image uploads are accepted");
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
      originalName: input.file.originalname,
      mimeType: input.file.mimetype,
      fileSize: input.file.size,
      status: "PROCESSING",
    },
    select: RECEIPT_PUBLIC_SELECT,
  });

  await prisma.auditEvent.create({
    data: {
      actorId: input.userId,
      groupId: input.groupId,
      action: "RECEIPT_UPLOADED",
      entityId: receipt.id,
    },
  });

  const extractor = getReceiptExtractor();
  try {
    const { extracted, raw } = await extractor.extract({
      imageBuffer: input.file.buffer,
      mimeType: input.file.mimetype,
      hint: input.hint,
    });
    const safe = sanitizeExtracted(extracted);

    await prisma.$transaction(async (tx) => {
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          status: "COMPLETED",
          aiProvider: extractor.name,
          merchantName: safe.merchantName,
          occurredAt: safe.occurredAt ? new Date(safe.occurredAt) : undefined,
          subtotalPaise: safe.subtotalPaise,
          taxPaise: safe.taxPaise,
          tipPaise: safe.tipPaise,
          totalPaise: safe.totalPaise,
          rawResponse: raw as never,
        },
      });
      if (safe.items.length > 0) {
        await tx.receiptItem.createMany({
          data: safe.items.map((it, i) => ({
            receiptId: receipt.id,
            name: it.name,
            quantity: it.quantity,
            unitPaise: it.unitPaise,
            totalPaise: it.totalPaise,
            sortOrder: i,
          })),
        });
      }
      await tx.auditEvent.create({
        data: {
          actorId: input.userId,
          groupId: input.groupId,
          action: "RECEIPT_EXTRACTED",
          entityId: receipt.id,
          metadata: { provider: extractor.name },
        },
      });
    });

    return prisma.receipt.findUniqueOrThrow({
      where: { id: receipt.id },
      select: RECEIPT_PUBLIC_SELECT,
    });
  } catch (err) {
    logger.error({ err, receiptId: receipt.id }, "Receipt extraction failed");
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        status: "FAILED",
        aiProvider: extractor.name,
        errorReason: (err as Error).message.slice(0, 500),
      },
    });
    throw err;
  }
}

export async function getReceipt(userId: string, receiptId: string) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { ...RECEIPT_PUBLIC_SELECT, uploadedById: true },
  });
  if (!r) throw new NotFoundError("Receipt not found");
  if (r.uploadedById !== userId) {
    throw new NotFoundError("Receipt not found"); // hide existence
  }
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
      "ITEM split is part of the guest-split flow; use EQUAL here or call /guest-splits",
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
