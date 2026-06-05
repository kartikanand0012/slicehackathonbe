import { z } from "zod";

const Cuid = z.string().cuid();

export const CreateSettlementBody = z
  .object({
    fromId: Cuid,
    toId: Cuid,
    amountPaise: z.number().int().positive(),
    method: z.enum(["UPI", "CASH", "BANK_TRANSFER", "OTHER"]).optional(),
    note: z.string().max(500).optional(),
    settledAt: z.coerce.date().optional(),
  })
  .strict()
  .refine((b) => b.fromId !== b.toId, {
    message: "fromId and toId must differ",
    path: ["toId"],
  });
export type CreateSettlementBody = z.infer<typeof CreateSettlementBody>;

export const ListSettlementsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Cuid.optional(),
});
export type ListSettlementsQuery = z.infer<typeof ListSettlementsQuery>;

export const GroupParams = z.object({ groupId: Cuid });
export const SettlementParams = z.object({
  groupId: Cuid,
  settlementId: Cuid,
});
