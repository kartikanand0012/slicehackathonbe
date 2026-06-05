import { prisma } from "@/db/prisma";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { calculateShares, type SplitInput } from "@/lib/split-calculator";
import type {
  CreateExpenseBody,
  ListExpensesQuery,
  UpdateExpenseBody,
} from "./expenses.schemas";

const EXPENSE_PUBLIC_SELECT = {
  id: true,
  title: true,
  notes: true,
  amountPaise: true,
  category: true,
  occurredAt: true,
  splitMode: true,
  paidById: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  shares: {
    select: {
      id: true,
      userId: true,
      amountPaise: true,
      shares: true,
      basisPoints: true,
    },
  },
} as const;

async function requireGroupMember(
  groupId: string,
  userId: string,
): Promise<void> {
  const member = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { leftAt: true },
  });
  if (!member || member.leftAt) throw new NotFoundError("Group not found");
}

async function activeMemberIds(groupId: string): Promise<Set<string>> {
  const rows = await prisma.groupMember.findMany({
    where: { groupId, leftAt: null },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

function toSplitInput(
  body: CreateExpenseBody | (UpdateExpenseBody & { split: CreateExpenseBody["split"] }),
  totalPaise: number,
): SplitInput {
  const s = body.split;
  if (s.mode === "EQUAL") return { mode: "EQUAL", totalPaise, userIds: s.userIds };
  if (s.mode === "EXACT") return { mode: "EXACT", totalPaise, shares: s.shares };
  if (s.mode === "PERCENTAGE")
    return { mode: "PERCENTAGE", totalPaise, shares: s.shares };
  if (s.mode === "SHARES") return { mode: "SHARES", totalPaise, shares: s.shares };
  // CONSTRAINT
  return {
    mode: "CONSTRAINT",
    totalPaise,
    items: s.items.map((it) => ({
      name: it.name,
      totalPaise: it.totalPaise,
      tags: it.tags ?? [],
    })),
    participants: s.participants,
    commonItemsPaise: s.commonItemsPaise,
  };
}

function shareUserIds(split: CreateExpenseBody["split"]): string[] {
  if (split.mode === "EQUAL") return split.userIds;
  if (split.mode === "CONSTRAINT") return split.participants.map((p) => p.userId);
  return split.shares.map((s) => s.userId);
}

export async function listExpenses(
  userId: string,
  groupId: string,
  query: ListExpensesQuery,
) {
  await requireGroupMember(groupId, userId);
  const expenses = await prisma.expense.findMany({
    where: { groupId, deletedAt: null },
    select: EXPENSE_PUBLIC_SELECT,
    orderBy: { occurredAt: "desc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = expenses.length > query.limit;
  const items = hasMore ? expenses.slice(0, query.limit) : expenses;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  };
}

export async function getExpense(
  userId: string,
  groupId: string,
  expenseId: string,
) {
  await requireGroupMember(groupId, userId);
  const exp = await prisma.expense.findFirst({
    where: { id: expenseId, groupId, deletedAt: null },
    select: EXPENSE_PUBLIC_SELECT,
  });
  if (!exp) throw new NotFoundError("Expense not found");
  return exp;
}

export async function createExpense(
  userId: string,
  groupId: string,
  body: CreateExpenseBody,
) {
  await requireGroupMember(groupId, userId);

  const members = await activeMemberIds(groupId);
  const participants = new Set([body.paidById, ...shareUserIds(body.split)]);
  for (const id of participants) {
    if (!members.has(id)) {
      throw new BadRequestError(
        `User ${id} is not an active member of this group`,
      );
    }
  }

  const drafts = calculateShares(toSplitInput(body, body.amountPaise));

  const expense = await prisma.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: {
        groupId,
        title: body.title,
        notes: body.notes,
        amountPaise: body.amountPaise,
        category: body.category,
        occurredAt: body.occurredAt ?? new Date(),
        splitMode: body.split.mode,
        paidById: body.paidById,
        createdById: userId,
        shares: {
          create: drafts.map((d) => ({
            userId: d.userId,
            amountPaise: d.amountPaise,
            shares: d.shares,
            basisPoints: d.basisPoints,
          })),
        },
      },
      select: EXPENSE_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "EXPENSE_CREATED",
        entityId: created.id,
        metadata: { amountPaise: body.amountPaise, splitMode: body.split.mode },
      },
    });
    return created;
  });

  return expense;
}

export async function updateExpense(
  userId: string,
  groupId: string,
  expenseId: string,
  body: UpdateExpenseBody,
) {
  await requireGroupMember(groupId, userId);

  const existing = await prisma.expense.findFirst({
    where: { id: expenseId, groupId, deletedAt: null },
    select: { id: true, amountPaise: true, splitMode: true },
  });
  if (!existing) throw new NotFoundError("Expense not found");

  const newTotal = body.amountPaise ?? existing.amountPaise;
  let drafts = null as ReturnType<typeof calculateShares> | null;

  if (body.split) {
    const members = await activeMemberIds(groupId);
    const participants = new Set<string>([
      body.paidById ?? "",
      ...shareUserIds(body.split),
    ]);
    participants.delete("");
    for (const id of participants) {
      if (!members.has(id)) {
        throw new BadRequestError(
          `User ${id} is not an active member of this group`,
        );
      }
    }
    drafts = calculateShares(
      toSplitInput(body as CreateExpenseBody, newTotal),
    );
  } else if (body.amountPaise && body.amountPaise !== existing.amountPaise) {
    throw new BadRequestError(
      "Cannot change amountPaise without re-providing a split",
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const exp = await tx.expense.update({
      where: { id: expenseId },
      data: {
        title: body.title,
        notes: body.notes,
        amountPaise: body.amountPaise,
        category: body.category,
        occurredAt: body.occurredAt,
        paidById: body.paidById,
        ...(body.split ? { splitMode: body.split.mode } : {}),
      },
    });
    if (drafts) {
      await tx.expenseShare.deleteMany({ where: { expenseId } });
      await tx.expenseShare.createMany({
        data: drafts.map((d) => ({
          expenseId,
          userId: d.userId,
          amountPaise: d.amountPaise,
          shares: d.shares,
          basisPoints: d.basisPoints,
        })),
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "EXPENSE_UPDATED",
        entityId: exp.id,
      },
    });
    return tx.expense.findUniqueOrThrow({
      where: { id: exp.id },
      select: EXPENSE_PUBLIC_SELECT,
    });
  });

  return updated;
}

export async function deleteExpense(
  userId: string,
  groupId: string,
  expenseId: string,
) {
  await requireGroupMember(groupId, userId);

  const exp = await prisma.expense.findFirst({
    where: { id: expenseId, groupId, deletedAt: null },
    select: { createdById: true, paidById: true },
  });
  if (!exp) throw new NotFoundError("Expense not found");

  // Only the creator, payer, or a group admin may delete.
  if (exp.createdById !== userId && exp.paidById !== userId) {
    const membership = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { role: true },
    });
    if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
      throw new ForbiddenError("Only the creator, payer, or a group admin can delete");
    }
  }

  await prisma.$transaction([
    prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    }),
    prisma.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "EXPENSE_DELETED",
        entityId: expenseId,
      },
    }),
  ]);
}
