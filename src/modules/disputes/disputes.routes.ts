import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  DisputeParams,
  ExpenseDisputeParams,
  FileDisputeBody,
  ListDisputesQuery,
  RejectDisputeBody,
  ResolveDisputeBody,
} from "./disputes.schemas";
import * as service from "./disputes.service";

// File a dispute under /expenses/:expenseId/disputes — heavily rate-limited
// since this is a user-facing "flag" action. Per the proposal §04, flags are
// rate-limited so groups can't be spammed.
export const expenseDisputesRouter: Router = Router({ mergeParams: true });
expenseDisputesRouter.use(requireAuth);
const flagLimiter = rateLimit("dispute-file", 5, 5 * 60_000);

expenseDisputesRouter.get(
  "/",
  validateParams(ExpenseDisputeParams),
  validateQuery(ListDisputesQuery),
  asyncHandler(async (req, res) => {
    const { expenseId } = req.params as unknown as { expenseId: string };
    const result = await service.listDisputesForExpense(
      req.user!.id,
      expenseId,
      req.query as unknown as ListDisputesQuery,
    );
    res.json(result);
  }),
);

expenseDisputesRouter.post(
  "/",
  flagLimiter,
  validateParams(ExpenseDisputeParams),
  validateBody(FileDisputeBody),
  asyncHandler(async (req, res) => {
    const { expenseId } = req.params as unknown as { expenseId: string };
    const result = await service.fileDispute(req.user!.id, expenseId, req.body);
    res.status(201).json(result);
  }),
);

// Resolve / reject lives under /disputes/:disputeId for clarity (the resolver
// often doesn't know the expense id off-hand, but they have the dispute id
// from a notification).
export const disputesRouter: Router = Router();
disputesRouter.use(requireAuth);

disputesRouter.post(
  "/:disputeId/resolve",
  validateParams(DisputeParams),
  validateBody(ResolveDisputeBody),
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params as unknown as { disputeId: string };
    const dispute = await service.resolveDispute(req.user!.id, disputeId, req.body);
    res.json({ dispute });
  }),
);

disputesRouter.post(
  "/:disputeId/reject",
  validateParams(DisputeParams),
  validateBody(RejectDisputeBody),
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params as unknown as { disputeId: string };
    const dispute = await service.rejectDispute(req.user!.id, disputeId, req.body);
    res.json({ dispute });
  }),
);
