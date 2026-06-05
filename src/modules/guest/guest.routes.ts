import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
} from "@/middleware/validate";
import {
  AddPersonBody,
  ClaimItemBody,
  CreateGuestSplitBody,
  GuestSplitParams,
  ReleaseItemBody,
  ShareTokenParams,
} from "./guest.schemas";
import * as service from "./guest.service";

// ── Authenticated owner routes ──────────────────────────────
export const ownedGuestSplitsRouter: Router = Router();
ownedGuestSplitsRouter.use(requireAuth);

ownedGuestSplitsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await service.listOwnedSplits(req.user!.id);
    res.json(result);
  }),
);

ownedGuestSplitsRouter.post(
  "/",
  validateBody(CreateGuestSplitBody),
  asyncHandler(async (req, res) => {
    const split = await service.createGuestSplit(req.user!.id, req.body);
    res.status(201).json({ guestSplit: split });
  }),
);

ownedGuestSplitsRouter.get(
  "/:guestSplitId",
  validateParams(GuestSplitParams),
  asyncHandler(async (req, res) => {
    const { guestSplitId } = req.params as unknown as { guestSplitId: string };
    const split = await service.getOwnedSplit(req.user!.id, guestSplitId);
    res.json({ guestSplit: split });
  }),
);

// ── Public, no-auth routes (share token-scoped) ─────────────
export const publicGuestSplitsRouter: Router = Router();

publicGuestSplitsRouter.get(
  "/:shareToken",
  validateParams(ShareTokenParams),
  asyncHandler(async (req, res) => {
    const { shareToken } = req.params as unknown as { shareToken: string };
    const guestSplit = await service.viewByShareToken(shareToken);
    res.json({ guestSplit });
  }),
);

publicGuestSplitsRouter.post(
  "/:shareToken/people",
  validateParams(ShareTokenParams),
  validateBody(AddPersonBody),
  asyncHandler(async (req, res) => {
    const { shareToken } = req.params as unknown as { shareToken: string };
    const person = await service.addPerson(shareToken, req.body);
    res.status(201).json({ person });
  }),
);

publicGuestSplitsRouter.post(
  "/:shareToken/claims",
  validateParams(ShareTokenParams),
  validateBody(ClaimItemBody),
  asyncHandler(async (req, res) => {
    const { shareToken } = req.params as unknown as { shareToken: string };
    const guestSplit = await service.claimItems(shareToken, req.body);
    res.json({ guestSplit });
  }),
);

publicGuestSplitsRouter.delete(
  "/:shareToken/claims",
  validateParams(ShareTokenParams),
  validateBody(ReleaseItemBody),
  asyncHandler(async (req, res) => {
    const { shareToken } = req.params as unknown as { shareToken: string };
    const guestSplit = await service.releaseItems(shareToken, req.body);
    res.json({ guestSplit });
  }),
);

// Finalize requires the owner — authenticated route, scoped by shareToken too.
const finalizeRouter: Router = Router();
finalizeRouter.use(requireAuth);
finalizeRouter.post(
  "/:shareToken/finalize",
  validateParams(ShareTokenParams),
  asyncHandler(async (req, res) => {
    const { shareToken } = req.params as unknown as { shareToken: string };
    const result = await service.finalize(req.user!.id, shareToken);
    res.json(result);
  }),
);

publicGuestSplitsRouter.use(finalizeRouter);
