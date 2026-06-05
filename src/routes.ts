import { Router } from "express";
import { authRouter } from "@/modules/auth/auth.routes";
import { balancesRouter } from "@/modules/balances/balances.routes";
import { commandsRouter } from "@/modules/commands/commands.routes";
import { contactsRouter } from "@/modules/contacts/contacts.routes";
import {
  disputesRouter,
  expenseDisputesRouter,
} from "@/modules/disputes/disputes.routes";
import { expensesRouter } from "@/modules/expenses/expenses.routes";
import { groupsRouter } from "@/modules/groups/groups.routes";
import {
  ownedGuestSplitsRouter,
  publicGuestSplitsRouter,
} from "@/modules/guest/guest.routes";
import {
  invitesRouter,
  publicInvitesRouter,
} from "@/modules/invites/invites.routes";
import { healthRouter } from "@/modules/health/health.routes";
import { meRouter } from "@/modules/me/me.routes";
import { receiptsRouter } from "@/modules/receipts/receipts.routes";
import { settlementsRouter } from "@/modules/settlements/settlements.routes";

export const apiRouter: Router = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/me", meRouter);

apiRouter.use("/groups", groupsRouter);
apiRouter.use("/groups/:groupId/expenses", expensesRouter);
apiRouter.use("/groups/:groupId/settlements", settlementsRouter);
apiRouter.use("/groups/:groupId/balances", balancesRouter);

apiRouter.use("/expenses/:expenseId/disputes", expenseDisputesRouter);
apiRouter.use("/disputes", disputesRouter);

apiRouter.use("/contacts", contactsRouter);
apiRouter.use("/receipts", receiptsRouter);
apiRouter.use("/commands", commandsRouter);

apiRouter.use("/guest-splits", ownedGuestSplitsRouter);
apiRouter.use("/g", publicGuestSplitsRouter); // short prefix for share URLs

apiRouter.use("/invites", invitesRouter);
apiRouter.use("/i", publicInvitesRouter); // public read by token
