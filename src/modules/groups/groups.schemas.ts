import { z } from "zod";

const Cuid = z.string().cuid();

export const CreateGroupBody = z.object({
  name: z.string().min(1).max(80).trim(),
  emoji: z.string().min(1).max(8).optional(),
  description: z.string().max(500).optional(),
  simplifyDebts: z.boolean().optional(),
  memberIds: z.array(Cuid).max(50).optional(),
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
