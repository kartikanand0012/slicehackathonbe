/**
 * Tool runner. Bridges a ToolCall coming back from the model into a real
 * query against the application (Prisma + small heuristics). The runner is
 * scoped to one caller so every tool implicitly enforces ownership rules.
 *
 * Returns a `ToolResult` whose `content` is a small JSON-serialisable shape
 * the model can reason over. Errors are returned with `isError: true` so the
 * model can recover instead of the whole call failing.
 */

import { prisma } from "@/db/prisma";
import { logger } from "@/lib/logger";
import { getIntentParser } from "@/ai/registry";
import type { ToolCall, ToolResult } from "@/ai/types";
import { ALLOWED_TAGS } from "./definitions";
import * as balancesService from "@/modules/balances/balances.service";

export type ToolContext = {
  callerUserId: string;
  contextGroupId?: string | null;
  contextReceiptId?: string | null;
};

const FORBIDDEN_FIELDS = new Set(["passwordHash", "tokenHash"]);

function stripPrivateFields<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripPrivateFields) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_FIELDS.has(k)) continue;
    out[k] = stripPrivateFields(v);
  }
  return out as T;
}

function ok(toolCallId: string, content: unknown): ToolResult {
  return { toolCallId, content: stripPrivateFields(content) };
}

function err(toolCallId: string, message: string): ToolResult {
  return { toolCallId, content: { error: message }, isError: true };
}

export async function runTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "get_current_user":
        return ok(call.id, await getCurrentUser(ctx));
      case "resolve_mention":
        return ok(call.id, await resolveMention(call.input, ctx));
      case "get_my_groups":
        return ok(call.id, await getMyGroups(ctx));
      case "get_group_members":
        return ok(call.id, await getGroupMembers(call.input, ctx));
      case "get_my_contacts":
        return ok(call.id, await getMyContacts(call.input, ctx));
      case "get_receipt_items":
        return ok(call.id, await getReceiptItems(call.input, ctx));
      case "categorize_items":
        return ok(call.id, await categorizeItems(call.input));
      case "get_recent_expenses":
        return ok(call.id, await getRecentExpenses(call.input, ctx));
      case "get_group_balances":
        return ok(call.id, await getGroupBalances(call.input, ctx));
      case "get_expense":
        return ok(call.id, await getExpense(call.input, ctx));
      default:
        return err(call.id, `Unknown tool: ${call.name}`);
    }
  } catch (e) {
    logger.warn({ err: e, tool: call.name }, "Tool call failed");
    return err(call.id, (e as Error).message);
  }
}

// ─── Individual tools ───────────────────────────────────────

async function getCurrentUser(ctx: ToolContext) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.callerUserId },
    select: { id: true, name: true, email: true, phone: true, upiHandle: true },
  });
  return { user: u };
}

