import { Router } from "express";
import { authRouter } from "@/modules/auth/auth.routes";
import { groupsRouter } from "@/modules/groups/groups.routes";
import { healthRouter } from "@/modules/health/health.routes";
import { meRouter } from "@/modules/me/me.routes";

export const apiRouter: Router = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/me", meRouter);
apiRouter.use("/groups", groupsRouter);
