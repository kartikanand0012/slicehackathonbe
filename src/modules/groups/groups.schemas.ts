import { z } from "zod";

const Cuid = z.string().cuid();

// A member can be a platform user (`userId`) or a non-Slice contact
// (`contactId`). When the FE adds someone from the address book who hasn't
// signed up yet, it passes the contactId; we register them as a
// contact-kind member so the group has a stable identity to attach
// invites to.
const MemberRefSchema = z
  .object({
    userId: Cuid.optional(),
    contactId: Cuid.optional(),
  })
  .strict()
  .refine((m) => Boolean(m.userId) !== Boolean(m.contactId), {
    message: "Each member must set exactly one of userId or contactId",
  });

export const CreateGroupBody = z.object({
  name: z.string().min(1).max(80).trim(),
  emoji: z.string().min(1).max(8).optional(),
  description: z.string().max(500).optional(),
  simplifyDebts: z.boolean().optional(),
  // Legacy shape — still supported. Treated as `members: [{ userId }]`.
  memberIds: z.array(Cuid).max(50).optional(),
  members: z.array(MemberRefSchema).max(50).optional(),
});
export type CreateGroupBody = z.infer<typeof CreateGroupBody>;

export const UpdateGroupBody = z.object({
  name: z.string().min(1).max(80).trim().optional(),
  emoji: z.string().min(1).max(8).optional(),
  description: z.string().max(500).nullable().optional(),
  simplifyDebts: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateGroupBody = z.infer<typeof UpdateGroupBody>;

export const AddMemberBody = z.object({
  userId: Cuid,
  role: z.enum(["ADMIN", "MEMBER"]).optional(),
});
export type AddMemberBody = z.infer<typeof AddMemberBody>;

export const ListGroupsQuery = z.object({
  archived: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Cuid.optional(),
});
export type ListGroupsQuery = z.infer<typeof ListGroupsQuery>;
