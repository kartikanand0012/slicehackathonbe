/**
 * Invites service — group invite tokens for the WhatsApp / SMS flow.
 *
 * Flow:
 *   1. The lender taps "Invite Charlie" on a non-Slice contact. FE calls
 *      `POST /invites { groupId, contactId }`.
 *   2. We mint a GroupInvite row with a token and return a `shareUrl`
 *      (built from PUBLIC_BASE_URL) that the FE drops into a `wa.me/...`
 *      or `sms:...` deep link.
 *   3. The invited person taps the link → lands on the FE's invite-landing
 *      page → FE calls `GET /invites/:token` (no auth) to render the offer
 *      (group name, who invited them, what bill they owe).
 *   4. Once they sign up (existing register flow) and tap "Join", FE calls
 *      `POST /invites/:token/redeem` (auth) — that backfills
 *      Contact.linkedUserId and mutates the GroupMember row from
 *      contact-kind to user-kind.
 *
 * This file ships steps 1 + 2 + 3. Step 4 (redeem) is the next chunk.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import type { CreateInviteBody } from "./invites.schemas";

const INVITE_PUBLIC_SELECT = {
  id: true,
  token: true,
  groupId: true,
  phone: true,
  contactId: true,
  expiresAt: true,
  usedAt: true,
  usedById: true,
  createdAt: true,
} as const;

function buildShareUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL}/invite/${token}`;
}

async function assertGroupAdmin(groupId: string, userId: string): Promise<void> {
  const m = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { role: true, leftAt: true },
  });
  if (!m || m.leftAt) throw new NotFoundError("Group not found");
  if (m.role !== "OWNER" && m.role !== "ADMIN") {
    throw new ForbiddenError("Only the owner or an admin can mint invites");
  }
}

export async function createInvite(
  userId: string,
  body: CreateInviteBody,
): Promise<{
  invite: Pick<
    Prisma.GroupInviteGetPayload<{ select: typeof INVITE_PUBLIC_SELECT }>,
    keyof typeof INVITE_PUBLIC_SELECT
  >;
  shareUrl: string;
}> {
  await assertGroupAdmin(body.groupId, userId);

  let phone = body.phone;
  const contactId = body.contactId;

  if (contactId) {
    const c = await prisma.contact.findFirst({
      where: { id: contactId, ownerId: userId },
      select: { id: true, phone: true },
    });
    if (!c) throw new BadRequestError("Contact not found in your address book");
    if (!c.phone)
      throw new BadRequestError(
        "Contact has no phone number — add one before inviting",
      );
    phone = c.phone;
  }

  const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);

  const invite = await prisma.$transaction(async (tx) => {
    const row = await tx.groupInvite.create({
      data: {
        groupId: body.groupId,
        invitedBy: userId,
        phone,
        contactId,
        expiresAt,
      },
      select: INVITE_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId: body.groupId,
        action: "INVITE_CREATED",
        entityId: row.id,
        metadata: { phone, contactId: contactId ?? null },
      },
    });
    return row;
  });

  return { invite, shareUrl: buildShareUrl(invite.token) };
}

/**
 * Redeem an invite. Auth required — the redeemer becomes the new linked
 * user for the contact (if any) and a real user-kind member of the group.
 *
 * Side effects, all inside one transaction:
 *   1. Invite marked `usedAt` + `usedById`.
 *   2. If the invite is tied to a Contact and that contact has no
 *      `linkedUserId` yet, set it to the redeemer.
 *   3. If a contact-kind GroupMember row exists for that contact in the
 *      invite's group, flip it to user-kind (set `userId` = redeemer,
 *      clear `contactId`). If no member row exists, create a fresh
 *      user-kind one (so a borrower invited by `mintInvite` without a
 *      pre-existing membership still ends up in the group).
 *   4. Audit `INVITE_REDEEMED`.
 *
 * Idempotency: rejecting a second redeem keeps the data clean — the
 * already-used path returns an `INVITE_USED` error.
 */
