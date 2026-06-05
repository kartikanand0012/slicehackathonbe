# SliceSplit Backend — Database Documentation

Detailed reference for the PostgreSQL schema, Prisma client wiring, connection lifecycle, and conventions used in the `slicesplit-backend` service.

---

## 1. Stack Overview

| Layer | Technology | Version / Notes |
| --- | --- | --- |
| Database engine | **PostgreSQL** | 16-alpine (compose) |
| ORM | **Prisma** | `^5.22.0` (`@prisma/client` + `prisma` CLI) |
| Driver | Prisma's built-in (`pg` under the hood) | |
| Schema location | `prisma/schema.prisma` | Single-file schema |
| Generated client | `@prisma/client` | Default location |
| Runtime targets | `native`, `linux-musl-arm64-openssl-3.0.x`, `linux-musl-openssl-3.0.x` | Set for Alpine Docker image |
| Preview features | `postgresqlExtensions` | Enabled in generator block |
| Money type | `Int` (paise) | 1 INR = 100 paise — **no floats anywhere** |
| ID strategy | `cuid()` | All primary keys are CUID strings |
| Soft delete | `deletedAt: DateTime?` (Expense only) | Other models hard-delete via cascade |

---

## 2. Connection Configuration

### 2.1 Environment

Defined in `src/config/env.ts` (validated with `zod`, fail-fast on startup):

```ts
DATABASE_URL: z.string().url().or(z.string().startsWith("postgres"))
```

A misconfigured `DATABASE_URL` aborts the process before any HTTP listener starts.

### 2.2 Docker Compose

`docker/docker-compose.yml` defines a `postgres:16-alpine` service:

```
POSTGRES_USER:     ${DB_USER:-slicesplit}
POSTGRES_PASSWORD: ${DB_PASSWORD:-slicesplit}
POSTGRES_DB:       ${DB_NAME:-slicesplit}
volume:            pgdata → /var/lib/postgresql/data
healthcheck:       pg_isready (5s interval, 10 retries)
```

The API container connects with:
```
DATABASE_URL=postgresql://slicesplit:slicesplit@postgres:5432/slicesplit?schema=public
```

Port 5432 is **not** published to the host by default (commented `5433:5432` for debugging).

### 2.3 Prisma Client Singleton

`src/db/prisma.ts`:

```ts
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development"
      ? ["query", "warn", "error"]
      : ["warn", "error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}
```

Key behaviors:
- **Singleton via `globalThis`** — avoids exhausting the connection pool during `tsx watch` hot reloads in dev.
- **Verbose logging in dev** — emits raw SQL queries.
- **Production** — silenced to `warn` + `error` only.

### 2.4 Liveness / Readiness

`src/modules/health/health.routes.ts`:
- `GET /api/v1/health/live` → static `{ status: "ok" }`.
- `GET /api/v1/health/ready` → runs `SELECT 1` via `prisma.$queryRaw`. Docker `healthcheck` hits this every 30s.

### 2.5 Migrations

`prisma/migrations/` exists but is **empty** — the project currently relies on `prisma db push` rather than tracked migration files. Scripts available in `package.json`:

```
prisma:generate       → prisma generate
prisma:migrate:dev    → prisma migrate dev
prisma:migrate:deploy → prisma migrate deploy
prisma:push           → prisma db push
prisma:studio         → prisma studio
```

> **Note:** before going to production, generating an initial migration is recommended so schema drift is reproducible across environments.

---

## 3. Schema Summary

- **Total models (tables):** 18
- **Total enums:** 7
- **Monetary precision:** all amounts are `Int` paise (suffix `…Paise`).
- **Auditability:** soft delete on `Expense`; append-only `AuditEvent` log; raw `Json` traces on `Receipt`, `CommandRun`, and `Dispute`.

### 3.1 Table Catalog

