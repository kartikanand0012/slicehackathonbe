import { z } from "zod";

const Cuid = z.string().cuid();

/**
 * `ExtractReceiptBody` is what the client sends *with* the multipart upload.
 * The image file itself is in `req.file` (Multer), so this schema is just
 * for the JSON-ish form fields.
 */
export const ExtractReceiptBody = z
  .object({
    groupId: Cuid.optional(),
    hint: z.string().max(200).optional(),
  })
  .strict();
export type ExtractReceiptBody = z.infer<typeof ExtractReceiptBody>;

export const ConvertReceiptBody = z
  .object({
    title: z.string().min(1).max(120).trim(),
    paidById: Cuid,
    splitMode: z.enum(["EQUAL", "ITEM"]).default("EQUAL"),
    userIds: z.array(Cuid).min(1).max(50).optional(), // required for EQUAL
  })
  .strict()
  .refine((b) => b.splitMode !== "EQUAL" || (b.userIds && b.userIds.length > 0), {
    message: "userIds is required for EQUAL split",
    path: ["userIds"],
  });
export type ConvertReceiptBody = z.infer<typeof ConvertReceiptBody>;

export const ReceiptParams = z.object({ receiptId: Cuid });

export const ListReceiptsQuery = z.object({
  groupId: Cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListReceiptsQuery = z.infer<typeof ListReceiptsQuery>;
