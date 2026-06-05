import { Router } from "express";
import { prisma } from "@/db/prisma";
import { asyncHandler } from "@/middleware/validate";

const router: Router = Router();

router.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

router.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "reachable" });
  }),
);

export { router as healthRouter };
