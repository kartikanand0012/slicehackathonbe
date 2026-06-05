import { Router } from "express";
import { env } from "@/config/env";
import { asyncHandler, validateBody } from "@/middleware/validate";
import { rateLimit } from "@/middleware/rate-limit";
import { LoginBody, RefreshBody, RegisterBody } from "./auth.schemas";
import * as service from "./auth.service";

const router: Router = Router();

const authLimiter = rateLimit(
  "auth",
  env.AUTH_RATE_LIMIT_MAX,
  env.AUTH_RATE_LIMIT_WINDOW_MS,
);

router.post(
  "/register",
  authLimiter,
  validateBody(RegisterBody),
  asyncHandler(async (req, res) => {
    const result = await service.register(req.body);
    res.status(201).json(result);
  }),
);

router.post(
  "/login",
  authLimiter,
  validateBody(LoginBody),
  asyncHandler(async (req, res) => {
    const result = await service.login(req.body);
    res.json(result);
  }),
);

router.post(
  "/refresh",
  validateBody(RefreshBody),
  asyncHandler(async (req, res) => {
    const tokens = await service.refresh(req.body.refreshToken);
    res.json(tokens);
  }),
);

router.post(
  "/logout",
  validateBody(RefreshBody),
  asyncHandler(async (req, res) => {
    await service.logout(req.body.refreshToken);
    res.status(204).end();
  }),
);

export { router as authRouter };
