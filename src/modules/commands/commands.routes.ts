import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  CommandParams,
  ListCommandsQuery,
  ParseCommandBody,
} from "./commands.schemas";
import * as service from "./commands.service";

const router: Router = Router();
router.use(requireAuth);

router.get(
  "/",
  validateQuery(ListCommandsQuery),
  asyncHandler(async (req, res) => {
    const { limit } = req.query as unknown as { limit: number };
    res.json(await service.listCommands(req.user!.id, limit));
  }),
);

router.post(
  "/",
  validateBody(ParseCommandBody),
  asyncHandler(async (req, res) => {
    const result = await service.parseCommand(req.user!.id, req.body);
    res.status(201).json(result);
  }),
);

router.get(
  "/:commandRunId",
  validateParams(CommandParams),
  asyncHandler(async (req, res) => {
    const { commandRunId } = req.params as unknown as { commandRunId: string };
    res.json({ commandRun: await service.getCommand(req.user!.id, commandRunId) });
  }),
);

router.post(
  "/:commandRunId/confirm",
  validateParams(CommandParams),
  asyncHandler(async (req, res) => {
    const { commandRunId } = req.params as unknown as { commandRunId: string };
    const result = await service.confirmCommand(req.user!.id, commandRunId);
    res.json(result);
  }),
);

router.post(
  "/:commandRunId/reject",
  validateParams(CommandParams),
  asyncHandler(async (req, res) => {
    const { commandRunId } = req.params as unknown as { commandRunId: string };
    res.json(await service.rejectCommand(req.user!.id, commandRunId));
  }),
);

export { router as commandsRouter };
