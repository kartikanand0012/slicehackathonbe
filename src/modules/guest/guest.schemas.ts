import { z } from "zod";

const Cuid = z.string().cuid();
const Token = z.string().min(20).max(80);

const ItemInput = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().int().positive().max(100).default(1),
  unitPaise: z.number().int().nonnegative(),
  totalPaise: z.number().int().nonnegative(),
});

export const CreateGuestSplitBody = z
  .object({
    receiptId: Cuid.optional(),
    merchantName: z.string().max(120).optional(),
    totalPaise: z.number().int().positive(),
    taxPaise: z.number().int().nonnegative().optional(),
    tipPaise: z.number().int().nonnegative().optional(),
    expiresAt: z.coerce.date().optional(),
    items: z.array(ItemInput).min(1).max(200),
    peopleNames: z.array(z.string().min(1).max(80)).optional(),
  })
  .strict();
export type CreateGuestSplitBody = z.infer<typeof CreateGuestSplitBody>;

export const AddPersonBody = z
  .object({
    name: z.string().min(1).max(80).trim(),
    upiHandle: z.string().regex(/^[\w.\-]+@[\w]+$/).optional(),
  })
  .strict();
export type AddPersonBody = z.infer<typeof AddPersonBody>;

export const ClaimItemBody = z
  .object({
    claimToken: Token,
    itemIds: z.array(Cuid).min(1),
  })
  .strict();
export type ClaimItemBody = z.infer<typeof ClaimItemBody>;

export const ReleaseItemBody = z
  .object({
    claimToken: Token,
    itemIds: z.array(Cuid).min(1),
  })
  .strict();
export type ReleaseItemBody = z.infer<typeof ReleaseItemBody>;

export const ShareTokenParams = z.object({ shareToken: Token });
export const GuestSplitParams = z.object({ guestSplitId: Cuid });