| # | Table | Domain | Purpose |
| --- | --- | --- | --- |
| 1 | `User` | Identity | Platform user (email/phone, password hash, UPI handle) |
| 2 | `RefreshToken` | Auth | Hashed refresh tokens with expiry/revocation |
| 3 | `Contact` | Identity | Owner's address book; optionally linked to a real User |
| 4 | `Group` | Splitting | Shared expense space (with `simplifyDebts` toggle) |
| 5 | `GroupMember` | Splitting | User ↔ Group join with role + leave timestamp |
| 6 | `GroupInvite` | Splitting | Tokenized invite links (single-use) |
| 7 | `Expense` | Splitting | A bill paid by one user, owed by many |
| 8 | `ExpenseShare` | Splitting | Per-user portion of an Expense |
| 9 | `Settlement` | Splitting | Payment that zeros out a debt |
| 10 | `AuditEvent` | Audit | Append-only event log (polymorphic `entityId`) |
| 11 | `Receipt` | OCR | Uploaded image + AI extraction metadata |
| 12 | `ReceiptItem` | OCR | One line item on a Receipt |
| 13 | `GuestSplit` | Guest flow | No-auth shareable bill (token URL) |
| 14 | `GuestSplitItem` | Guest flow | Line items on a GuestSplit |
| 15 | `GuestSplitPerson` | Guest flow | A guest claimant (token URL) |
| 16 | `GuestSplitAssignment` | Guest flow | Item ↔ Person assignment with share units |
| 17 | `CommandRun` | NL/AI | Voice/chat command parse + plan + execution trace |
| 18 | `Dispute` | Fairness | Flagged share with auto/manual resolution |

### 3.2 Enum Catalog

| Enum | Values |
| --- | --- |
| `GroupRole` | `OWNER`, `ADMIN`, `MEMBER` |
| `SplitMode` | `EQUAL`, `EXACT`, `PERCENTAGE`, `SHARES`, `ITEM`, `CONSTRAINT` |
| `ReceiptStatus` | `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED` |
| `GuestSplitStatus` | `CLAIMING`, `FINALIZED` |
| `CommandStatus` | `PARSED`, `CONFIRMED`, `EXECUTED`, `REJECTED`, `FAILED` |
| `DisputeStatus` | `OPEN`, `AUTO_RESOLVED`, `RESOLVED`, `REJECTED` |
| `AuditAction` | 28 values — see §5 |

---

## 4. Detailed Table Reference

