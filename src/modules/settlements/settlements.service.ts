import { prisma } from "@/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import type {
  CreateSettlementBody,
  ListSettlementsQuery,
} from "./settlements.schemas";

const SETTLEMENT_PUBLIC_SELECT = {
  id: true,
  fromId: true,
  toId: true,
  amountPaise: true,
  method: true,
  note: true,
  settledAt: true,
  createdAt: true,
  from: { select: { id: true, name: true, upiHandle: true } },
  to: { select: { id: true, name: true, upiHandle: true } },
} as const;

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

export async function listSettlements(
  userId: string,
  groupId: string,
  query: ListSettlementsQuery,
) {
  await requireGroupMember(groupId, userId);
  const rows = await prisma.settlement.findMany({
    where: { groupId },
    select: SETTLEMENT_PUBLIC_SELECT,
    orderBy: { settledAt: "desc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  };
}

export async function createSettlement(
  userId: string,
  groupId: string,
  body: CreateSettlementBody,
) {
  await requireGroupMember(groupId, userId);

  const memberIds = (
    await prisma.groupMember.findMany({
      where: { groupId, leftAt: null, userId: { in: [body.fromId, body.toId] } },
      select: { userId: true },
    })
  ).map((m) => m.userId);
  if (memberIds.length !== 2) {
    throw new BadRequestError("Both fromId and toId must be active group members");
  }

  const settlement = await prisma.$transaction(async (tx) => {
    const created = await tx.settlement.create({
      data: {
        groupId,
        fromId: body.fromId,
        toId: body.toId,
        amountPaise: body.amountPaise,
        method: body.method,
        note: body.note,
        settledAt: body.settledAt ?? new Date(),
      },
      select: SETTLEMENT_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "SETTLEMENT_CREATED",
        entityId: created.id,
        metadata: { amountPaise: body.amountPaise },
      },
    });
    return created;
  });

  return settlement;
}
