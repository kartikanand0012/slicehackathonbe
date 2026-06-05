import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import {
  asyncHandler,
  validateBody,
  validateParams,
  validateQuery,
} from "@/middleware/validate";
import {
  ContactParams,
  CreateContactBody,
  ListContactsQuery,
  UpdateContactBody,
} from "./contacts.schemas";
import * as service from "./contacts.service";

const router: Router = Router();
router.use(requireAuth);

router.get(
  "/",
  validateQuery(ListContactsQuery),
  asyncHandler(async (req, res) => {
    const result = await service.listContacts(
      req.user!.id,
      req.query as unknown as ListContactsQuery,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  validateBody(CreateContactBody),
  asyncHandler(async (req, res) => {
    const contact = await service.createContact(req.user!.id, req.body);
    res.status(201).json({ contact });
  }),
);

router.patch(
  "/:contactId",
  validateParams(ContactParams),
  validateBody(UpdateContactBody),
  asyncHandler(async (req, res) => {
    const { contactId } = req.params as unknown as { contactId: string };
    const contact = await service.updateContact(
      req.user!.id,
      contactId,
      req.body,
    );
    res.json({ contact });
  }),
);

router.delete(
  "/:contactId",
  validateParams(ContactParams),
  asyncHandler(async (req, res) => {
    const { contactId } = req.params as unknown as { contactId: string };
    await service.deleteContact(req.user!.id, contactId);
    res.status(204).end();
  }),
);

export { router as contactsRouter };
