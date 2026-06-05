import { z } from "zod";

const Cuid = z.string().cuid();

// Phone in E.164 or near-E.164 — same regex we use elsewhere for User.phone
// and Contact.phone. Loose enough to accept "9876543210" without leading +;
// tight enough to reject anything obviously non-numeric.
const Phone = z.string().regex(/^\+?[1-9]\d{7,14}$/, "Invalid phone number");

export const CreateInviteBody = z
  .object({
    groupId: Cuid,
    // Either a phone (we mint a fresh invite) OR a contactId (we look up
    // the contact's phone). Exactly one required.
    phone: Phone.optional(),
    contactId: Cuid.optional(),
    expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
  })
  .strict()
  .refine((b) => Boolean(b.phone) !== Boolean(b.contactId), {
    message: "Exactly one of phone or contactId is required",
  });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const InviteTokenParams = z.object({
  token: z.string().min(8).max(80),
});