export async function redeemInvite(userId: string, token: string) {
  const inv = await prisma.groupInvite.findUnique({
    where: { token },
    select: {
      id: true,
      groupId: true,
      contactId: true,
      phone: true,
      usedAt: true,
      expiresAt: true,
    },
  });
  if (!inv) throw new NotFoundError("Invite not found");
  if (inv.usedAt) {
    throw new BadRequestError("Invite has already been redeemed");
  }
  if (inv.expiresAt < new Date()) {
    throw new BadRequestError("Invite has expired");
  }

  // The caller must not already be a user-kind member of the target group
  // — if they are, redemption is a no-op (idempotency-of-self), but we
  // still mark the invite used so it can't be reused by someone else.
  const existing = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId: inv.groupId } },
    select: { id: true, leftAt: true },
  });

  const result = await prisma.$transaction(async (tx) => {
    // 1. Mark the invite used.
    await tx.groupInvite.update({
      where: { id: inv.id },
      data: { usedAt: new Date(), usedById: userId },
    });

    // 2. Link the contact (if any) to the redeemer's user account.
    if (inv.contactId) {
      const contact = await tx.contact.findUnique({
        where: { id: inv.contactId },
        select: { linkedUserId: true },
      });
      if (contact && !contact.linkedUserId) {
        await tx.contact.update({
          where: { id: inv.contactId },
          data: { linkedUserId: userId },
        });
      }
    }

    // 3. Flip / create the GroupMember row.
    if (existing && !existing.leftAt) {
      // Caller is already a user-kind member. Nothing to do for membership.
      // We still attempt to clear an unused contact-kind row in case both
      // exist (rare race: invite minted before they joined separately).
      if (inv.contactId) {
        await tx.groupMember.deleteMany({
          where: { groupId: inv.groupId, contactId: inv.contactId },
        });
      }
    } else if (inv.contactId) {
      // Look for the contact-kind row from the original mint-time.
      const contactMember = await tx.groupMember.findFirst({
        where: { groupId: inv.groupId, contactId: inv.contactId },
        select: { id: true },
      });
      if (contactMember) {
        // Flip in place — keeps joinedAt + role stable.
        await tx.groupMember.update({
          where: { id: contactMember.id },
          data: { userId, contactId: null, leftAt: null },
        });
      } else {
        // No pre-existing membership — create fresh user-kind.
        await tx.groupMember.create({
          data: { userId, groupId: inv.groupId, role: "MEMBER" },
        });
      }
    } else {
      // Phone-only invite (no contact) — just add the user.
      await tx.groupMember.create({
        data: { userId, groupId: inv.groupId, role: "MEMBER" },
      });
    }

    // 4. Audit.
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        groupId: inv.groupId,
        action: "INVITE_REDEEMED",
        entityId: inv.id,
        metadata: { contactId: inv.contactId ?? null, phone: inv.phone ?? null },
      },
    });

    return { groupId: inv.groupId };
  });

  return result;
}

/**
 * Public read — no auth. The invite landing page calls this to render
 * "Alice invited you to Goa Trip — tap to join". We return only what's
 * needed for the landing UI; nothing about other group members or
 * unrelated balances.
 */
export async function getPublicInvite(token: string) {
  const inv = await prisma.groupInvite.findUnique({
    where: { token },
    select: {
      id: true,
      token: true,
      groupId: true,
      expiresAt: true,
      usedAt: true,
      phone: true,
      group: { select: { id: true, name: true, emoji: true } },
    },
  });
  if (!inv) throw new NotFoundError("Invite not found");
  const expired = inv.expiresAt < new Date();
  return {
    invite: {
      token: inv.token,
      group: inv.group,
      expiresAt: inv.expiresAt,
      phone: inv.phone,
      status: inv.usedAt ? "USED" : expired ? "EXPIRED" : "PENDING",
    },
  };
}
