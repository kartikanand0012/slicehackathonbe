import { z } from "zod";

const Cuid = z.string().cuid();
const Paise = z.number().int().positive();

const EqualShares = z.object({
  mode: z.literal("EQUAL"),
  userIds: z.array(Cuid).min(1).max(50),
});
const ExactShares = z.object({
  mode: z.literal("EXACT"),
  shares: z
    .array(z.object({ userId: Cuid, amountPaise: z.number().int().nonnegative() }))
    .min(1)
    .max(50),
});
const PercentShares = z.object({
  mode: z.literal("PERCENTAGE"),
  shares: z
    .array(z.object({ userId: Cuid, basisPoints: z.number().int().nonnegative() }))
    .min(1)
    .max(50),
});
const ShareUnits = z.object({
  mode: z.literal("SHARES"),
  shares: z
    .array(z.object({ userId: Cuid, shares: z.number().int().positive() }))
    .min(1)
    .max(50),
});

const ConstraintShares = z.object({
  mode: z.literal("CONSTRAINT"),
  items: z
    .array(
      z.object({
        name: z.string().max(120).optional(),
        totalPaise: z.number().int().nonnegative(),
        tags: z.array(z.string().max(40)).default([]),
      }),
    )
    .min(1)
    .max(200),
  participants: z
    .array(
      z.object({
        userId: Cuid,
        allow: z.array(z.string().max(40)).optional(),
        deny: z.array(z.string().max(40)).optional(),
      }),
    )
    .min(1)
    .max(50),
  commonItemsPaise: z.number().int().nonnegative().optional(),
});

export const CreateExpenseBody = z
  .object({
    title: z.string().min(1).max(120).trim(),
    notes: z.string().max(1000).optional(),
    amountPaise: Paise,
    category: z.string().max(40).optional(),
    occurredAt: z.coerce.date().optional(),
    paidById: Cuid,
    split: z.discriminatedUnion("mode", [
      EqualShares,
      ExactShares,
      PercentShares,
      ShareUnits,
      ConstraintShares,
    ]),
  })
  .strict();
export type CreateExpenseBody = z.infer<typeof CreateExpenseBody>;

export const UpdateExpenseBody = z
  .object({
    title: z.string().min(1).max(120).trim().optional(),
    notes: z.string().max(1000).nullable().optional(),
    amountPaise: Paise.optional(),
    category: z.string().max(40).nullable().optional(),
    occurredAt: z.coerce.date().optional(),
    paidById: Cuid.optional(),
    split: z
      .discriminatedUnion("mode", [
        EqualShares,
        ExactShares,
        PercentShares,
        ShareUnits,
        ConstraintShares,
      ])
      .optional(),
  })
  .strict();
export type UpdateExpenseBody = z.infer<typeof UpdateExpenseBody>;

export const ListExpensesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Cuid.optional(),
});
export type ListExpensesQuery = z.infer<typeof ListExpensesQuery>;

export const ExpenseParams = z.object({
  groupId: Cuid,
  expenseId: Cuid,
});

export const GroupParams = z.object({ groupId: Cuid });