### 4.1 `User` — identity root

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String` PK | `cuid()` |
| `email` | `String` | Unique |
| `phone` | `String?` | Unique, indexed |
| `name` | `String` | |
| `passwordHash` | `String` | Argon2id (see `ARGON2_*` env vars) |
| `avatarUrl` | `String?` | |
| `upiHandle` | `String?` | Reserved for UPI settle-up deep links |
| `createdAt` / `updatedAt` | `DateTime` | |

Relations (18 incoming/outgoing):
- `memberships`, `expensesPaid`, `expensesCreated`, `expenseShares`
- `settlementsOut` / `settlementsIn`
- `contactsOwned` / `contactLinked`
- `refreshTokens`, `auditEvents`, `receipts`
- `guestSplits`, `commandRuns`
- `disputesRaised`, `disputesResolved`

Indexes: `@@index([phone])` plus unique-implied indexes.

### 4.2 `RefreshToken`

- `tokenHash` is unique — **the raw token never lands in the DB**.
- `expiresAt` is indexed for cleanup jobs.
- `revokedAt` enables explicit invalidation without deletion.
- `onDelete: Cascade` from `User`.

### 4.3 `Contact` — placeholder-user replacement

Replaces ShareTab's "placeholder users" pattern. A contact can be off-platform until they sign up; setting `linkedUserId` upgrades them to a real `User` reference (with `onDelete: SetNull`).

Unique constraints prevent duplicate contacts per owner:
- `@@unique([ownerId, phone])`
- `@@unique([ownerId, email])`

### 4.4 `Group`

| Column | Notes |
| --- | --- |
| `emoji` | Defaults to `"💸"` |
| `simplifyDebts` | When `true`, the balance engine flattens A→B→C cycles |
| `archivedAt` | Soft-archive — not deletion |

Cascades `members`, `expenses`, `settlements`, `invites`, `receipts`, `guestSplits` on delete.

### 4.5 `GroupMember`

- `@@unique([userId, groupId])` — a user can't double-join.
- `leftAt` records voluntary leave without breaking historical expense references.
- `role` defaults to `MEMBER`.

### 4.6 `GroupInvite`

- `token` defaults to a fresh `cuid()`, unique.
- `usedAt` + `usedById` track single-use redemption.
- `expiresAt` is required.

### 4.7 `Expense`

| Column | Notes |
| --- | --- |
| `amountPaise` | `Int` — total bill |
| `splitMode` | `SplitMode` enum, default `EQUAL` |
| `paidById` / `createdById` | Two distinct user references (no `onDelete` cascade — keep history) |
| `occurredAt` | When the spend happened (vs `createdAt` when it was logged) |
| `deletedAt` | **Soft delete** — preserves audit trail and balance history |

Indexes:
- `@@index([groupId, occurredAt(sort: Desc)])` — feed query
- `@@index([paidById])`

### 4.8 `ExpenseShare`

| Column | Notes |
| --- | --- |
| `amountPaise` | Final settled value (always populated, even for percentage/shares modes) |
| `shares` | Raw share units, used when `SplitMode = SHARES` |
| `basisPoints` | 1/100 of a percent (5000 = 50.00%), used when `SplitMode = PERCENTAGE` |

`@@unique([expenseId, userId])` — one share row per (expense, user). Cascades on expense delete.

### 4.9 `Settlement`

- Tracks A→B transfers with `method` (free-form, e.g. `"UPI"`, `"CASH"`) and a `note`.
- `settledAt` indexed descending per group for activity feeds.

### 4.10 `AuditEvent` — append-only log

- `actorId` and `groupId` are nullable with `onDelete: SetNull` so events outlive their entities.
- `entityId` is a polymorphic reference (no FK).
- `metadata` is free-form `Json`.
- Indexed three ways: `(actorId, createdAt)`, `(groupId, createdAt)`, `(action, createdAt)`.

### 4.11 `Receipt` — AI-extracted bill

| Column | Notes |
| --- | --- |
| `imagePath` | Local disk path (S3 key in future) |
| `imageSha256` | Hex digest — drives **idempotent dedup** |
| `status` | `ReceiptStatus` state machine |
| `aiProvider` | Identifies which provider (Anthropic / Bedrock / OpenAI) handled it |
| `attemptCount` | Retry counter |
| `isDuplicate` / `duplicateOfId` | Self-referential FK to the original Receipt |
| `processingStartedAt` / `processingFinishedAt` | Latency tracking |
| `merchantName`, `occurredAt`, `subtotalPaise`, `taxPaise`, `tipPaise`, `totalPaise` | Extracted fields |
| `rawResponse` | `Json` — full AI response for debugging |
| `hint` | Free-form prompt nudge from the uploader |

Indexes:
- `(uploadedById, createdAt DESC)` — user's recent receipts
- `(groupId, createdAt DESC)` — group's recent receipts
- `(uploadedById, imageSha256)` — dedup lookup
- `(status)` — worker pickup

### 4.12 `ReceiptItem`

- `tags: String[]` (PostgreSQL array) — model-supplied tags like `"veg"`, `"alcohol"`, `"dessert"`.
- `sortOrder` preserves on-receipt order.
- Cascades on receipt delete.

### 4.13 `GuestSplit` — no-auth shareable bills

State machine: `CLAIMING → FINALIZED`.

| Column | Notes |
| --- | --- |
| `shareToken` | Unique `cuid()` — bearer URL token |
| `receiptId` | Unique (one-to-one with Receipt) |
| `groupId` | Set if attached to a group later |
| `expiresAt` / `finalizedAt` | Lifecycle timestamps |

### 4.14 `GuestSplitItem`

Same shape as `ReceiptItem` minus the tags array. Cascades on guest split delete.

### 4.15 `GuestSplitPerson`

- `claimToken` is unique — each guest claimant gets their own URL.
- `@@unique([guestSplitId, name])` — names must be unique within a split.

### 4.16 `GuestSplitAssignment`

- `@@unique([itemId, personId])` — one row per (item, person) pair.
- `shareUnits` lets a single item be split among multiple claimants.

### 4.17 `CommandRun` — NL command audit

Every voice/chat utterance is recorded with the full parse + tool-call trace + dry-run plan.

| Column | Notes |
| --- | --- |
| `source` | `"voice"` or `"chat"` |
| `status` | `CommandStatus` state machine |
| `utterance` | Raw user text |
| `contextGroupId` / `contextReceiptId` | Anchor entities (no FK — polymorphic) |
| `aiProvider` | Provider identifier |
| `parsedIntent` | `Json` — structured intent |
| `toolCallTrace` | `Json` — `[{call, result}, ...]` array of tool-use rounds |
| `plan` | `Json` — dry-run plan returned to user |
| `executionResult` | `Json` — populated after `EXECUTED` |
| `confirmedAt` / `executedAt` | Lifecycle timestamps |

Indexes: `(userId, createdAt DESC)`, `(status)`.

### 4.18 `Dispute` — Fairness Engine

Anyone with a share in an expense can flag it. The service first tries to auto-resolve from receipt data; otherwise it escalates to the splitter.

State machine: `OPEN → AUTO_RESOLVED | RESOLVED | REJECTED`.

| Column | Notes |
| --- | --- |
| `reason` | `@db.Text` — free-form reason |
| `payload` | `Json` — `{ itemNames: string[], paiseDelta?: int }` for ITEM/CONSTRAINT, or `{ paiseDelta: int }` for simpler disputes |
| `resolverId` | `User?` — the splitter who adjudicated |
| `resolution` | `@db.Text` — explanation |
| `newSharesPaise` | `Json` — snapshot of re-allocated shares |
| `resolvedAt` | Set when status leaves `OPEN` |

Indexes: `(expenseId)`, `(raisedById)`, `(status)`.

---

## 5. `AuditAction` Enum — full list

```
USER_REGISTERED        USER_LOGIN
GROUP_CREATED          GROUP_UPDATED         GROUP_ARCHIVED
MEMBER_ADDED           MEMBER_REMOVED
EXPENSE_CREATED        EXPENSE_UPDATED       EXPENSE_DELETED
SETTLEMENT_CREATED
INVITE_CREATED         INVITE_REDEEMED
RECEIPT_UPLOADED       RECEIPT_EXTRACTED     RECEIPT_CONVERTED
RECEIPT_DUPLICATE      RECEIPT_RETRIED
GUEST_SPLIT_CREATED    GUEST_SPLIT_FINALIZED
COMMAND_PARSED         COMMAND_CONFIRMED     COMMAND_EXECUTED
COMMAND_REJECTED       COMMAND_FAILED
DISPUTE_FLAGGED        DISPUTE_AUTO_RESOLVED DISPUTE_RESOLVED  DISPUTE_REJECTED
EXPENSE_REVISED
```

---

## 6. Entity Relationship Map

```
User ─┬─< RefreshToken
      ├─< Contact (owner)            ──► User? (linkedUser)
      ├─< GroupMember >── Group
      │                     │
      │                     ├─< GroupInvite
      │                     ├─< Expense ─┬─< ExpenseShare >── User
      │                     │            └─< Dispute ──► User (raisedBy / resolver)
      │                     ├─< Settlement (from / to → User)
      │                     ├─< Receipt ─< ReceiptItem
      │                     └─< GuestSplit ─┬─< GuestSplitItem ─< GuestSplitAssignment
      │                                     └─< GuestSplitPerson ─< GuestSplitAssignment
      ├─< AuditEvent (polymorphic entityId)
      ├─< CommandRun
      └─< Receipt (uploadedBy)
