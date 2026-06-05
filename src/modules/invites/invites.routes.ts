import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import {
  asyncHandler,
  validateBody,
  validateParams,
} from "@/middleware/validate";
import {
  CreateInviteBody,
  InviteTokenParams,
} from "./invites.schemas";
import * as service from "./invites.service";

// POST /invites — authenticated, rate-limited (10/5min) so a runaway FE
// can't spam SMS/WhatsApp deep-links. Public GET /invites/:token is open.
export const invitesRouter: Router = Router();
invitesRouter.use(requireAuth);
const createLimiter = rateLimit("invite-create", 10, 5 * 60_000);

invitesRouter.post(
  "/",
  createLimiter,
  validateBody(CreateInviteBody),
  asyncHandler(async (req, res) => {
    const result = await service.createInvite(req.user!.id, req.body);
    res.status(201).json(result);
  }),
);

invitesRouter.post(
  "/:token/redeem",
  validateParams(InviteTokenParams),
  asyncHandler(async (req, res) => {
    const { token } = req.params as unknown as { token: string };
    const result = await service.redeemInvite(req.user!.id, token);
    res.json(result);
  }),
);

export const publicInvitesRouter: Router = Router();
publicInvitesRouter.get(
  "/:token",
  validateParams(InviteTokenParams),
  asyncHandler(async (req, res) => {
    const { token } = req.params as unknown as { token: string };
    res.json(await service.getPublicInvite(token));
  }),
);
