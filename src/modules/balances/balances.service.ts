import { prisma } from "@/db/prisma";
import { NotFoundError } from "@/lib/errors";
import {
  computeBalances,
  simplifyDebts,
  type MemberBalance,
  type SimplifiedTransfer,
} from "@/lib/balance-engine";
import { buildUpiIntent, isValidVpa } from "@/lib/upi";

type MemberSummary = MemberBalance & {
  name: string;
  email: string;
  upiHandle: string | null;
};

type TransferWithLink = SimplifiedTransfer & {
  from: { id: string; name: string };
  to: { id: string; name: string; upiHandle: string | null };
  upiIntent: string | null;
};

async function requireGroupMember(
  groupId: string,
  userId: string,
): Promise<void> {
  const m = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { leftAt: true },
  });
  if (!m || m.leftAt) throw new NotFoundError("Group not found");
}

export async function getGroupBalances(
  userId: string,
  groupId: string,
): Promise<{
  balances: MemberSummary[];
  transfers: TransferWithLink[];
}> {
  await requireGroupMember(groupId, userId);

  // Pull everything we need in three queries.
  const [members, expensesWithShares, settlements] = await Promise.all([
    prisma.groupMember.findMany({
      where: { groupId, leftAt: null },
      select: {
        user: {
          select: { id: true, name: true, email: true, upiHandle: true },
        },
      },
    }),
    prisma.expense.findMany({
      where: { groupId, deletedAt: null },
      select: {
        paidById: true,
        shares: { select: { userId: true, amountPaise: true } },
      },
    }),
    prisma.settlement.findMany({
      where: { groupId },
      select: { fromId: true, toId: true, amountPaise: true },
    }),
  ]);

  const memberIndex = new Map(members.map((m) => [m.user.id, m.user]));

  const raw = computeBalances(
    expensesWithShares.map((e) => ({
      paidById: e.paidById,
      shares: e.shares,
    })),
    settlements.map((s) => ({
      fromId: s.fromId,
      toId: s.toId,
      amountPaise: s.amountPaise,
    })),
  );

  const balances: MemberSummary[] = raw
    .filter((b) => memberIndex.has(b.userId))
    .map((b) => {
      const u = memberIndex.get(b.userId)!;
      return {
        ...b,
        name: u.name,
        email: u.email,
        upiHandle: u.upiHandle,
      };
    });

  const rawTransfers = simplifyDebts(raw);
  const transfers: TransferWithLink[] = rawTransfers.map((t) => {
    const from = memberIndex.get(t.fromUserId);
    const to = memberIndex.get(t.toUserId);
    const upiIntent =
      to?.upiHandle && isValidVpa(to.upiHandle)
        ? buildUpiIntent({
            payeeVpa: to.upiHandle,
            payeeName: to.name,
            amountPaise: t.amountPaise,
            note: `SliceSplit settle-up`,
          })
        : null;
    return {
      ...t,
      from: { id: t.fromUserId, name: from?.name ?? "Unknown" },
      to: {
        id: t.toUserId,
        name: to?.name ?? "Unknown",
        upiHandle: to?.upiHandle ?? null,
      },
      upiIntent,
    };
  });

  return { balances, transfers };
}
