import { prisma } from "@/db/prisma";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
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
      contact: {
        select: { id: true, displayName: true, phone: true, email: true, linkedUserId: true },
      },
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
  // Normalise both input shapes (legacy `memberIds` and new `members`) to
  // a single de-duped list of refs. The creator is always added as OWNER.
  const refs: { userId?: string; contactId?: string }[] = [
    { userId },
    ...(input.memberIds ?? []).map((id) => ({ userId: id })),
    ...(input.members ?? []),
  ];

  const userIds = new Set<string>();
  const contactIds = new Set<string>();
  for (const r of refs) {
    if (r.userId) userIds.add(r.userId);
    else if (r.contactId) contactIds.add(r.contactId);
  }

  // Validate every referenced user + contact exists. Contacts must also
  // belong to the caller — you can't add someone else's address-book
  // entry to a group.
  if (userIds.size > 0) {
    const found = await prisma.user.count({
      where: { id: { in: [...userIds] } },
    });
    if (found !== userIds.size) {
      throw new NotFoundError("One or more userIds reference unknown users");
    }
  }
  if (contactIds.size > 0) {
    const owned = await prisma.contact.count({
      where: { id: { in: [...contactIds] }, ownerId: userId },
    });
    if (owned !== contactIds.size) {
      throw new BadRequestError(
        "One or more contactIds reference contacts that don't belong to you",
      );
    }
  }

  const group = await prisma.$transaction(async (tx) => {
    const memberCreates = [
      ...[...userIds].map((uid) => ({
        userId: uid,
        role: (uid === userId ? "OWNER" : "MEMBER") as "OWNER" | "MEMBER",
      })),
      ...[...contactIds].map((cid) => ({
        contactId: cid,
        role: "MEMBER" as const,
      })),
    ];
    const g = await tx.group.create({
      data: {
        name: input.name,
        emoji: input.emoji,
        description: input.description,
        simplifyDebts: input.simplifyDebts ?? true,
        members: { create: memberCreates },
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
