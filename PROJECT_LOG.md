# SliceSplit Backend — Project Log

End-to-end history of the `slicesplit-backend` service built for Slice Hackathon 2. This document is the canonical record of what was decided, what was built, why it looks the way it does, and what is still open.

---

## 1. Motivation

Slice is a mobile-first Indian fintech. The hackathon brief is to ship a credible "Splitwise for Slice" backend that can plug into the team's existing React frontend and (in PR 2) become a vehicle for an AI-powered receipt-scanning + bill-splitting demo.

We did not want to start from a blank page — the ShareTab open-source codebase already had three things we wanted: a battle-tested debt-simplification algorithm, a pluggable AI provider registry pattern, and a guest-split state machine. The brief was therefore:

> Borrow the *patterns* from ShareTab, build a fresh INR-native backend that is leaner and Slice-shaped, and ship PR 1 covering auth + groups + balance engine + Docker single-click. AI / guest splits go into PR 2.

---

## 2. Scope decisions

### What we kept from ShareTab (as patterns, not code)

| Pattern | Where it lands in our codebase |
| --- | --- |
| Greedy debt-simplification algorithm | `src/lib/balance-engine.ts` |
| `computeBalances` + `simplifyDebts` separation | same file, two pure functions |
| Pure-function balance engine with unit tests | `src/lib/balance-engine.test.ts` (16 tests) |
| Multi-stage Dockerfile + entrypoint bring-up | `docker/{Dockerfile,entrypoint.sh,docker-compose.yml}` |
| Prisma schema *shape* (Group / Expense / ExpenseShare / Settlement) | `prisma/schema.prisma` |
| AI provider registry pattern (deferred to PR 2) | — |
| Guest-split state machine (deferred to PR 2) | — |

### What we deliberately left behind

| Removed | Reason |
| --- | --- |
| Multi-currency + exchange rates | INR-only; we store paise as `Int`. Removes 30%+ of the balance engine complexity. |
| Venmo deep-links / `venmoUsername` field | Indian product → UPI is the rail. `User.upiHandle` replaces it. |
| Meridian / Google / NextAuth | We do simple JWT (access + rotating refresh, jti hashed). |
| Admin dashboard + `AdminAuditLog` | YAGNI for a hackathon. We kept a lean `AuditEvent` table for compliance / debugging. |
| Placeholder users | Replaced with `Contact` model — Slice's address-book model is contact-centric. |
| tRPC | Plain Express + JSON. Easier for the FE team and any partner integrations. |
| Next.js, shadcn, i18n, dark mode, Tailwind | Server-only project. The frontend is a separate codebase. |

---

## 3. Stack chosen and why

| Choice | Why |
| --- | --- |
| **TypeScript** strict mode + `noUncheckedIndexedAccess` | Catches array-access bugs at compile time; cheaper than runtime guards. |
| **Express 4** | Boring, well-understood, plays nicely with `pino-http` + `cors` + `helmet`. |
| **Prisma 5 + Postgres 16** | Type-safe ORM, painless migrations, alpine-friendly. |
| **Zod** | Same schema can validate body, query, and params. Drives our 400 responses. |
| **pino + pino-http** | Structured JSON logging with low overhead, secret redaction baked in. |
| **argon2id** | OWASP-recommended password hash, tuned via env (`ARGON2_*`). |
| **jsonwebtoken** | Mature, signs both access and rotating refresh tokens. |
| **helmet + cors allowlist** | Default headers + strict origin checks at the boundary. |
| **Vitest** | Same test API as Jest, faster cold start, native ESM. |
| **tsc + tsc-alias** | Plain compilation to CommonJS with `@/*` alias rewriting — no bundler needed. |

---

## 4. What was built (in order)

### Phase A — Repo & branch setup

- Created branch `phase2/db-selection` off `main` in the existing ShareTab repo (so the backend lives side-by-side with the reference codebase).
- Scaffolded `slicesplit-backend/` at the repo root.

### Phase B — Scaffolding

- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.dockerignore`, `.env.example`.
- Strict TS settings (`noUncheckedIndexedAccess`, `noImplicitOverride`).
- Build pipeline: `tsc → tsc-alias` to resolve `@/*` paths to relative requires in `dist/`.

### Phase C — Database (`prisma/schema.prisma`)

Models created:

- `User` — `email`, `phone`, `name`, `passwordHash`, `avatarUrl`, `upiHandle`, audit timestamps.
- `RefreshToken` — `userId`, `tokenHash` (SHA-256 of jti), `expiresAt`, `revokedAt`.
- `Contact` — owner-scoped address-book entry; nullable `linkedUserId` when the contact is also a platform user.
- `Group`, `GroupMember` (with `leftAt` soft-leave + `GroupRole` enum), `GroupInvite`.
- `Expense` (paise `Int`, `splitMode` enum, soft-delete via `deletedAt`), `ExpenseShare` (`amountPaise`, `shares`, optional `basisPoints`).
- `Settlement` — `fromId` / `toId` / `amountPaise` + freeform `method` (UPI / CASH).
- `AuditEvent` — append-only log keyed on action + actor + group.

Indices were chosen for the dominant access patterns: `(groupId, occurredAt desc)` for expense lists, `(userId, groupId)` unique for membership, `(actorId, createdAt)` / `(groupId, createdAt)` for audit queries.

### Phase D — Balance engine (`src/lib/`)

- **`money.ts`** — `rupeesToPaise`, `paiseToRupees`, `formatRupees` (Indian numbering), and `splitEqualPaise(total, parts)` that distributes the remainder one paise at a time so the chunks always sum exactly.
- **`balance-engine.ts`** — `computeBalances` and `simplifyDebts`; both pure; sorted deterministically (by `userId`).
- **Tests** — 25 in total (`money.test.ts` 9, `balance-engine.test.ts` 16). Includes regression checks against ShareTab's known apartment scenario, settlement zero-out, four-person complex chains, and the property "net sums to zero".

Optimizations over the ShareTab reference:
- Tie-broken by `userId` so output is deterministic for tests and UI.
- Removed the multi-currency branch (≈ 30 lines of float math + rounding logic).
- Renamed money fields to `*Paise` so the unit is obvious at the call site.
- `splitEqualPaise` guarantees `sum(parts) === total` even when the total isn't evenly divisible.

### Phase E — Foundations (`src/config`, `src/db`, `src/lib`, `src/middleware`)

- **`config/env.ts`** — Zod-validated env; refuses to start if `JWT_SECRET` is shorter than 32 chars.
- **`db/prisma.ts`** — singleton with dev-hot-reload guard.
- **`lib/logger.ts`** — pino with redaction paths covering `authorization`, `cookie`, `password`, `refreshToken`, `passwordHash`, `tokenHash`.
- **`lib/errors.ts`** — `HttpError` hierarchy: `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitedError`.
- **`lib/jwt.ts`** — access + refresh signers; `hashJti` for DB-side revocation.
- **`lib/password.ts`** — `hashPassword` / `verifyPassword` with argon2id.
- **`lib/rate-limit.ts`** — in-memory token-bucket with periodic GC.
- **`middleware/error-handler.ts`** — single funnel for `HttpError`, `ZodError`, `JsonWebTokenError`, `TokenExpiredError`, Prisma `P2002`, `P2025`.
- **`middleware/auth.ts`** — `requireAuth` extracts Bearer JWT → `req.user`.
- **`middleware/validate.ts`** — `validateBody`, `validateQuery`, `validateParams`, `asyncHandler`.
- **`middleware/rate-limit.ts`** — per-IP-per-route limiter; sets `X-RateLimit-*` headers.

### Phase F — Modules (`src/modules/`)

Each module follows `routes → service → schemas`.

- **`health`** — `/live`, `/ready` (DB ping via `SELECT 1`).
- **`auth`** — `/register`, `/login`, `/refresh`, `/logout`.
  - Refresh rotation: each refresh request revokes the previous DB row and issues a new one.
  - Login fall-through hashes a dummy password when the email is unknown, to flatten timing differences.
  - `AuditEvent` rows are written on register + login.
- **`me`** — `GET /me`, `PATCH /me` (name, avatarUrl, UPI handle).
- **`groups`** — `GET /` cursor-paginated, `POST /`, `GET /:id`, `PATCH /:id` (incl. archive toggle), `POST /:id/members`, `DELETE /:id/members/:userId`.
  - `requireMembership` + `requireAdmin` helpers in the service layer remove duplication across routes.
  - Member adds validate every `userId` exists in a single query.
  - `OWNER` role cannot be removed from the group.

### Phase G — App wiring

- **`app.ts`** — `helmet`, CORS allowlist (rejects unlisted origins), `express.json({ limit: '1mb' })`, `pino-http` with status-based log levels, `/api/v1` mount, `notFoundHandler`, `errorHandler`.
- **`server.ts`** — bootstraps the app, handles `SIGTERM` / `SIGINT` for graceful shutdown.

### Phase H — Docker single-click

- **`docker/Dockerfile`** — three stages: `deps`, `build` (Prisma generate + tsc), `runner` (alpine + dumb-init + openssl). Runs as the unprivileged `node` user.
- **`docker/entrypoint.sh`** — validates env, parses host/port out of `DATABASE_URL` via Node (so we don't ship `pg_isready`), waits for Postgres, runs `prisma migrate deploy` (or first-run `prisma db push`), execs the CMD. Idempotent.
- **`docker/docker-compose.yml`** — bundled Postgres 16-alpine service with `pg_isready` healthcheck, API depends on it being healthy. One command (`docker compose up --build`) brings everything online.

### Phase I — Postman collection

- **`postman/collections/slicesplit-backend.postman_collection.json`** — one collection with module folders mirroring `src/modules/`. Test scripts on Register / Login / Refresh auto-populate `access_token`, `refresh_token`, and `user_id` on the active env; collection-level Bearer auth pulls `{{access_token}}` so no manual header copying.
- **`postman/environments/local.postman_environment.json`** + **`docker.postman_environment.json`** — same keys, different base URLs.
- **`postman/examples/curl-cheatsheet.md`** — copy-paste curl alternative.
- **`postman/README.md`** — explains the folder structure and how validation + logging are surfaced.

---

## 5. Validation & logging policy

This service treats *every* HTTP boundary as untrusted.

- **Body** → `validateBody(schema)` (Zod).
- **Query** → `validateQuery(schema)`.
- **Params** → `validateParams(schema)`.
- **Headers** → `requireAuth` for any non-public route.

Failures throw `ZodError` / `HttpError` and are converted to JSON by `errorHandler`:

```
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
```

Logging:

- `pino` base instance is service-tagged (`{ service: "slicesplit-backend" }`).
- `pino-http` logs each request with `req.id`, method, path, status, response time.
- Log level is status-aware: 5xx → `error`, 4xx → `warn`, 2xx/3xx → `info`.
- Redacted fields: `Authorization` header, `Cookie` header, `req.body.password`, `req.body.refreshToken`, any `*.passwordHash`, any `*.tokenHash`.

---

## 6. Verification done at the end of PR 1

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | clean |
| Lint | `npm run lint` (max-warnings 0) | clean |
| Unit tests | `npm test` | 25 / 25 pass (money 9 + balance-engine 16) |
| Production build | `npm run build` | `dist/` emitted |
| App boot smoke | `node -e "require('./dist/app.js').createApp()"` | instantiates |
| Prisma client gen | `npx prisma generate` | OK |
| Postman JSON valid | `JSON.parse` round-trip | all three files OK |

---

## 7. Deferred to PR 2

| Item | Where it slots in |
| --- | --- |
| Expense + Settlement routes | New `src/modules/{expenses,settlements}/` using the existing balance engine + `splitEqualPaise`. |
| Contacts CRUD | `src/modules/contacts/` — owner-scoped; link to platform users on phone/email match. |
| AI provider registry (OpenAI / Claude / Ollama / mock) | `src/ai/{provider.ts,registry.ts,providers/*}` mirroring ShareTab's pattern. |
| Receipt extraction pipeline | `src/modules/receipts/` + `src/ai/prompts/receipt-extraction.ts`. |
| Guest-split state machine | `GuestSplit` Prisma model + `src/modules/guest/` with `CLAIMING → FINALIZED` transitions and share-token auth. |
| UPI deep-link generator | Small util in `src/lib/upi.ts`; surfaced on Settlement create. |
| Real Prisma migrations folder | Replace first-run `db push` with checked-in migrations. |
| Integration tests against a real Postgres | `vitest` + testcontainers, gated behind a flag. |
| Frontend wire-up | Out of scope here; this backend lives at `http://localhost:4000` and is CORS-allowlisted for the FE dev origin. |

---

## 8. Repo layout at end of PR 1

```
slicesplit-backend/
├── .dockerignore
├── .env.example
├── .gitignore
├── PROJECT_LOG.md            ← this file
├── README.md                 ← short, dev-onboarding-focused
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── entrypoint.sh
├── eslint.config.mjs
├── package.json
├── postman/
│   ├── README.md
│   ├── collections/
│   │   └── slicesplit-backend.postman_collection.json
│   ├── environments/
│   │   ├── docker.postman_environment.json
│   │   └── local.postman_environment.json
│   └── examples/
│       └── curl-cheatsheet.md
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app.ts
│   ├── config/
│   │   └── env.ts
│   ├── db/
│   │   └── prisma.ts
│   ├── lib/
│   │   ├── balance-engine.test.ts
│   │   ├── balance-engine.ts
│   │   ├── errors.ts
│   │   ├── jwt.ts
│   │   ├── logger.ts
│   │   ├── money.test.ts
│   │   ├── money.ts
│   │   ├── password.ts
│   │   └── rate-limit.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── error-handler.ts
│   │   ├── rate-limit.ts
│   │   └── validate.ts
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.schemas.ts
│   │   │   └── auth.service.ts
│   │   ├── groups/
│   │   │   ├── groups.routes.ts
│   │   │   ├── groups.schemas.ts
│   │   │   └── groups.service.ts
│   │   ├── health/
│   │   │   └── health.routes.ts
│   │   └── me/
│   │       └── me.routes.ts
│   ├── routes.ts
│   └── server.ts
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 9. Conventions for future contributors

- **Money** is always `Int` paise. The only float touchpoint is `src/lib/money.ts`. New code should never type a number that represents rupees without going through `rupeesToPaise`.
- **Modules** are self-contained: `routes.ts` (Express), `service.ts` (Prisma + business logic), `schemas.ts` (Zod). Routes never touch Prisma directly.
- **Errors** are thrown, never returned. Use the `HttpError` subclasses; `errorHandler` does the rest.
- **Validation** lives at the route — services trust their inputs.
- **Audit** any state-changing action by writing an `AuditEvent` inside the same transaction.
- **Tests** for pure logic (anything in `src/lib/`) are non-negotiable.

---

## 10. Timeline

| PR | Status | Highlights |
| --- | --- | --- |
| PR 1 — backend foundation | ✅ shipped | TS+Express+Prisma+JWT, balance engine ported with 25 tests, Docker single-click, Postman collection |
| PR 2 — domain features + AI + guest splits | ✅ shipped | expense/settlement/balance routes, contacts, UPI deep-links, AI provider registry + receipt pipeline, guest-split state machine |
| PR 3 — Claude/Bedrock + NL command layer + tools + OCR hardening | ✅ shipped | Anthropic + Bedrock providers behind a common interface, AI-tools layer ("skills"), implicit-constraint NL command pipeline, CONSTRAINT split mode, async receipt OCR with SHA-256 dedup + retry/backoff + sanitization, 58 tests |

---

## 11. PR 2 — what was added

PR 2 fills in the domain features the hackathon demo runs on.

### A. New libs

- **`src/lib/upi.ts`** — UPI deep-link generator (`upi://pay?...`). Validates VPAs (`alice@okhdfc` style), formats amount as 2-decimal rupees on the wire while keeping paise internal. Tested.
- **`src/lib/split-calculator.ts`** — Pure split engine for all `SplitMode`s. Guarantees `sum(shares) === total`:
  - `EQUAL` — uses `splitEqualPaise`, distributes remainder to leading users sorted by `userId`.
  - `EXACT` — validates user shares sum to total.
  - `PERCENTAGE` — basis-points (10000 = 100%), proportional with remainder distribution.
  - `SHARES` — share-unit weights, proportional with remainder distribution.

### B. Domain modules added (`src/modules/`)

| Module | Routes |
| --- | --- |
| `expenses/` | `GET / POST` (list, create) and `GET / PATCH / DELETE /:expenseId` under `/groups/:groupId/expenses` — soft-delete, transactional share replacement on update, only payer / creator / admin can delete. |
| `settlements/` | `GET / POST` under `/groups/:groupId/settlements` — validates both parties are active group members. |
| `balances/` | `GET /groups/:groupId/balances` — runs the engine + `simplifyDebts`, attaches a `upiIntent` deep-link for every transfer whose recipient has set a UPI handle. |
| `contacts/` | Owner-scoped address-book CRUD. Auto-links contacts to platform users when phone/email matches an existing user. |
| `receipts/` | `POST /receipts/extract` (multipart upload → AI provider → structured items), `GET /receipts`, `GET /receipts/:id`, `POST /receipts/:id/convert` (turns a receipt into a real Expense). |
| `guest/` | Authenticated owner routes under `/guest-splits` + public share-token routes under `/g/:shareToken`: add person → claim items → finalize. The finalize step computes per-person totals including proportional tax/tip allocation. |

### C. AI provider layer (`src/ai/`)

- **`types.ts`** — `ReceiptExtractor` interface, `ExtractedReceipt` DTO. Provider-agnostic.
- **`prompts/receipt-extraction.ts`** — Single source of truth for the extraction system prompt. Embedded by concrete providers in whatever format they need (chat message, tool call, etc).
- **`providers/mock.ts`** — Always available; returns canned data. Used in dev + tests.
- **`providers/openai.ts`** — Real OpenAI chat-completions call with JSON mode, `gpt-4o-mini` default, no SDK dependency (raw `fetch`). Disabled unless `OPENAI_API_KEY` is set.
- **`registry.ts`** — Picks a provider based on `AI_PROVIDER_PRIORITY` env (default `openai,mock`); falls back to mock so the demo always works. Caches the pick.

### D. Prisma schema additions

- `Receipt` + `ReceiptItem` — extracted line items + status machine (`PENDING → PROCESSING → COMPLETED|FAILED`), stores AI provider name and raw response for audit.
- `GuestSplit` + `GuestSplitItem` + `GuestSplitPerson` + `GuestSplitAssignment` — guest-split state machine (`CLAIMING → FINALIZED`), token-scoped access via `shareToken` (public) and per-person `claimToken` (private).
- New `AuditAction` enum entries: `RECEIPT_UPLOADED`, `RECEIPT_EXTRACTED`, `RECEIPT_CONVERTED`, `GUEST_SPLIT_CREATED`, `GUEST_SPLIT_FINALIZED`.

### E. Config + tooling

- **`env.ts`** — new fields: `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `AI_PROVIDER_PRIORITY`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
- **`.env.example`** — documents the new env block.
- **`vitest.setup.ts` + `vitest.config.ts:env`** — injects test-safe env vars so test files transitively importing `@/config/env` don't crash on missing config.

### F. Postman collection expansion

Added folders: **Expenses** (with one example per split mode), **Settlements**, **Balances**, **Contacts**, **Receipts** (incl. multipart `/extract`), **Guest Splits (Owner)**, **Guest Splits (Public)**. Test scripts auto-capture `expense_id`, `contact_id`, `receipt_id`, `guest_split_id`, `share_token`, `claim_token`. New env keys added to both environments.

### G. Tests added (vitest)

Pure-function coverage only — DB tests come with testcontainers in PR 3.

| File | Tests |
| --- | --- |
| `src/lib/split-calculator.test.ts` | 11 — every mode + guardrails |
| `src/lib/upi.test.ts` | 7 — VPA validation + URI encoding |
| `src/ai/registry.test.ts` | 4 — provider selection + cache |
| `src/modules/guest/guest.service.test.ts` | 3 — proportional split math |

Cumulative: **50 / 50 tests pass** (PR 1 carryover + PR 2 additions).

### H. Optimizations over the ShareTab reference

- Pure split calculator separated from expense-creation transaction — easy to unit test and reuse for receipts.
- Remainder distribution is done with a deterministic `userId.localeCompare` sort across all split modes — outputs are stable across servers and test runs.
- Provider registry caches its pick instead of re-resolving on every extract call.
- OpenAI provider uses native `fetch` + JSON mode, so the build stays slim and there's no SDK to keep on the latest version.
- Guest-split finalize allocates tax/tip proportionally with the same paise-preserving remainder logic — guarantees no rupee is lost.
- Receipts hide existence (`404` instead of `403`) when accessed by non-owner — small but matters for not leaking IDs.

---

## 12. PR 3 — Claude/Bedrock, NL command layer, tools layer, OCR hardening

PR 3 aligns the backend with the **SliceLab 3.0 proposal** (the SliceSplit
"Snap it. Say it. Split it. Settled." deck). Each block below cross-references
the proposal section it implements.

### 12A. AI provider layer is now agnostic — Claude / Bedrock primary

Implements proposal §07 (Architecture: Claude on AWS Bedrock as the agentic
core; backend kept inside slice's VPC).

- `src/ai/types.ts` — split the AI surface into two narrow interfaces:
  - `ReceiptExtractor` (image → `ExtractedReceipt`)
  - `IntentParser` (utterance + tools → `ParsedIntent`)
- `src/ai/providers/anthropic.ts` — direct Anthropic SDK (`@anthropic-ai/sdk`). Implements both interfaces. Cost-aware routing: `claude-3-5-haiku-20241022` for receipts (fast), `claude-3-5-sonnet-20241022` for intent parsing (deep).
- `src/ai/providers/bedrock.ts` — `@aws-sdk/client-bedrock-runtime` via the `Converse` API which has first-class tool-use, so the same `IntentParser` interface drops in. Default IDs are the US cross-region inference profiles.
- `src/ai/providers/mock.ts` — extended to implement `IntentParser` too, with a small rule-based pseudo-parser that handles the "split this bill … veg" and "balance" utterances offline.
- `src/ai/providers/openai.ts` — kept for receipt extraction only (legacy fallback).
- `src/ai/registry.ts` — two independent caches (`getReceiptExtractor()`, `getIntentParser()`). Default `AI_PROVIDER_PRIORITY` = `bedrock, anthropic, openai, mock`.

### 12B. Tools / skills layer — `src/ai/tools/`

This is the surface a subagent or any future tool-use call pulls from. Each tool is a typed function exposed via JSON Schema; the runner enforces caller ownership rules.

| Tool | Purpose |
| --- | --- |
| `get_current_user` | resolve "me / I / my" |
| `resolve_mention` | map a name / @handle / phone / email to a real userId; returns ambiguity when there are duplicates |
| `get_my_groups` | the caller's active groups |
| `get_group_members` | active members of a group, including UPI handle |
| `get_my_contacts` | address-book search |
| `get_receipt_items` | line items + tags from an extracted receipt |
| `categorize_items` | tag a name list with `veg / non-veg / alcohol / dessert / starter / main / beverage / other` |
| `get_recent_expenses` | time-scoped queries ("everything I paid this week") |
| `get_group_balances` | per-member balances + simplified transfers |
| `get_expense` | individual expense + shares for explanation |

Hard design rules:
- Tools **only read or classify** — they never mutate.
- The runner strips private fields (`passwordHash`, `tokenHash`) from every payload returned to the model.
- Errors come back as `{ isError: true, content: { error } }` so the model can recover instead of the whole call failing.

### 12C. NL Command pipeline — `src/modules/commands/`

Implements proposal §02 / §06 / §07: one brain, two doors (voice + chat converge to the same command pipeline; voice STT happens client-side via Amazon Transcribe and we accept the transcript).

Two-stage by design rule ("anything that moves money requires an explicit confirmation tap"):

1. `POST /api/v1/commands` — body `{ utterance, source: "voice" | "chat", contextGroupId?, contextReceiptId? }`. Calls the configured `IntentParser`, which loops with the tools registry until it returns a `ParsedIntent`. Returns `{ commandRunId, intent, plan }`.
2. `POST /api/v1/commands/:id/confirm` — executor (`commands.executor.ts`) turns the intent into real writes via existing services (`groups.createGroup`, `expenses.createExpense`, `settlements.createSettlement`, `balances.getGroupBalances`).
3. `POST /api/v1/commands/:id/reject` — closes as REJECTED.
4. `GET /api/v1/commands` + `GET /api/v1/commands/:id` for history and inspection.

Every step writes to `CommandRun` and an `AuditEvent`. The `toolCallTrace` field stores every tool call + result the model made, so a session is fully replayable.

Intents currently supported: `CREATE_GROUP`, `ADD_MEMBERS`, `CREATE_EXPENSE` (with EQUAL / EXACT / PERCENTAGE / SHARES / **CONSTRAINT**), `CREATE_SETTLEMENT`, `QUERY_BALANCE`, `EXPLAIN_EXPENSE`, `REJECT`.

### 12D. Implicit constraint inference — the "Mohit veg" case

Implements proposal §02 ("Constraint-aware splitting") and §04 ("Fairness Engine — AI is the translator, never improvises numbers").

Example utterance:

> *"split this bill between @kartik @sukant @mohit and make sure mohit is veg"*

Pipeline:

1. Tool round 1: `resolve_mention(@kartik)`, `(@sukant)`, `(@mohit)` → real userIds.
2. Tool round 2: `get_receipt_items(receiptId)` → item list with paise.
3. Tool round 3: `categorize_items(items)` → tags `veg / non-veg / alcohol / ...`.
4. Model emits a `CREATE_EXPENSE` intent with `split.mode = CONSTRAINT`, listing items with their tags and Mohit's `allow: ["veg", "beverage"]`.
5. The user confirms → executor calls `expenses.createExpense` → service calls `calculateShares` → **the deterministic engine** assigns items to eligible participants, distributes tax/tip proportionally, and writes the `ExpenseShare` rows. Sum is guaranteed to equal `totalPaise`.

The proposal's design rule is enforced in code: the model only produces the *plan*; the engine produces the *numbers*.

### 12E. `CONSTRAINT` split mode — `src/lib/split-calculator.ts`

A new mode added to the deterministic split engine:

```ts
{
  mode: "CONSTRAINT",
  totalPaise: 97_175,
  items: [
    { name: "Veg Pizza",       totalPaise: 45_000, tags: ["veg"] },
    { name: "Chicken Tikka",   totalPaise: 28_500, tags: ["non-veg"] },
    { name: "Iced Latte",      totalPaise: 11_000, tags: ["veg", "beverage"] },
  ],
  participants: [
    { userId: "kartik" },
    { userId: "sukant" },
    { userId: "mohit",  allow: ["veg", "beverage"] },
  ],
  commonItemsPaise: 12_675,   // tax + tip — distributed proportionally
}
```

Algorithm:
1. For each item, compute the eligible set (participants whose `allow` permits at least one of the item's tags AND whose `deny` doesn't reject any). Split the item's paise equally among them.
2. Each participant's subtotal is the sum of slices they got.
3. Distribute `commonItemsPaise` proportionally over those subtotals.
4. Hard guarantees:
   - `sum(items.totalPaise) + commonItemsPaise === totalPaise` (or the calculator throws).
   - `sum(shareDrafts.amountPaise) === totalPaise` exactly.
   - Empty `allow: []` is treated as "no restriction", not "nothing allowed", to keep the API forgiving.

### 12F. Production-ready OCR pipeline — `src/modules/receipts/`

Implements proposal §08 (Scalability: async + decoupled + cost-aware + retryable) and §09 (Edge cases: handwritten, duplicates, low-confidence flagging).

Hardening pass:

| Concern | Implementation |
| --- | --- |
| Idempotency / dedup | `imageSha256` column on `Receipt` (`createHash("sha256")` in `src/lib/sha256.ts`). Re-uploading the same bytes within 24h returns the existing receipt with `wasDuplicate: true` and HTTP 200 instead of 202. |
| Async processing | `POST /receipts/extract` writes the row, returns HTTP **202 Accepted** with `status: PENDING` immediately, kicks off `runExtraction()` via `setImmediate()`. FE polls `GET /:id`. |
| Status machine | `PENDING → PROCESSING → COMPLETED \| FAILED`, with `processingStartedAt` / `processingFinishedAt` / `attemptCount` columns for observability. |
| Retry with backoff | Up to 3 attempts, backoff `[500ms, 2000ms, 5000ms]`. Every retry writes a `RECEIPT_RETRIED` audit event. |
| Sanitization | `src/modules/receipts/receipts.sanitizer.ts` enforces `quantity ≥ 1`, `totalPaise === quantity × unitPaise`, `totalPaise ≥ sum(items)`, and tags filtered against the closed `ALLOWED_TAGS` set. Warnings logged. |
| Item replacement on retry | Inside the success transaction we `deleteMany` previous items so partial state from a previous attempt can't leak. |
| Failure terminality | Terminal `FAILED` with `errorReason` (truncated) so the FE can surface a real message instead of "something went wrong". |

### 12G. Schema additions

- `Receipt`: `imageSha256`, `attemptCount`, `isDuplicate`, `duplicateOfId`, `processingStartedAt`, `processingFinishedAt`, `errorReason`, `hint`. Plus a `(uploadedById, imageSha256)` index for dedup lookups and a status index.
- `ReceiptItem.tags`: `String[] @default([])` — model-supplied tags consumed by CONSTRAINT splits.
- `SplitMode`: new `CONSTRAINT` value.
- `CommandRun` model + `CommandStatus` enum.
- `AuditAction`: `RECEIPT_DUPLICATE`, `RECEIPT_RETRIED`, `COMMAND_PARSED`, `COMMAND_CONFIRMED`, `COMMAND_EXECUTED`, `COMMAND_REJECTED`, `COMMAND_FAILED`.

### 12H. New env

- `ANTHROPIC_API_KEY`, `CLAUDE_RECEIPT_MODEL`, `CLAUDE_INTENT_MODEL`
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_RECEIPT_MODEL_ID`, `BEDROCK_INTENT_MODEL_ID`
- Default `AI_PROVIDER_PRIORITY` is now `bedrock, anthropic, openai, mock`.

### 12I. Tests added

| File | Tests |
| --- | --- |
| `src/lib/split-calculator.constraint.test.ts` | 8 — "Mohit-veg" scenario, deny lists, error paths |

Cumulative: **58 / 58 tests pass**.

### 12J. Postman additions

- **Receipts (async OCR)** folder reworked for the async flow — 202 response, poll endpoint, dedup assertion.
- **Commands (NL: voice + chat)** folder with one request per canonical utterance pattern from proposal §03:
  - Dietary CONSTRAINT split (the showstopper).
  - Create + populate group.
  - Balance query.
  - Voice transcript (custom ratio).
  - Settle query.
  - Explain my split.
  - Get / Confirm / Reject / List endpoints.
- New env keys: `command_run_id`.

### 12K. What deliberately wasn't built in PR 3

- PII redaction (per your direction — moved out of PR 3).
- Real slice Pay / UPI Collect rails (deferred to PR 4 once slice access lands).
- atom Split-to-Save adapter (PR 4).
- Frontend wire-up inside the slice app (PR 5).

### 12L. Proposal-section coverage map

| Proposal § | Covered in PR | Notes |
| --- | --- | --- |
| §02 Core loop step 1 (Capture) | PR 2 + PR 3 hardening | Async + dedup ready |
| §02 Core loop step 2 (Understand) | PR 3 | Anthropic + Bedrock intent parsing |
| §02 Core loop step 3 (Split) | PR 1 + PR 2 + PR 3 | All 5 modes; CONSTRAINT new |
| §02 Core loop step 4 (Settle) | PR 2 | UPI deep-link; real rails in PR 4 |
| §02 Core loop step 5 (Track / explain / save) | PR 2 + PR 3 | Balances + EXPLAIN_EXPENSE intent |
| §03 Command patterns | PR 3 | 6 of 8 are demoable today via the mock + real provider |
| §03 Bill & split intelligence | PR 3 | Tag-aware split + sanitizer + dedup |
| §04 Fairness engine | PR 3 (partial) | EXPLAIN_EXPENSE wired; dispute loop is PR 4 |
| §05 Split-to-Save (atom) | — | PR 4 |
| §06 User flow | PR 3 | "show plan → confirm → fire" enforced by two-stage commands |
| §07 Architecture | PR 3 | Bedrock + Anthropic primary, mock fallback |
| §08 Scalability | PR 3 (partial) | Async + retry + dedup; queue-based fanout is a PR 4 nice-to-have |
| §09 Edge cases | PR 3 (most) | Dedup, low-confidence handling via sanitizer warnings, mid-trip member rules handled by `leftAt` |
| §12 Compliance & security | — | PR 4 (you put PII redaction on hold; rest stays) |
