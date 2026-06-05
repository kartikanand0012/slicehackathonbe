import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  CreateExpenseBody,
  ExpenseParams,
  GroupParams,
  ListExpensesQuery,
  UpdateExpenseBody,
} from "./expenses.schemas";
import * as service from "./expenses.service";

const router: Router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  validateParams(GroupParams),
  validateQuery(ListExpensesQuery),
  asyncHandler(async (req, res) => {
    const result = await service.listExpenses(
      req.user!.id,
      (req.params as unknown as { groupId: string }).groupId,
      req.query as unknown as ListExpensesQuery,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  validateParams(GroupParams),
  validateBody(CreateExpenseBody),
  asyncHandler(async (req, res) => {
    const expense = await service.createExpense(
      req.user!.id,
      (req.params as unknown as { groupId: string }).groupId,
      req.body,
    );
    res.status(201).json({ expense });
  }),
);

router.get(
  "/:expenseId",
  validateParams(ExpenseParams),
  asyncHandler(async (req, res) => {
    const { groupId, expenseId } = req.params as unknown as {
      groupId: string;
      expenseId: string;
    };
    const expense = await service.getExpense(req.user!.id, groupId, expenseId);
    res.json({ expense });
  }),
);

router.patch(
  "/:expenseId",
  validateParams(ExpenseParams),
  validateBody(UpdateExpenseBody),
  asyncHandler(async (req, res) => {
    const { groupId, expenseId } = req.params as unknown as {
      groupId: string;
      expenseId: string;
    };
    const expense = await service.updateExpense(
      req.user!.id,
      groupId,
      expenseId,
      req.body,
    );
    res.json({ expense });
  }),
);

router.delete(
  "/:expenseId",
  validateParams(ExpenseParams),
  asyncHandler(async (req, res) => {
    const { groupId, expenseId } = req.params as unknown as {
      groupId: string;
      expenseId: string;
    };
    await service.deleteExpense(req.user!.id, groupId, expenseId);
    res.status(204).end();
  }),
);

export { router as expensesRouter };
