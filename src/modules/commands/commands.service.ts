/**
 * Commands service — parses an utterance into a structured plan and, on
 * confirmation, executes it. Every step writes to CommandRun and AuditEvent
 * so a session is fully replayable.
 *
 * Two-stage by design (proposal §06 design rule):
 *   1. POST /commands → parse → returns plan + commandRunId
 *   2. POST /commands/:id/confirm → executes
 *
 * Voice and chat hit the same endpoint; the only difference is `source`.
 */

import type { CommandStatus, Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getIntentParser } from "@/ai/registry";
import { TOOL_DEFINITIONS, runTool, type ToolContext } from "@/ai/tools";
import type { ParsedIntent, ToolCall } from "@/ai/types";
import { executeIntent, type ExecutionResult } from "./commands.executor";
import type { ParseCommandBody } from "./commands.schemas";

const RUN_PUBLIC_SELECT = {
  id: true,
  source: true,
  status: true,
  utterance: true,
  contextGroupId: true,
  contextReceiptId: true,
  aiProvider: true,
  parsedIntent: true,
  plan: true,
  executionResult: true,
  errorReason: true,
  confirmedAt: true,
  executedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function parseCommand(
  userId: string,
  body: ParseCommandBody,
): Promise<{
  commandRun: unknown;
  intent: ParsedIntent;
  plan: Record<string, unknown>;
}> {
  const caller = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true },
  });

  const parser = getIntentParser();
  const ctx: ToolContext = {
    callerUserId: userId,
    contextGroupId: body.contextGroupId ?? null,
    contextReceiptId: body.contextReceiptId ?? null,
  };

  try {
    const { intent, toolCallTrace, modelId } = await parser.parseIntent({
      utterance: body.utterance,
      source: body.source,
      scope: {
        callerUserId: userId,
        callerName: caller.name,
        contextGroupId: body.contextGroupId ?? null,
        contextReceiptId: body.contextReceiptId ?? null,
      },
      tools: TOOL_DEFINITIONS,
      toolRunner: (call: ToolCall) => runTool(call, ctx),
      maxRounds: 8,
    });

    const plan = renderPlan(intent);

    const run = await prisma.commandRun.create({
      data: {
        userId,
        source: body.source,
        utterance: body.utterance,
        contextGroupId: body.contextGroupId,
        contextReceiptId: body.contextReceiptId,
        aiProvider: parser.name,
        parsedIntent: intent as unknown as Prisma.InputJsonValue,
        toolCallTrace: toolCallTrace as unknown as Prisma.InputJsonValue,
        plan: plan as unknown as Prisma.InputJsonValue,
        status: "PARSED",
      },
      select: RUN_PUBLIC_SELECT,
    });

    await prisma.auditEvent.create({
      data: {
        actorId: userId,
        groupId: body.contextGroupId,
        action: "COMMAND_PARSED",
        entityId: run.id,
        metadata: { provider: parser.name, modelId, source: body.source },
      },
    });

    return { commandRun: run, intent, plan };
  } catch (err) {
    logger.error({ err }, "Intent parsing failed");
    const failed = await prisma.commandRun.create({
      data: {
        userId,
        source: body.source,
        utterance: body.utterance,
        contextGroupId: body.contextGroupId,
        contextReceiptId: body.contextReceiptId,
        aiProvider: parser.name,
        status: "FAILED",
        errorReason: (err as Error).message.slice(0, 500),
      },
      select: RUN_PUBLIC_SELECT,
    });
    await prisma.auditEvent.create({
      data: {
        actorId: userId,
        action: "COMMAND_FAILED",
        entityId: failed.id,
        metadata: { error: (err as Error).message.slice(0, 200) },
      },
    });
    throw err;
  }
}

