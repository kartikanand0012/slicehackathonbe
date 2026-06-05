import { prisma } from "@/db/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { splitEqualPaise } from "@/lib/money";
import type {
  AddPersonBody,
  ClaimItemBody,
  CreateGuestSplitBody,
  ReleaseItemBody,
} from "./guest.schemas";

const GUEST_SPLIT_PUBLIC_SELECT = {
  id: true,
  shareToken: true,
  status: true,
  merchantName: true,
  totalPaise: true,
  taxPaise: true,
  tipPaise: true,
  expiresAt: true,
  finalizedAt: true,
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
      assignments: {
        select: {
          id: true,
          personId: true,
          shareUnits: true,
        },
      },
    },
    orderBy: { sortOrder: "asc" as const },
  },
  people: {
    select: {
      id: true,
      name: true,
      upiHandle: true,
      claimToken: true,
    },
  },
} as const;

async function findActive(shareToken: string) {
  const g = await prisma.guestSplit.findUnique({
    where: { shareToken },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!g) throw new NotFoundError("Guest split not found");
  if (g.expiresAt && g.expiresAt < new Date()) {
    throw new BadRequestError("Guest split has expired");
  }
  return g;
}

function requireClaiming(status: "CLAIMING" | "FINALIZED"): void {
  if (status !== "CLAIMING") {
    throw new ConflictError("Guest split is already finalized");
  }
}

export async function createGuestSplit(
  userId: string,
  body: CreateGuestSplitBody,
) {
  const split = await prisma.$transaction(async (tx) => {
    const created = await tx.guestSplit.create({
      data: {
        createdById: userId,
        receiptId: body.receiptId,
        merchantName: body.merchantName,
        totalPaise: body.totalPaise,
        taxPaise: body.taxPaise,
        tipPaise: body.tipPaise,
        expiresAt: body.expiresAt,
        items: {
          create: body.items.map((it, i) => ({
            name: it.name,
            quantity: it.quantity,
            unitPaise: it.unitPaise,
            totalPaise: it.totalPaise,
            sortOrder: i,
          })),
        },
        people: body.peopleNames
          ? {
              create: body.peopleNames.map((n) => ({ name: n })),
            }
          : undefined,
      },
      select: GUEST_SPLIT_PUBLIC_SELECT,
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        action: "GUEST_SPLIT_CREATED",
        entityId: created.id,
      },
    });
    return created;
  });
  return split;
}

/** Public view by share token — no auth, claim tokens are stripped. */
export async function viewByShareToken(shareToken: string) {
  const g = await prisma.guestSplit.findUnique({
    where: { shareToken },
    select: GUEST_SPLIT_PUBLIC_SELECT,
  });
  if (!g) throw new NotFoundError("Guest split not found");
  // Strip claim tokens — only the creator endpoint reveals them.
  return {
    ...g,
    people: g.people.map(({ claimToken: _ct, ...rest }) => rest),
  };
}

export async function addPerson(shareToken: string, body: AddPersonBody) {
  const g = await findActive(shareToken);
  requireClaiming(g.status);

  try {
    const person = await prisma.guestSplitPerson.create({
      data: {
        guestSplitId: g.id,
        name: body.name,
        upiHandle: body.upiHandle,
      },
      select: { id: true, name: true, upiHandle: true, claimToken: true },
    });
    return person;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      throw new ConflictError("A person with that name already joined");
    }
    throw err;
  }
}

export async function claimItems(shareToken: string, body: ClaimItemBody) {
  const g = await findActive(shareToken);
  requireClaiming(g.status);

  const person = await prisma.guestSplitPerson.findFirst({
    where: { guestSplitId: g.id, claimToken: body.claimToken },
    select: { id: true },
  });
  if (!person) throw new NotFoundError("Claim token does not match this split");

  // Confirm every item belongs to this split.
  const items = await prisma.guestSplitItem.findMany({
    where: { id: { in: body.itemIds }, guestSplitId: g.id },
    select: { id: true },
  });
  if (items.length !== body.itemIds.length) {
    throw new BadRequestError("One or more items don't belong to this split");
  }

  await prisma.$transaction(
    items.map((it) =>
      prisma.guestSplitAssignment.upsert({
        where: {
          itemId_personId: { itemId: it.id, personId: person.id },
        },
        create: { itemId: it.id, personId: person.id, shareUnits: 1 },
        update: { shareUnits: 1 },
      }),
    ),
  );

  return viewByShareToken(shareToken);
}

