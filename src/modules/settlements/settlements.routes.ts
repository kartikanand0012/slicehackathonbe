import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  CreateSettlementBody,
  GroupParams,
  ListSettlementsQuery,
} from "./settlements.schemas";
import * as service from "./settlements.service";

const router: Router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  validateParams(GroupParams),
  validateQuery(ListSettlementsQuery),
  asyncHandler(async (req, res) => {
    const result = await service.listSettlements(
      req.user!.id,
      (req.params as unknown as { groupId: string }).groupId,
      req.query as unknown as ListSettlementsQuery,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  validateParams(GroupParams),
  validateBody(CreateSettlementBody),
  asyncHandler(async (req, res) => {
    const settlement = await service.createSettlement(
      req.user!.id,
      (req.params as unknown as { groupId: string }).groupId,
      req.body,
    );
    res.status(201).json({ settlement });
  }),
);

export { router as settlementsRouter };
