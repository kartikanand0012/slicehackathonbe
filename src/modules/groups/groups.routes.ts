import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  AddMemberBody,
  CreateGroupBody,
  ListGroupsQuery,
  UpdateGroupBody,
} from "./groups.schemas";
import * as service from "./groups.service";

const router: Router = Router();
router.use(requireAuth);

router.get(
  "/",
  validateQuery(ListGroupsQuery),
  asyncHandler(async (req, res) => {
    const result = await service.listGroups(
      req.user!.id,
      req.query as unknown as ListGroupsQuery,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  validateBody(CreateGroupBody),
  asyncHandler(async (req, res) => {
    const group = await service.createGroup(req.user!.id, req.body);
    res.status(201).json({ group });
  }),
);

const IdParam = z.object({ groupId: z.string().cuid() });
const MemberParams = z.object({
  groupId: z.string().cuid(),
  userId: z.string().cuid(),
});

router.get(
  "/:groupId",
  validateParams(IdParam),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params as unknown as z.infer<typeof IdParam>;
    const group = await service.getGroup(req.user!.id, groupId);
    res.json({ group });
  }),
);

router.patch(
  "/:groupId",
  validateParams(IdParam),
  validateBody(UpdateGroupBody),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params as unknown as z.infer<typeof IdParam>;
    const group = await service.updateGroup(req.user!.id, groupId, req.body);
    res.json({ group });
  }),
);

router.post(
  "/:groupId/members",
  validateParams(IdParam),
  validateBody(AddMemberBody),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params as unknown as z.infer<typeof IdParam>;
    const group = await service.addMember(req.user!.id, groupId, req.body);
    res.json({ group });
  }),
);

router.delete(
  "/:groupId/members/:userId",
  validateParams(MemberParams),
  asyncHandler(async (req, res) => {
    const { groupId, userId: targetId } = req.params as unknown as z.infer<
      typeof MemberParams
    >;
    await service.removeMember(req.user!.id, groupId, targetId);
    res.status(204).end();
  }),
);

export { router as groupsRouter };
