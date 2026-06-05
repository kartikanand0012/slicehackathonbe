import { z } from "zod";

const Cuid = z.string().cuid();

export const FileDisputeBody = z
  .object({
    reason: z.string().min(3).max(500).trim(),
    // Optional structured payload — used by the auto-resolver for ITEM /
    // CONSTRAINT splits ("I left before dessert" => specific item names).
    payload: z
      .object({
        itemNames: z.array(z.string().max(120)).max(20).optional(),
        paiseDelta: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FileDisputeBody = z.infer<typeof FileDisputeBody>;

export const ResolveDisputeBody = z
  .object({
    // Splitter-supplied new share allocation for the affected expense.
    // Must reference every active expense share; sum must equal expense total.
    newShares: z
      .array(
        z.object({
          userId: Cuid,
          amountPaise: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(50),
    resolution: z.string().min(3).max(500).trim(),
  })
  .strict();
export type ResolveDisputeBody = z.infer<typeof ResolveDisputeBody>;

export const RejectDisputeBody = z
  .object({
    resolution: z.string().min(3).max(500).trim(),
  })
  .strict();
export type RejectDisputeBody = z.infer<typeof RejectDisputeBody>;

export const ExpenseDisputeParams = z.object({
  expenseId: Cuid,
});

export const DisputeParams = z.object({
  disputeId: Cuid,
});

export const ListDisputesQuery = z.object({
  status: z.enum(["OPEN", "AUTO_RESOLVED", "RESOLVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListDisputesQuery = z.infer<typeof ListDisputesQuery>;
