import { Router } from "express";
import multer from "multer";
import { env } from "@/config/env";
import { BadRequestError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  ConvertReceiptBody,
  ExtractReceiptBody,
  ListReceiptsQuery,
  ReceiptParams,
} from "./receipts.schemas";
import * as service from "./receipts.service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new BadRequestError("Only image uploads are accepted"));
      return;
    }
    cb(null, true);
  },
});

const router: Router = Router();
router.use(requireAuth);

router.get(
  "/",
  validateQuery(ListReceiptsQuery),
  asyncHandler(async (req, res) => {
    const result = await service.listReceipts(
      req.user!.id,
      req.query as unknown as ListReceiptsQuery,
    );
    res.json(result);
  }),
);

// OCR extraction also burns model tokens. Cap a single client at 10
// extractions per 5 min — well above the realistic demo ceiling but tight
// enough to stop a runaway upload loop.
const extractLimiter = rateLimit("receipt-extract", 10, 5 * 60_000);

router.post(
  "/extract",
  extractLimiter,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new BadRequestError("`image` form field is required");
    const body = ExtractReceiptBody.parse(req.body ?? {});
    const { receipt, wasDuplicate } = await service.uploadAndExtract({
      userId: req.user!.id,
      groupId: body.groupId,
      hint: body.hint,
      file: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        buffer: req.file.buffer,
      },
    });
    res.status(wasDuplicate ? 200 : 202).json({ receipt, wasDuplicate });
  }),
);

router.get(
  "/:receiptId",
  validateParams(ReceiptParams),
  asyncHandler(async (req, res) => {
    const { receiptId } = req.params as unknown as { receiptId: string };
    const receipt = await service.getReceipt(req.user!.id, receiptId);
    res.json({ receipt });
  }),
);

// Stream the raw image bytes. Used as the imageUrl target for the LOCAL
// storage backend (S3-backed receipts get a direct presigned S3 URL and
// the FE never hits this endpoint).
router.get(
  "/:receiptId/image",
  validateParams(ReceiptParams),
  asyncHandler(async (req, res) => {
    const { receiptId } = req.params as unknown as { receiptId: string };
    const { buffer, mimeType } = await service.getReceiptImageBuffer(
      req.user!.id,
      receiptId,
    );
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=600");
    res.send(buffer);
  }),
);

router.post(
  "/:receiptId/convert",
  validateParams(ReceiptParams),
  validateBody(ConvertReceiptBody),
  asyncHandler(async (req, res) => {
    const { receiptId } = req.params as unknown as { receiptId: string };
    const expense = await service.convertReceiptToExpense(
      req.user!.id,
      receiptId,
      req.body,
    );
    res.status(201).json({ expense });
  }),
);

export { router as receiptsRouter };
