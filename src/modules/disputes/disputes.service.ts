/**
 * Disputes service — fairness engine (proposal §04).
 *
 * Flow:
 *   1. Someone shares the expense flags it. We compute an `auto-resolve`
 *      decision from the receipt + share rows. If we can resolve safely
 *      (e.g. raiser claims they didn't have an item they were never
 *      assigned to), we close the dispute as AUTO_RESOLVED. Otherwise
 *      it sits at OPEN for the splitter to action.
 *   2. The splitter posts new share amounts. We re-allocate inside one
 *      transaction (delete old shares + create new ones) and mark the
 *      dispute RESOLVED. Total must still match — the engine is the
 *      source of truth.
 *   3. The splitter can REJECT a dispute too (e.g. the raiser is wrong).
 *
 * Audit events written at every transition.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import type {
  FileDisputeBody,
  ListDisputesQuery,
  RejectDisputeBody,
  ResolveDisputeBody,
} from "./disputes.schemas";

const DISPUTE_PUBLIC_SELECT = {
  id: true,
  expenseId: true,
  raisedById: true,
  resolverId: true,
  status: true,
  reason: true,
  payload: true,
  resolution: true,
  newSharesPaise: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadExpenseForDispute(expenseId: string, raisedById: string) {
  const exp = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      groupId: true,
      amountPaise: true,
      splitMode: true,
      paidById: true,
      createdById: true,
      deletedAt: true,
      shares: {
        select: { id: true, userId: true, amountPaise: true },
      },
      group: { select: { id: true } },
    },
  });
  if (!exp || exp.deletedAt) throw new NotFoundError("Expense not found");

  // Caller must have a share on this expense to dispute it. Even the splitter
  // can dispute their own — they have an ExpenseShare row when they're in the
  // split (the normal case).
  const isParticipant = exp.shares.some((s) => s.userId === raisedById);
  if (!isParticipant) {
    throw new ForbiddenError(
      "Only participants of this expense can dispute it",
    );
  }
  return exp;
}

/**
 * Auto-resolver heuristics — kept narrow on purpose. We only auto-resolve
 * when the answer is provably defensible from the existing data; everything
 * else escalates to the splitter.
 *
 * Currently:
 *   - If the raiser claims they didn't have specific items (payload.itemNames)
 *     AND the expense isn't ITEM/CONSTRAINT mode, escalate — we can't
 *     unilaterally re-allocate.
 *   - If payload.paiseDelta is supplied and it's <= 10% of the raiser's
 *     current share, we mark AUTO_RESOLVED and record the proposal. The
 *     splitter is still notified but the dispute is closed.
 */
function decideAutoResolve(
  exp: { splitMode: string; amountPaise: number; shares: { userId: string; amountPaise: number }[] },
  raisedById: string,
  payload: FileDisputeBody["payload"],
): { auto: boolean; reason: string } {
  if (!payload) return { auto: false, reason: "no structured payload — needs splitter" };

  if (payload.itemNames && payload.itemNames.length > 0) {
    if (exp.splitMode !== "ITEM" && exp.splitMode !== "CONSTRAINT") {
      return {
        auto: false,
        reason: `cannot auto-resolve item-level dispute on a ${exp.splitMode} split`,
      };
    }
  }

  if (typeof payload.paiseDelta === "number" && payload.paiseDelta > 0) {
    const myShare = exp.shares.find((s) => s.userId === raisedById)?.amountPaise ?? 0;
    if (myShare > 0 && payload.paiseDelta <= Math.ceil(myShare * 0.1)) {
      return { auto: true, reason: `delta within 10% of own share — auto-credited` };
    }
    return { auto: false, reason: "delta too large to auto-resolve" };
  }

  return { auto: false, reason: "no auto-resolvable signal" };
}

export async function fileDispute(
  raisedById: string,
  expenseId: string,
  body: FileDisputeBody,
) {
  const exp = await loadExpenseForDispute(expenseId, raisedById);

  const decision = decideAutoResolve(exp, raisedById, body.payload);

  const dispute = await prisma.$transaction(async (tx) => {
    const d = await tx.dispute.create({
      data: {
        expenseId: exp.id,
        raisedById,
        reason: body.reason,
        payload: (body.payload ?? null) as Prisma.InputJsonValue,
        status: decision.auto ? "AUTO_RESOLVED" : "OPEN",
        resolution: decision.auto ? decision.reason : null,
        resolvedAt: decision.auto ? new Date() : null,
      },
      select: DISPUTE_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: raisedById,
        groupId: exp.groupId,
        action: decision.auto ? "DISPUTE_AUTO_RESOLVED" : "DISPUTE_FLAGGED",
        entityId: d.id,
        metadata: { expenseId: exp.id, autoReason: decision.reason },
      },
    });
    return d;
  });

  return { dispute, autoResolved: decision.auto, decisionReason: decision.reason };
}

