import { prisma } from "@/db/prisma";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type {
  AddMemberBody,
  CreateGroupBody,
  ListGroupsQuery,
  UpdateGroupBody,
} from "./groups.schemas";

const GROUP_PUBLIC_SELECT = {
  id: true,
  name: true,
  emoji: true,
  description: true,
  simplifyDebts: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  members: {
    select: {
      id: true,
      role: true,
      joinedAt: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  },
} as const;

/**
 * Look up a group + assert the caller is a member. Returns the membership
 * row alongside so callers can check role without a second query.
 */
async function requireMembership(groupId: string, userId: string) {
  const membership = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { role: true, leftAt: true },
  });
  if (!membership || membership.leftAt) {
    throw new NotFoundError("Group not found");
  }
  return membership;
}

function requireAdmin(role: "OWNER" | "ADMIN" | "MEMBER") {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new ForbiddenError("Admin or owner role required");
  }
}

export async function listGroups(userId: string, query: ListGroupsQuery) {
  const archivedFilter =
    query.archived === "true"
      ? { not: null }
      : query.archived === "false"
        ? null
        : undefined;

  const groups = await prisma.group.findMany({
    where: {
      ...(archivedFilter !== undefined ? { archivedAt: archivedFilter } : {}),
      members: { some: { userId, leftAt: null } },
    },
    select: GROUP_PUBLIC_SELECT,
    orderBy: { updatedAt: "desc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = groups.length > query.limit;
  const items = hasMore ? groups.slice(0, query.limit) : groups;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  };
}

export async function createGroup(userId: string, input: CreateGroupBody) {
  const memberIds = Array.from(new Set([userId, ...(input.memberIds ?? [])]));

  // Validate that every supplied memberId is a real user — fail loudly rather
  // than silently dropping bad ids.
  if (memberIds.length > 1) {
    const found = await prisma.user.count({ where: { id: { in: memberIds } } });
    if (found !== memberIds.length) {
      throw new NotFoundError("One or more memberIds reference unknown users");
    }
  }

  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.group.create({
      data: {
        name: input.name,
        emoji: input.emoji,
        description: input.description,
        simplifyDebts: input.simplifyDebts ?? true,
        members: {
          create: memberIds.map((mid) => ({
            userId: mid,
            role: mid === userId ? "OWNER" : "MEMBER",
          })),
        },
      },
      select: GROUP_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: { actorId: userId, groupId: g.id, action: "GROUP_CREATED" },
    });
    return g;
  });

  return group;
}

export async function getGroup(userId: string, groupId: string) {
  await requireMembership(groupId, userId);
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: GROUP_PUBLIC_SELECT,
  });
  if (!group) throw new NotFoundError("Group not found");
  return group;
}

export async function updateGroup(
  userId: string,
  groupId: string,
  input: UpdateGroupBody,
) {
  const membership = await requireMembership(groupId, userId);
  requireAdmin(membership.role);

  const { archived, ...rest } = input;
  const data: Record<string, unknown> = { ...rest };
  if (archived === true) data.archivedAt = new Date();
  if (archived === false) data.archivedAt = null;

  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.group.update({
      where: { id: groupId },
      data,
      select: GROUP_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: archived === true ? "GROUP_ARCHIVED" : "GROUP_UPDATED",
      },
    });
    return g;
  });

  return group;
}

export async function addMember(
  userId: string,
  groupId: string,
  input: AddMemberBody,
) {
  const membership = await requireMembership(groupId, userId);
  requireAdmin(membership.role);

  await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { id: true },
  });

  const existing = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId: input.userId, groupId } },
  });

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.groupMember.update({
        where: { id: existing.id },
        data: { role: input.role ?? "MEMBER", leftAt: null },
      });
    } else {
      await tx.groupMember.create({
        data: { userId: input.userId, groupId, role: input.role ?? "MEMBER" },
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "MEMBER_ADDED",
        entityId: input.userId,
      },
    });
  });

  return getGroup(userId, groupId);
}

export async function removeMember(
  userId: string,
  groupId: string,
  targetUserId: string,
) {
  const membership = await requireMembership(groupId, userId);
  // Self-leave is allowed; otherwise require admin.
  if (targetUserId !== userId) requireAdmin(membership.role);

  const target = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId: targetUserId, groupId } },
    select: { id: true, role: true },
  });
  if (!target) throw new NotFoundError("Member not in group");
  if (target.role === "OWNER") {
    throw new ForbiddenError("The owner cannot be removed from the group");
  }

  await prisma.$transaction(async (tx) => {
    await tx.groupMember.update({
      where: { id: target.id },
      data: { leftAt: new Date() },
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId,
        action: "MEMBER_REMOVED",
        entityId: targetUserId,
      },
    });
  });
}
