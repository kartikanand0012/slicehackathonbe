import { z } from "zod";

const Cuid = z.string().cuid();

export const ParseCommandBody = z
  .object({
    utterance: z.string().min(1).max(2000).trim(),
    source: z.enum(["voice", "chat"]).default("chat"),
    contextGroupId: Cuid.optional(),
    contextReceiptId: Cuid.optional(),
  })
  .strict();
export type ParseCommandBody = z.infer<typeof ParseCommandBody>;

export const CommandParams = z.object({ commandRunId: Cuid });

export const ListCommandsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListCommandsQuery = z.infer<typeof ListCommandsQuery>;