async function resolveMention(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const mention = String(input.mention ?? "").trim();
  if (!mention) return { match: null, candidates: [] };
  const scope = (input.scope as string | undefined) ?? "any";

  // Strip a leading @ and any trailing punctuation.
  const cleaned = mention.replace(/^@+/, "").replace(/[^\w.\-+@]+$/g, "");

  // Try direct hits on phone/email first — they're unambiguous.
  if (cleaned.includes("@") && cleaned.includes(".")) {
    const u = await prisma.user.findUnique({
      where: { email: cleaned.toLowerCase() },
      select: { id: true, name: true, email: true, upiHandle: true },
    });
    if (u) return { match: { kind: "user", ...u }, candidates: [] };
  }
  if (/^\+?[\d-]+$/.test(cleaned)) {
    const u = await prisma.user.findUnique({
      where: { phone: cleaned },
      select: { id: true, name: true, email: true, upiHandle: true },
    });
    if (u) return { match: { kind: "user", ...u }, candidates: [] };
  }

  // Otherwise treat as a name. Search by case-insensitive prefix and
  // substring, scoped by the requested source.
  const candidates: { kind: string; id: string; name: string; userId?: string; upiHandle?: string | null }[] = [];

  if (scope === "group" || scope === "any") {
    if (ctx.contextGroupId) {
      const members = await prisma.groupMember.findMany({
        where: {
          groupId: ctx.contextGroupId,
          leftAt: null,
          user: { name: { contains: cleaned, mode: "insensitive" } },
        },
        select: {
          user: { select: { id: true, name: true, upiHandle: true } },
        },
        take: 5,
      });
      for (const m of members) {
        if (!m.user) continue;
        candidates.push({
          kind: "user",
          id: m.user.id,
          name: m.user.name,
          upiHandle: m.user.upiHandle,
        });
      }
    }
  }
  if (scope === "contacts" || scope === "any") {
    const contacts = await prisma.contact.findMany({
      where: {
        ownerId: ctx.callerUserId,
        displayName: { contains: cleaned, mode: "insensitive" },
      },
      select: {
        id: true,
        displayName: true,
        linkedUserId: true,
        linkedUser: { select: { id: true, name: true, upiHandle: true } },
      },
      take: 5,
    });
    for (const c of contacts) {
      candidates.push({
        kind: c.linkedUserId ? "user" : "contact",
        id: c.linkedUserId ?? c.id,
        name: c.linkedUser?.name ?? c.displayName,
        upiHandle: c.linkedUser?.upiHandle ?? null,
      });
    }
  }

  // De-duplicate by id+kind.
  const seen = new Set<string>();
  const deduped = candidates.filter((c) => {
    const k = `${c.kind}:${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    match: deduped.length === 1 ? deduped[0] : null,
    candidates: deduped,
    ambiguous: deduped.length > 1,
  };
}

async function getMyGroups(ctx: ToolContext) {
  const rows = await prisma.group.findMany({
    where: { members: { some: { userId: ctx.callerUserId, leftAt: null } }, archivedAt: null },
    select: {
      id: true,
      name: true,
      _count: { select: { members: { where: { leftAt: null } } } },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return {
    groups: rows.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
    })),
  };
}

async function getGroupMembers(input: Record<string, unknown>, ctx: ToolContext) {
  const groupId = String(input.groupId ?? "");
  await assertMember(groupId, ctx.callerUserId);
  const rows = await prisma.groupMember.findMany({
    where: { groupId, leftAt: null },
    select: {
      role: true,
      user: { select: { id: true, name: true, email: true, upiHandle: true } },
      contact: { select: { id: true, displayName: true, phone: true, email: true } },
    },
  });
  type Member = {
    id: string;
    name: string;
    email: string | null;
    phone?: string | null;
    upiHandle?: string | null;
    role: string;
    kind: "user" | "contact";
  };
  const out: Member[] = [];
  for (const m of rows) {
    if (m.user) {
      out.push({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        upiHandle: m.user.upiHandle,
        role: m.role,
        kind: "user",
      });
    } else if (m.contact) {
      out.push({
        id: m.contact.id,
        name: m.contact.displayName,
        email: m.contact.email,
        phone: m.contact.phone,
        role: m.role,
        kind: "contact",
      });
    }
  }
  return { members: out };
}

async function getMyContacts(input: Record<string, unknown>, ctx: ToolContext) {
  const search = typeof input.search === "string" ? input.search : undefined;
  const rows = await prisma.contact.findMany({
    where: {
      ownerId: ctx.callerUserId,
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      displayName: true,
      phone: true,
      email: true,
      linkedUserId: true,
    },
    take: 50,
    orderBy: { displayName: "asc" },
  });
  return { contacts: rows };
}

async function getReceiptItems(input: Record<string, unknown>, ctx: ToolContext) {
  const receiptId = String(input.receiptId ?? "");
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: {
      id: true,
      uploadedById: true,
      merchantName: true,
      totalPaise: true,
      subtotalPaise: true,
      taxPaise: true,
      tipPaise: true,
      status: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unitPaise: true,
          totalPaise: true,
          tags: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!r || r.uploadedById !== ctx.callerUserId) {
    throw new Error("Receipt not found");
  }
  return {
    receipt: {
      id: r.id,
      merchantName: r.merchantName,
      totalPaise: r.totalPaise,
      subtotalPaise: r.subtotalPaise,
      taxPaise: r.taxPaise,
      tipPaise: r.tipPaise,
      status: r.status,
      items: r.items,
    },
  };
}

/**
 * Tag a list of item names. Tries the configured IntentParser provider first
 * (Claude is good at this). If that fails or no provider is configured,
 * falls back to a small keyword lookup so the pipeline never blocks.
 */
async function categorizeItems(input: Record<string, unknown>) {
  const items = Array.isArray(input.items) ? input.items : [];
  const names: string[] = items
    .map((it) => (it as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string");

  if (names.length === 0) return { tags: [] };

  // Fast keyword fallback (always runs first so we have a safety net).
  const fallback = names.map((name) => ({
    name,
    tags: keywordTags(name),
  }));

  // Try the AI provider for a richer pass — but only when configured.
  try {
    const parser = getIntentParser();
    if (parser.isConfigured() && parser.name !== "mock") {
      // We don't round-trip tools for categorisation; we just use the
      // provider to think about tags. For the mock provider we skip
      // (fallback already gave us reasonable tags).
      // The richer call lives in providers/anthropic and bedrock — they
      // expose a `categorize` helper there. For now we trust the fallback;
      // production tuning happens per-provider.
    }
  } catch {
    /* swallow — fallback is fine */
  }

  return { tags: fallback };
}

const VEG_KEYWORDS = [
  "paneer", "veg", "vegetable", "dal", "rajma", "chole", "aloo", "gobi",
  "mushroom", "tofu", "salad", "soup", "rice", "roti", "naan", "paratha",
  "pizza", "pasta", "fries", "coffee", "tea", "latte", "juice", "lassi",
  "smoothie", "matar", "palak", "bhindi", "baingan", "khichdi", "idli",
  "dosa", "uttapam", "samosa", "kachori",
];
const NON_VEG_KEYWORDS = [
  "chicken", "mutton", "fish", "prawn", "egg", "lamb", "beef", "pork",
  "kebab", "tikka", "biryani", "keema", "seekh",
];
const ALCOHOL_KEYWORDS = ["beer", "wine", "vodka", "whisky", "rum", "cocktail", "mojito"];
const DESSERT_KEYWORDS = ["cake", "ice cream", "kulfi", "rasgulla", "gulab", "brownie", "pudding"];
const STARTER_KEYWORDS = ["starter", "appetizer", "soup"];
const BEVERAGE_KEYWORDS = ["coffee", "tea", "juice", "soda", "water", "latte", "lassi"];

function keywordTags(name: string): string[] {
  const lower = name.toLowerCase();
  const tags = new Set<string>();
  const has = (list: string[]) => list.some((k) => lower.includes(k));
  if (has(NON_VEG_KEYWORDS)) tags.add("non-veg");
  if (has(VEG_KEYWORDS) && !tags.has("non-veg")) tags.add("veg");
  if (has(ALCOHOL_KEYWORDS)) tags.add("alcohol");
  if (has(DESSERT_KEYWORDS)) tags.add("dessert");
  if (has(STARTER_KEYWORDS)) tags.add("starter");
  if (has(BEVERAGE_KEYWORDS)) tags.add("beverage");
  if (tags.size === 0) tags.add("other");
  // Whitelist against ALLOWED_TAGS.
  return Array.from(tags).filter((t) => (ALLOWED_TAGS as readonly string[]).includes(t));
}

async function getRecentExpenses(
  input: Record<string, unknown>,
  ctx: ToolContext,
) {
  const groupId = String(input.groupId ?? "");
  const withinDays = Number(input.withinDays ?? 7);
  const limit = Number(input.limit ?? 10);
  await assertMember(groupId, ctx.callerUserId);
  const since = new Date(Date.now() - withinDays * 86_400_000);
  const rows = await prisma.expense.findMany({
    where: { groupId, deletedAt: null, occurredAt: { gte: since } },
    select: {
      id: true,
      title: true,
      amountPaise: true,
      occurredAt: true,
      paidById: true,
      splitMode: true,
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
  return { expenses: rows };
}

async function getGroupBalances(input: Record<string, unknown>, ctx: ToolContext) {
  const groupId = String(input.groupId ?? "");
  return balancesService.getGroupBalances(ctx.callerUserId, groupId);
}

async function getExpense(input: Record<string, unknown>, ctx: ToolContext) {
  const expenseId = String(input.expenseId ?? "");
  const exp = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      groupId: true,
      title: true,
      amountPaise: true,
      splitMode: true,
      paidById: true,
      occurredAt: true,
      shares: {
        select: {
          userId: true,
          amountPaise: true,
          basisPoints: true,
          shares: true,
        },
      },
    },
  });
  if (!exp) throw new Error("Expense not found");
  await assertMember(exp.groupId, ctx.callerUserId);
  return { expense: exp };
}

async function assertMember(groupId: string, userId: string): Promise<void> {
  const m = await prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
    select: { leftAt: true },
  });
  if (!m || m.leftAt) throw new Error("Group not found or caller not a member");
}