export async function confirmCommand(
  userId: string,
  commandRunId: string,
): Promise<{ commandRun: unknown; result: ExecutionResult }> {
  const run = await prisma.commandRun.findUnique({
    where: { id: commandRunId },
  });
  if (!run || run.userId !== userId) {
    throw new NotFoundError("Command run not found");
  }
  if (run.status !== "PARSED") {
    throw new BadRequestError(`Cannot confirm a command in status ${run.status}`);
  }

  await prisma.commandRun.update({
    where: { id: commandRunId },
    data: { status: "CONFIRMED" as CommandStatus, confirmedAt: new Date() },
  });
  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      groupId: run.contextGroupId,
      action: "COMMAND_CONFIRMED",
      entityId: run.id,
    },
  });

  let result: ExecutionResult;
  try {
    result = await executeIntent(
      userId,
      run.parsedIntent as unknown as ParsedIntent,
    );
  } catch (err) {
    await prisma.commandRun.update({
      where: { id: commandRunId },
      data: {
        status: "FAILED" as CommandStatus,
        errorReason: (err as Error).message.slice(0, 500),
      },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: userId,
        groupId: run.contextGroupId,
        action: "COMMAND_FAILED",
        entityId: run.id,
        metadata: { error: (err as Error).message.slice(0, 200) },
      },
    });
    throw err;
  }

  const updated = await prisma.commandRun.update({
    where: { id: commandRunId },
    data: {
      status: "EXECUTED" as CommandStatus,
      executedAt: new Date(),
      executionResult: result as unknown as Prisma.InputJsonValue,
    },
    select: RUN_PUBLIC_SELECT,
  });
  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      groupId: "groupId" in result ? result.groupId : null,
      action: "COMMAND_EXECUTED",
      entityId: commandRunId,
      metadata: { resultType: result.type },
    },
  });

  return { commandRun: updated, result };
}

export async function rejectCommand(
  userId: string,
  commandRunId: string,
): Promise<{ commandRun: unknown }> {
  const run = await prisma.commandRun.findUnique({
    where: { id: commandRunId },
    select: { id: true, userId: true, status: true, contextGroupId: true },
  });
  if (!run || run.userId !== userId) {
    throw new NotFoundError("Command run not found");
  }
  if (run.status !== "PARSED") {
    throw new BadRequestError(`Cannot reject a command in status ${run.status}`);
  }
  const updated = await prisma.commandRun.update({
    where: { id: commandRunId },
    data: { status: "REJECTED" as CommandStatus },
    select: RUN_PUBLIC_SELECT,
  });
  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      groupId: run.contextGroupId,
      action: "COMMAND_REJECTED",
      entityId: run.id,
    },
  });
  return { commandRun: updated };
}

export async function getCommand(userId: string, commandRunId: string) {
  const run = await prisma.commandRun.findUnique({
    where: { id: commandRunId },
    select: RUN_PUBLIC_SELECT,
  });
  if (!run) throw new NotFoundError("Command run not found");
  const withOwner = await prisma.commandRun.findUnique({
    where: { id: commandRunId },
    select: { userId: true },
  });
  if (withOwner?.userId !== userId) throw new NotFoundError("Command run not found");
  return run;
}

export async function listCommands(userId: string, limit: number) {
  return {
    items: await prisma.commandRun.findMany({
      where: { userId },
      select: RUN_PUBLIC_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  };
}

function renderPlan(intent: ParsedIntent): Record<string, unknown> {
  switch (intent.type) {
    case "CREATE_GROUP":
      return {
        action: "Create group",
        name: intent.name,
        memberCount: intent.memberUserIds.length,
        explanation: intent.explanation,
      };
    case "ADD_MEMBERS":
      return {
        action: "Add members",
        groupId: intent.groupId,
        memberCount: intent.memberUserIds.length,
        explanation: intent.explanation,
      };
    case "CREATE_EXPENSE":
      return {
        action: "Create expense",
        title: intent.title,
        amountPaise: intent.amountPaise,
        paidById: intent.paidById,
        splitMode: intent.split.mode,
        explanation: intent.explanation,
      };
    case "CREATE_SETTLEMENT":
      return {
        action: "Record settlement",
        fromId: intent.fromId,
        toId: intent.toId,
        amountPaise: intent.amountPaise,
        explanation: intent.explanation,
      };
    case "QUERY_BALANCE":
      return {
        action: "Show balances",
        groupId: intent.groupId,
        explanation: intent.explanation,
      };
    case "EXPLAIN_EXPENSE":
      return {
        action: "Explain expense",
        expenseId: intent.expenseId,
        explanation: intent.explanation,
      };
    case "REJECT":
      return { action: "Rejected", reason: intent.reason };
  }
}
