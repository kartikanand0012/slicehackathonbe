import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, validateParams } from "@/middleware/validate";
import * as service from "./balances.service";

const router: Router = Router({ mergeParams: true });
router.use(requireAuth);

const GroupParams = z.object({ groupId: z.string().cuid() });

router.get(
  "/",
  validateParams(GroupParams),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params as unknown as z.infer<typeof GroupParams>;
    const result = await service.getGroupBalances(req.user!.id, groupId);
    res.json(result);
  }),
);

export { router as balancesRouter };
