import { z } from "zod";

const Cuid = z.string().cuid();

const PhoneOrNull = z
  .string()
  .regex(/^\+?[1-9]\d{7,14}$/, "Invalid phone number")
  .nullable()
  .optional();

const EmailOrNull = z.string().email().nullable().optional();

export const CreateContactBody = z
  .object({
    displayName: z.string().min(1).max(80).trim(),
    phone: PhoneOrNull,
    email: EmailOrNull,
  })
  .strict()
  .refine((c) => c.phone || c.email, {
    message: "Either phone or email is required",
    path: ["phone"],
  });
export type CreateContactBody = z.infer<typeof CreateContactBody>;

export const UpdateContactBody = z
  .object({
    displayName: z.string().min(1).max(80).trim().optional(),
    phone: PhoneOrNull,
    email: EmailOrNull,
  })
  .strict();
export type UpdateContactBody = z.infer<typeof UpdateContactBody>;

export const ListContactsQuery = z.object({
  search: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

export const ContactParams = z.object({ contactId: Cuid });
