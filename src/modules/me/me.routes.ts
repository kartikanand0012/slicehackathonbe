import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/prisma";
import { requireAuth } from "@/middleware/auth";
import { asyncHandler, validateBody } from "@/middleware/validate";
import { NotFoundError } from "@/lib/errors";

const router: Router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        avatarUrl: true,
        upiHandle: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundError("User not found");
    res.json({ user });
  }),
);

const UpdateMeBody = z.object({
  name: z.string().min(1).max(80).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  upiHandle: z
    .string()
    .regex(/^[\w.\-]+@[\w]+$/, "Invalid UPI handle")
    .nullable()
    .optional(),
});

router.patch(
  "/",
  validateBody(UpdateMeBody),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: req.body,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        avatarUrl: true,
        upiHandle: true,
      },
    });
    res.json({ user });
  }),
);

export { router as meRouter };