```

- Solid `>──`/`─<` arrows are FK relationships.
- `GuestSplit ↔ Receipt` is a **one-to-one** join (`receiptId` is `@unique`).
- `Receipt` has a **self-reference** for duplicate tracking (`duplicateOfId` → `Receipt.id`).
- `AuditEvent.entityId` is polymorphic — no FK; interpret it via `action`.

---

## 7. Cascade & Delete Semantics

| Parent | Child | On Parent Delete |
| --- | --- | --- |
| `User` | `RefreshToken`, `Contact (owner)`, `GroupMember`, `Receipt (uploadedBy)`, `GuestSplit (createdBy)`, `CommandRun`, `Dispute (raisedBy)` | `Cascade` |
| `User` | `Contact (linkedUser)`, `AuditEvent (actor)`, `Receipt (group)`, `Dispute (resolver)` | `SetNull` |
| `User` | `Expense (paidBy / createdBy)`, `ExpenseShare`, `Settlement (from / to)` | **No cascade** — protects financial history |
| `Group` | `GroupMember`, `Expense`, `Settlement`, `GroupInvite`, `GuestSplit`, `Receipt` | `Cascade` (Receipt = `SetNull`, GuestSplit = `SetNull`) |
| `Expense` | `ExpenseShare`, `Dispute` | `Cascade` |
| `Receipt` | `ReceiptItem`, `duplicates` (self) | `Cascade` / `SetNull` |
| `GuestSplit` | `GuestSplitItem`, `GuestSplitPerson` | `Cascade` |
| `GuestSplitItem` / `GuestSplitPerson` | `GuestSplitAssignment` | `Cascade` |

**Key invariant:** financial relations (`Expense`, `ExpenseShare`, `Settlement`) intentionally do **not** cascade from `User` — deleting a user does not erase their share of historical bills.

---

## 8. Index Inventory

Beyond unique constraints, the following secondary indexes exist:

| Table | Index | Purpose |
| --- | --- | --- |
| `User` | `(phone)` | Phone lookup |
| `RefreshToken` | `(userId)`, `(expiresAt)` | Per-user listing + expiry sweep |
| `Contact` | `(ownerId)`, `(linkedUserId)` | Owner feeds, reverse lookup |
| `GroupMember` | `(groupId)` | Member roster |
| `GroupInvite` | `(groupId)` | Invite listing |
| `Expense` | `(groupId, occurredAt DESC)`, `(paidById)` | Activity feed, payer queries |
| `ExpenseShare` | `(userId)` | "What do I owe across groups" |
| `Settlement` | `(groupId, settledAt DESC)`, `(fromId)`, `(toId)` | Settlement history |
| `AuditEvent` | `(actorId, createdAt)`, `(groupId, createdAt)`, `(action, createdAt)` | Multi-axis querying |
| `Receipt` | `(uploadedById, createdAt DESC)`, `(groupId, createdAt DESC)`, `(uploadedById, imageSha256)`, `(status)` | Feeds, dedup, worker pickup |
| `ReceiptItem` | `(receiptId)` | Item fetch |
| `GuestSplit` | `(createdById)`, `(shareToken)`, `(status)` | Owner list, token lookup, worker scans |
| `GuestSplitItem` | `(guestSplitId)` | Item fetch |
| `GuestSplitPerson` | `(guestSplitId)` | Person fetch |
| `GuestSplitAssignment` | `(itemId)`, `(personId)` | Both directions |
| `CommandRun` | `(userId, createdAt DESC)`, `(status)` | Personal history + worker pickup |
| `Dispute` | `(expenseId)`, `(raisedById)`, `(status)` | Expense view + worker pickup |

---

## 9. Conventions & Invariants

1. **Money:** every monetary field is `Int` paise, named `…Paise`. No `Decimal`, no `Float`. 1 INR = 100 paise.
2. **IDs:** all PKs are `String` `cuid()` — URL-safe, sortable, collision-resistant.
3. **Timestamps:** `createdAt` defaults to `now()`; `updatedAt` uses Prisma's `@updatedAt`.
4. **Soft delete:** **only** `Expense` carries `deletedAt`. Everything else hard-deletes via cascade.
5. **Tokens:** all user-facing tokens (`RefreshToken.tokenHash`, `GroupInvite.token`, `GuestSplit.shareToken`, `GuestSplitPerson.claimToken`) are either hashed or `cuid()`-random.
6. **Polymorphism:** `AuditEvent.entityId` and `CommandRun.context*Id` are polymorphic — no FK. Interpret via `action` / `parsedIntent`.
7. **JSON payloads:** `Json` columns are intentionally schemaless to support evolving AI outputs (`Receipt.rawResponse`, `CommandRun.parsedIntent/toolCallTrace/plan/executionResult`, `Dispute.payload/newSharesPaise`, `AuditEvent.metadata`).
8. **Naming:** plural relations (`expenses`, `members`); singular FKs (`paidById`, `groupId`).
9. **No multi-currency.** Per the top-of-schema comment: INR-only.

---

## 10. Where the DB is Used (Code Map)

Services that import `prisma` from `@/db/prisma`:

| Module | File |
| --- | --- |
| Auth | `src/modules/auth/auth.service.ts` |
| Groups | `src/modules/groups/groups.service.ts` |
| Expenses | `src/modules/expenses/expenses.service.ts` |
| Settlements | `src/modules/settlements/settlements.service.ts` |
| Balances | `src/modules/balances/balances.service.ts` |
| Contacts | `src/modules/contacts/contacts.service.ts` |
| Receipts | `src/modules/receipts/receipts.service.ts` |
| Guest | `src/modules/guest/guest.service.ts` |
| Commands | `src/modules/commands/commands.service.ts`, `commands.executor.ts` |
| Disputes | `src/modules/disputes/disputes.service.ts` |
| Health | `src/modules/health/health.routes.ts` |
| Me | `src/modules/me/me.routes.ts` |
| AI tools | `src/ai/tools/runner.ts` |
| Error handling | `src/middleware/error-handler.ts` (catches Prisma errors) |
| Bootstrap | `src/server.ts` |

---

## 11. Operational Notes / Gotchas

- **Empty `prisma/migrations/`** — schema is currently sync'd via `prisma db push`. Create a baseline migration before prod.
- **Connection pooling** — `PrismaClient` defaults to a small pool; under load consider `?connection_limit=N` on `DATABASE_URL`, or PgBouncer (with `?pgbouncer=true&connection_limit=1`).
- **Hot-reload safety** — `globalThis.__prisma` cache is critical with `tsx watch`; do **not** instantiate `new PrismaClient()` elsewhere.
- **Receipt dedup** — relies entirely on `imageSha256`; if the AI worker rehashes the image (e.g. after rotation), dedup misses.
- **Soft-deleted expenses** — services must filter `deletedAt: null` explicitly; Prisma does not do this for you.
- **Audit log growth** — `AuditEvent` is append-only and unbounded. Plan retention/archive before scale.
- **JSON columns** — typed as `unknown` in TypeScript; validate with `zod` before reading.
- **No row-level security** — all access control lives in service-layer middleware (`requireGroupMember`, etc.), not in Postgres.