export async function releaseItems(shareToken: string, body: ReleaseItemBody) {
  const g = await findActive(shareToken);
  requireClaiming(g.status);

  const person = await prisma.guestSplitPerson.findFirst({
    where: { guestSplitId: g.id, claimToken: body.claimToken },
    select: { id: true },
  });
  if (!person) throw new NotFoundError("Claim token does not match this split");

  await prisma.guestSplitAssignment.deleteMany({
    where: {
      personId: person.id,
      itemId: { in: body.itemIds },
    },
  });

  return viewByShareToken(shareToken);
}

/**
 * Finalize: compute per-person totals (item shares + proportional tax/tip),
 * mark as FINALIZED. Idempotent — once finalized, returns the same summary.
 *
 * Note: only the original creator can finalize.
 */
export async function finalize(userId: string, shareToken: string) {
  const g = await prisma.guestSplit.findUnique({
    where: { shareToken },
    select: {
      id: true,
      createdById: true,
      status: true,
      totalPaise: true,
      taxPaise: true,
      tipPaise: true,
      items: {
        select: {
          id: true,
          totalPaise: true,
          assignments: { select: { personId: true, shareUnits: true } },
        },
      },
      people: { select: { id: true, name: true, upiHandle: true } },
    },
  });
  if (!g) throw new NotFoundError("Guest split not found");
  if (g.createdById !== userId) {
    throw new BadRequestError("Only the creator can finalize");
  }

  // Per-person item subtotals.
  const personSubtotal = new Map<string, number>();
  for (const p of g.people) personSubtotal.set(p.id, 0);

  for (const item of g.items) {
    if (item.assignments.length === 0) {
      throw new BadRequestError(
        `Cannot finalize — item ${item.id} has no claimants`,
      );
    }
    const units = item.assignments.reduce((s, a) => s + a.shareUnits, 0);
    const chunks = splitProportionalPaise(
      item.totalPaise,
      item.assignments.map((a) => a.shareUnits),
    );
    item.assignments.forEach((a, i) => {
      personSubtotal.set(
        a.personId,
        (personSubtotal.get(a.personId) ?? 0) + chunks[i]!,
      );
    });
    void units;
  }

  // Distribute tax + tip proportionally over the personSubtotals.
  const ledger = g.people.map((p) => ({
    personId: p.id,
    name: p.name,
    upiHandle: p.upiHandle,
    subtotalPaise: personSubtotal.get(p.id) ?? 0,
    taxPaise: 0,
    tipPaise: 0,
    totalPaise: 0,
  }));
  const subtotalSum = ledger.reduce((s, l) => s + l.subtotalPaise, 0);
  if (subtotalSum === 0) {
    throw new BadRequestError("No items claimed — nothing to finalize");
  }

  for (const [field, fieldTotal] of [
    ["taxPaise", g.taxPaise ?? 0] as const,
    ["tipPaise", g.tipPaise ?? 0] as const,
  ]) {
    if (fieldTotal === 0) continue;
    const chunks = splitProportionalPaise(
      fieldTotal,
      ledger.map((l) => l.subtotalPaise),
    );
    ledger.forEach((l, i) => {
      l[field] = chunks[i]!;
    });
  }
  for (const l of ledger) {
    l.totalPaise = l.subtotalPaise + l.taxPaise + l.tipPaise;
  }

  await prisma.$transaction(async (tx) => {
    await tx.guestSplit.update({
      where: { id: g.id },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: {
        actorId: userId,
        action: "GUEST_SPLIT_FINALIZED",
        entityId: g.id,
        metadata: { totalPaise: g.totalPaise, peopleCount: ledger.length },
      },
    });
  });

  return { status: "FINALIZED" as const, ledger };
}

/**
 * Split `totalPaise` proportionally by `weights`. Guarantees sum === total.
 * Used for tax/tip allocation and item-share-units redistribution.
 */
function splitProportionalPaise(
  totalPaise: number,
  weights: number[],
): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((totalPaise * w) / sum));
  let remainder = totalPaise - raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => {
    const add = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return r + add;
  });
}

export const __test__ = { splitProportionalPaise };

/** Owner view — includes claim tokens so they can be shared individually. */
export async function getOwnedSplit(userId: string, guestSplitId: string) {
  const g = await prisma.guestSplit.findUnique({
    where: { id: guestSplitId },
    select: { ...GUEST_SPLIT_PUBLIC_SELECT, createdById: true },
  });
  if (!g || g.createdById !== userId) {
    throw new NotFoundError("Guest split not found");
  }
  return g;
}

/** Owner view — list all splits I own. */
export async function listOwnedSplits(userId: string) {
  const rows = await prisma.guestSplit.findMany({
    where: { createdById: userId },
    select: GUEST_SPLIT_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return { items: rows };
}

// Re-export the equal-split helper to keep import surface tidy.
export { splitEqualPaise };
