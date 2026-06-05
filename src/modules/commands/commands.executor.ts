/**
 * Executor — turns a confirmed ParsedIntent into real Prisma writes by
 * calling the existing service layer. Anything mutating goes through here
 * so the audit trail stays consistent.
 *
 * Design rule (from the proposal §07): "Critical design rule: the
 * explanation is generated from the engine's actual computed split — the
 * split engine is the source of truth, the AI is the translator." The
 * executor enforces that by *never* trusting the AI's amount math directly
 * — every CREATE_EXPENSE goes back through `calculateShares` inside the
 * existing service, which validates the math regardless of intent shape.
 */

import { prisma } from "@/db/prisma";
import { BadRequestError } from "@/lib/errors";
import type { ParsedIntent } from "@/ai/types";
import * as groupsService from "@/modules/groups/groups.service";
import * as expensesService from "@/modules/expenses/expenses.service";
import * as settlementsService from "@/modules/settlements/settlements.service";
import * as balancesService from "@/modules/balances/balances.service";

export type ExecutionResult =
  | { type: "GROUP_CREATED"; groupId: string }
  | { type: "MEMBERS_ADDED"; groupId: string }
  | { type: "EXPENSE_CREATED"; expenseId: string; groupId: string }
  | { type: "SETTLEMENT_CREATED"; settlementId: string; groupId: string }
  | {
      type: "BALANCE_QUERY";
      groupId: string;
      balances: unknown;
      transfers: unknown;
    }
  | { type: "EXPENSE_EXPLAINED"; expenseId: string; explanation: string };

export async function executeIntent(
  userId: string,
  intent: ParsedIntent,
): Promise<ExecutionResult> {
  switch (intent.type) {
    case "CREATE_GROUP": {
      const group = await groupsService.createGroup(userId, {
        name: intent.name,
        emoji: intent.emoji,
        memberIds: intent.memberUserIds,
      });
      return { type: "GROUP_CREATED", groupId: group.id };
    }

    case "ADD_MEMBERS": {
      // Reuse addMember per member (groups service doesn't have a batch op).
      for (const memberId of intent.memberUserIds) {
        await groupsService.addMember(userId, intent.groupId, {
          userId: memberId,
        });
      }
      return { type: "MEMBERS_ADDED", groupId: intent.groupId };
    }

    case "CREATE_EXPENSE": {
      if (!intent.groupId) {
        throw new BadRequestError(
          "CREATE_EXPENSE intent must include a groupId; create the group first",
        );
      }
      const split = intent.split;
      let body;
      if (split.mode === "CONSTRAINT") {
        body = {
          title: intent.title,
          amountPaise: intent.amountPaise,
          paidById: intent.paidById,
          occurredAt: intent.occurredAt ? new Date(intent.occurredAt) : undefined,
          split: {
            mode: "CONSTRAINT" as const,
            items: split.items,
            participants: split.participants,
            commonItemsPaise: split.commonItemsPaise,
          },
        };
      } else if (split.mode === "EQUAL") {
        body = {
          title: intent.title,
          amountPaise: intent.amountPaise,
          paidById: intent.paidById,
          occurredAt: intent.occurredAt ? new Date(intent.occurredAt) : undefined,
          split: { mode: "EQUAL" as const, userIds: split.userIds },
        };
      } else if (split.mode === "EXACT") {
        body = {
          title: intent.title,
          amountPaise: intent.amountPaise,
          paidById: intent.paidById,
          occurredAt: intent.occurredAt ? new Date(intent.occurredAt) : undefined,
          split: { mode: "EXACT" as const, shares: split.shares },
        };
      } else if (split.mode === "PERCENTAGE") {
        body = {
          title: intent.title,
          amountPaise: intent.amountPaise,
          paidById: intent.paidById,
          occurredAt: intent.occurredAt ? new Date(intent.occurredAt) : undefined,
          split: { mode: "PERCENTAGE" as const, shares: split.shares },
        };
      } else {
        body = {
          title: intent.title,
          amountPaise: intent.amountPaise,
          paidById: intent.paidById,
          occurredAt: intent.occurredAt ? new Date(intent.occurredAt) : undefined,
          split: { mode: "SHARES" as const, shares: split.shares },
        };
      }
      const expense = await expensesService.createExpense(
        userId,
        intent.groupId,
        body as never,
      );
      return {
        type: "EXPENSE_CREATED",
        expenseId: expense.id,
        groupId: intent.groupId,
      };
    }

    case "CREATE_SETTLEMENT": {
      const allowedMethods = ["UPI", "CASH", "BANK_TRANSFER", "OTHER"] as const;
      type AllowedMethod = (typeof allowedMethods)[number];
      const method =
        intent.method && (allowedMethods as readonly string[]).includes(intent.method)
          ? (intent.method as AllowedMethod)
          : undefined;
      const settlement = await settlementsService.createSettlement(
        userId,
        intent.groupId,
        {
          fromId: intent.fromId,
          toId: intent.toId,
          amountPaise: intent.amountPaise,
          method,
        },
      );
      return {
        type: "SETTLEMENT_CREATED",
        settlementId: settlement.id,
        groupId: intent.groupId,
      };
    }

    case "QUERY_BALANCE": {
      const { balances, transfers } = await balancesService.getGroupBalances(
        userId,
        intent.groupId,
      );
      return {
        type: "BALANCE_QUERY",
        groupId: intent.groupId,
        balances,
        transfers,
      };
    }

    case "EXPLAIN_EXPENSE": {
      const exp = await prisma.expense.findUnique({
        where: { id: intent.expenseId },
        select: {
          id: true,
          groupId: true,
          title: true,
          amountPaise: true,
          splitMode: true,
          paidBy: { select: { id: true, name: true } },
          shares: {
            select: {
              amountPaise: true,
              user: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!exp) throw new BadRequestError("Expense not found");
      const explanation = renderExpenseExplanation(exp, intent.audienceUserId);
      return {
        type: "EXPENSE_EXPLAINED",
        expenseId: exp.id,
        explanation,
      };
    }

    case "REJECT":
      throw new BadRequestError(`Rejected: ${intent.reason}`);
  }
}

function renderExpenseExplanation(
  exp: {
    title: string;
    amountPaise: number;
    splitMode: string;
    paidBy: { name: string };
    shares: { amountPaise: number; user: { id: string; name: string } }[];
  },
  audienceUserId: string | undefined,
): string {
  const formatINR = (paise: number) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
    }).format(paise / 100);
  const audience = audienceUserId
    ? exp.shares.find((s) => s.user.id === audienceUserId)
    : null;
  const lines = [
    `${exp.title} (${exp.splitMode.toLowerCase()} split) — total ${formatINR(exp.amountPaise)} paid by ${exp.paidBy.name}.`,
    ...exp.shares.map(
      (s) => `  • ${s.user.name}: ${formatINR(s.amountPaise)}`,
    ),
  ];
  if (audience) {
    lines.push(`Your share: ${formatINR(audience.amountPaise)}.`);
  }
  return lines.join("\n");
}