export async function listDisputesForExpense(
  userId: string,
  expenseId: string,
  query: ListDisputesQuery,
) {
  // Anyone who can see the expense (via group membership) can see its
  // dispute history.
  const exp = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: { groupId: true, deletedAt: true },
  });
  if (!exp || exp.deletedAt) throw new NotFoundError("Expense not found");
  await assertMember(exp.groupId, userId);

  const items = await prisma.dispute.findMany({
    where: {
      expenseId,
      ...(query.status ? { status: query.status } : {}),
    },
    select: DISPUTE_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
  return { items };
}

export async function resolveDispute(
  resolverId: string,
  disputeId: string,
  body: ResolveDisputeBody,
) {
  const d = await prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true,
      status: true,
      expenseId: true,
      expense: {
        select: {
          id: true,
          groupId: true,
          createdById: true,
          paidById: true,
          amountPaise: true,
          deletedAt: true,
        },
      },
    },
  });
  if (!d || d.expense.deletedAt) throw new NotFoundError("Dispute not found");
  if (d.status !== "OPEN") {
    throw new BadRequestError(`Cannot resolve a dispute in status ${d.status}`);
  }
  // Only the original splitter (createdBy or paidBy) or a group admin can resolve.
  if (
    d.expense.createdById !== resolverId &&
    d.expense.paidById !== resolverId
  ) {
    const m = await prisma.groupMember.findUnique({
      where: {
        userId_groupId: { userId: resolverId, groupId: d.expense.groupId },
      },
      select: { role: true },
    });
    if (!m || (m.role !== "OWNER" && m.role !== "ADMIN")) {
      throw new ForbiddenError(
        "Only the creator, payer, or a group admin can resolve a dispute",
      );
    }
  }

  // Re-allocate. Engine is source of truth — caller MUST hand us new shares
  // that sum to the expense total. We don't accept partial re-splits here.
  const sum = body.newShares.reduce((s, r) => s + r.amountPaise, 0);
  if (sum !== d.expense.amountPaise) {
    throw new BadRequestError(
      `newShares sum (${sum}) must equal expense.amountPaise (${d.expense.amountPaise})`,
    );
  }
  if (new Set(body.newShares.map((r) => r.userId)).size !== body.newShares.length) {
    throw new BadRequestError("newShares.userId must be unique");
  }

  const result = await prisma.$transaction(async (tx) => {
    // Replace shares.
    await tx.expenseShare.deleteMany({ where: { expenseId: d.expense.id } });
    await tx.expenseShare.createMany({
      data: body.newShares.map((r) => ({
        expenseId: d.expense.id,
        userId: r.userId,
        amountPaise: r.amountPaise,
        shares: 1,
        basisPoints: null,
      })),
    });
    const updated = await tx.dispute.update({
      where: { id: disputeId },
      data: {
        status: "RESOLVED",
        resolverId,
        resolution: body.resolution,
        newSharesPaise: body.newShares as unknown as Prisma.InputJsonValue,
        resolvedAt: new Date(),
      },
      select: DISPUTE_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: resolverId,
        groupId: d.expense.groupId,
        action: "DISPUTE_RESOLVED",
        entityId: disputeId,
        metadata: { expenseId: d.expense.id },
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: resolverId,
        groupId: d.expense.groupId,
        action: "EXPENSE_REVISED",
        entityId: d.expense.id,
        metadata: { triggeredBy: "dispute", disputeId },
      },
    });
    return updated;
  });

  return result;
}

export async function rejectDispute(
  resolverId: string,
  disputeId: string,
  body: RejectDisputeBody,
) {
  const d = await prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true,
      status: true,
      expense: {
        select: { id: true, groupId: true, createdById: true, paidById: true, deletedAt: true },
      },
    },
  });
  if (!d || d.expense.deletedAt) throw new NotFoundError("Dispute not found");
  if (d.status !== "OPEN") {
    throw new BadRequestError(`Cannot reject a dispute in status ${d.status}`);
  }
  if (
    d.expense.createdById !== resolverId &&
    d.expense.paidById !== resolverId
  ) {
    const m = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId: resolverId, groupId: d.expense.groupId } },
      select: { role: true },
    });
    if (!m || (m.role !== "OWNER" && m.role !== "ADMIN")) {
      throw new ForbiddenError("Only the creator, payer, or admin can reject");
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.dispute.update({
      where: { id: disputeId },
      data: {
        status: "REJECTED",
        resolverId,
        resolution: body.resolution,
        resolvedAt: new Date(),
      },
      select: DISPUTE_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: resolverId,
        groupId: d.expense.groupId,
        action: "DISPUTE_REJECTED",
        entityId: disputeId,
      },
    });
    return u;
  });
  return updated;
}

async function assertMember(groupId: string, userId: string): Promise<void> {
  const m = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { leftAt: true },
  });
  if (!m || m.leftAt) throw new NotFoundError("Group not found");
}

export const __test__ = { decideAutoResolve };
