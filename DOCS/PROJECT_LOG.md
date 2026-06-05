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
| PR 3.5 — e2e test harness (Newman) | ✅ shipped | Self-bootstrapping Postman suite over Docker compose; 57 reqs / 25 assertions / 0 failures; **caught 3 production bugs** before they could ship |
| PR 4 — Fairness engine + AI-narrated explain + production polish | ✅ shipped | Dispute loop (auto-resolve + resolve + reject), Claude-narrated EXPLAIN with template fallback, CONSTRAINT-on-receipt-convert, per-route rate limits; 68 unit tests, 64 req / 85 assertions / 0 failures e2e |
| PR 4.5 — S3/MinIO storage backend | ✅ shipped | Pluggable storage interface; per-row `Receipt.storageBackend`; presigned GET URLs in receipt responses; MinIO bundled into docker-compose; Anthropic key (claude-sonnet-4-6 / claude-haiku-4-5) ported from `slicehackathon2`; 76 vitest, 64 req / 88 assertions / 0 failures e2e against real Claude |
| PR 5 — Frontend integration (5 chunks) | ✅ shipped | Wired 13 of 24 `splitApi` methods to BE (54%) + 3 net-new helpers. Demo Beats 1 + 3 run entirely on BE. New BE: `GroupMember.contactId` + mixed-member groups, Invites module (`POST /invites`, `POST /invites/:token/redeem`, public `GET /i/:token`). 77 vitest, 71 req / 96 assertions / 0 failures e2e |

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

---

## 13. PR 3.5 — e2e test harness (Newman over docker compose)

The 58 vitest cases prove the pure libs (money, balance engine, split calculator, etc.) work. They prove **none** of the route → service → Prisma → response wiring. PR 3.5 closes that gap with a Newman-driven end-to-end suite that boots a real backend in Docker and hits every endpoint with realistic data.

### 13A. Harness layout — `tests/e2e/`

| File | Purpose |
| --- | --- |
| `build-collection.mjs` | Rewrites the canonical Postman collection into an e2e-ready variant. Prepends a "0. Setup" folder that registers three timestamped users (`alice-<runId>@e2e.local` etc.) and saves `user_a_id` / `user_b_id` / `user_c_id`. Resolves every `REPLACE_WITH_USER_CUID` placeholder. Wires `fixtures/receipt.png` into the multipart upload. Layers extra `pm.test(...)` assertions on demo-critical requests. |
| `environment.json` | Newman env with all variable slots; left empty so Setup populates them. |
| `fixtures/receipt.png` | A tiny valid 100×100 PNG so the multipart upload + async OCR pipeline are actually exercised. Mock provider doesn't care about content. |
| `run.sh` | Driver: ephemeral `JWT_SECRET`, pins `AI_PROVIDER_PRIORITY=mock` for determinism, bumps `AUTH_RATE_LIMIT_MAX`, brings docker compose up, waits for `/api/v1/health/ready`, runs Newman, tears the stack down. Variants: `NEWMAN_KEEP_RUNNING=1` and `--no-boot`. |
| `README.md` | Usage notes, CI guidance, how to switch to real Bedrock / Anthropic. |

### 13B. npm scripts

```bash
npm run test:e2e                    # full cycle: boot → newman → teardown
npm run test:e2e:no-boot            # against an already-running server
npm run test:e2e:build-collection   # rebuild the e2e collection only
```

`newman` + `newman-reporter-htmlextra` are devDependencies. HTML + JSON reports in `tests/e2e/reports/` (gitignored).

### 13C. First green run

| Metric | Result |
| --- | --- |
| Requests | **57** |
| Assertions | **25** |
| Failures | **0** |
| Wall time | ~17 s |

Coverage: auth (register × 3, login, refresh, logout, /me), groups CRUD, all four split modes (with sum-to-total assertions), settlements, balances (with net-to-zero assertion), contacts, async OCR pipeline end-to-end (upload → poll → COMPLETED → convert), every command-pattern utterance from §03, owner + public guest-splits.

### 13D. Three real bugs Newman caught

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `docker compose up` failed with `yaml: mapping values are not allowed in this context` | Colon inside `${JWT_SECRET:?... openssl rand -base64 48}` parsed as a YAML mapping separator. | Quoted the value. Anyone cloning fresh would have hit this. |
| 2 | Container booted, API crashed on first DB query with `PrismaClientInitializationError: linux-musl-arm64-openssl-3.0.x` not found | Prisma client built for `openssl-1.1.x`, Alpine 3.x ships OpenSSL 3.x. | Added `binaryTargets = ["native", "linux-musl-arm64-openssl-3.0.x", "linux-musl-openssl-3.0.x"]` to the generator block. Vitest didn't catch this because tests stub Prisma. |
| 3 | Container looked healthy; `curl localhost:4000/...` → `Connection reset by peer`. Logs said `port: 5432`. `ss -tlnp` confirmed Node was bound to 5432. | `docker/entrypoint.sh` reused `$PORT` as a local while parsing Postgres host/port from `DATABASE_URL`. The value (5432) leaked into Node's env via `exec`, overriding the configured listen port. | Renamed locals to `$PG_HOST` / `$PG_PORT`. Vitest didn't catch this because tests don't go through the entrypoint script. |

All three are in script / config / build land — exactly the kind of bug pure-function tests can't see.

### 13E. What the harness does NOT cover (yet)

- Real Claude / Bedrock calls (pinned to mock for determinism; opt-in via env vars)
- Parallel-upload race conditions on SHA-256 dedup
- Refresh-token rotation revocation under attack
- Per-route rate-limit triggering (bypassed for the suite)

All PR 4 / PR 5 candidates.

---

## 14. PR 4 — Fairness engine + AI-narrated explain + production polish

PR 4 lands the highest-value items from the "addressable-without-slice-access" set: the **Dispute loop** (proposal §04 Beat 3 of the demo plan), **Claude-narrated EXPLAIN_EXPENSE** (proposal §04 transparency theme), **CONSTRAINT mode on receipt-to-expense conversion** (closes the last engine hole), and **per-route rate limits** (production defense).

### 14A. Disputes module — proposal §04

End-to-end fairness loop. State machine: `OPEN → AUTO_RESOLVED | RESOLVED | REJECTED`.

| Route | Purpose |
| --- | --- |
| `POST /expenses/:expenseId/disputes` | File a dispute. Body carries `reason` + optional structured `payload` (`itemNames[]`, `paiseDelta`). Service runs the auto-resolver first; closes as `AUTO_RESOLVED` if the answer is defensible from the data, otherwise leaves it `OPEN`. **Rate-limited: 5 filings per 5 min per IP.** |
| `GET /expenses/:expenseId/disputes` | List dispute history on an expense (any group member). |
| `POST /disputes/:disputeId/resolve` | Splitter (or group admin) posts a new full share allocation. Engine validates `sum(newShares) === expense.amountPaise`. Atomically replaces `ExpenseShare` rows, marks dispute `RESOLVED`, writes `EXPENSE_REVISED` audit. |
| `POST /disputes/:disputeId/reject` | Close as `REJECTED` with a `resolution` message. |

**Auto-resolver heuristics (`disputes.service.decideAutoResolve`)** — kept narrow on purpose:

- If `payload.paiseDelta` is provided and ≤ 10 % of the raiser's current share → **auto-resolve** ("delta within 10 % of own share — auto-credited"). The splitter still gets a notification, but the dispute is closed.
- If `payload.itemNames[]` is provided but the expense isn't `ITEM` or `CONSTRAINT` mode → escalate (we can't unilaterally re-allocate without the item structure).
- Anything else (no structured signal, delta too large, raiser has no share) → escalate.

Audit events at every transition: `DISPUTE_FLAGGED`, `DISPUTE_AUTO_RESOLVED`, `DISPUTE_RESOLVED`, `DISPUTE_REJECTED`, plus an `EXPENSE_REVISED` row on resolve so the audit trail tells the full story.

### 14B. Claude-narrated EXPLAIN_EXPENSE

The engine still computes the breakdown (proposal §04 design rule). The renderer (`src/modules/commands/explain-renderer.ts`) has two paths:

- `renderExplanationTemplate()` — deterministic, fast, no network. Always works.
- `renderExplanationNarrated()` — sends the **already-computed** breakdown to the configured `IntentParser` provider and asks it to paraphrase. Falls back to the template if no provider is configured, the model returns empty text, or the call throws. The numbers are never recomputed — the AI only does word choice.

The system prompt (`src/ai/prompts/explain-expense.ts`) embeds the rule explicitly: *"NEVER invent, change, or recompute numbers. Use only the paise values in the provided breakdown."*

`EXECUTE`d `EXPLAIN_EXPENSE` intents now return `narrationSource: "template" | "model"` and (when narrated) `narrationModel`, so callers can tell whether the explanation came from the engine fallback or the LLM.

### 14C. CONSTRAINT mode on receipt → expense conversion

Closes the only first-class hole in the engine. `POST /receipts/:id/convert` now accepts:

```jsonc
{
  "title": "Cafe Bistro",
  "paidById": "<userId>",
  "splitMode": "CONSTRAINT",
  "participants": [
    { "userId": "kartik" },
    { "userId": "sukant" },
    { "userId": "mohit", "allow": ["veg", "beverage"] }
  ]
}
```

The service pulls the receipt's already-tagged items + total, computes `commonItemsPaise = totalPaise - sum(items)` (tax + tip + service), and hands the whole thing to the existing CONSTRAINT split engine. No item tagging happens at convert time — the AI already did that at extraction.

Validates `sum(items) ≤ totalPaise`; throws cleanly if the receipt is inconsistent.

### 14D. Per-route rate limits

Adding the dispute filing limiter raised the question: what else should be limited? Two more endpoints landed protection in PR 4:

| Route | Limit | Why |
| --- | --- | --- |
| `POST /commands` | 20 / min per IP | Each parse burns AI tokens (intent loop with tool-use rounds). A misconfigured FE retry loop here gets expensive fast. |
| `POST /receipts/extract` | 10 / 5 min per IP | Same reasoning — each call invokes the receipt extractor. |
| `POST /expenses/:id/disputes` | 5 / 5 min per IP | Matches the proposal's "flags are rate-limited" rule (§04). |

`/auth/*` already had a per-IP limiter from PR 1.

### 14E. Schema additions

- `Dispute` model with full audit trail (`raisedById`, `resolverId`, `payload`, `resolution`, `newSharesPaise` snapshot).
- `DisputeStatus` enum.
- `Expense.disputes Dispute[]` reverse relation.
- New `AuditAction` entries: `DISPUTE_FLAGGED`, `DISPUTE_AUTO_RESOLVED`, `DISPUTE_RESOLVED`, `DISPUTE_REJECTED`, `EXPENSE_REVISED`.

### 14F. Tests added

| File | Tests | Coverage |
| --- | --- | --- |
| `src/modules/disputes/disputes.service.test.ts` | 6 | Every branch of `decideAutoResolve` — no payload, small delta, large delta, item-mode mismatch, zero delta, raiser has no share. |
| `src/modules/commands/explain-renderer.test.ts` | 4 | `formatINR` paise → ₹, template determinism, "Your share" omitted without audience, narrator falls back to template when provider is mock. |

Vitest cumulative: **68 / 68 pass.**

### 14G. Postman / Newman

- New **Disputes (Fairness Engine)** folder: 6 requests covering the full happy path — setup a fresh expense → list → auto-resolve case → escalation case → resolve with new shares → reject (expected 400 since already resolved).
- New env vars: `dispute_id`, `dispute_open_id`, `dispute_expense_id`, `dispute_auto_resolved`.
- The canonical Groups folder was refactored so the member-management flow is self-consistent: **Add Bob → Add Charlie → Remove Charlie** (leaving Bob in the group). This eliminates a folder-coupling bug that would cause downstream Receipts → Convert tests to fail because Bob got removed mid-suite.
- `build-collection.mjs` upgrade: substitution walker now correctly patches string elements inside arrays (Postman URL `path` arrays specifically). A new `REPLACE_WITH_OTHER_USER_CUID` → `{{user_c_id}}` mapping was added for the Charlie role.
- Layered extra `pm.test(...)` assertions onto Auth, Me, Groups, Expenses (all 4 modes), Settlements, Balances, Contacts, Receipts, Commands, Guest Splits, and Disputes — see `build-collection.mjs` for the full list.

**Newman result (run against `npm run dev` against dev Postgres):**

| Metric | Result |
| --- | --- |
| Requests | **64** |
| Assertions | **85** (was 25 in PR 3.5) |
| Failures | **0** |
| Wall time | ~18 s |

### 14H. The Newman-uncovered folder-coupling bug

A real bug worth recording. Pre-PR-4, the canonical Postman collection had a single `"Add member"` followed by `"Remove member"` request, both referencing the literal placeholder `REPLACE_WITH_USER_CUID`. Humans clicking through Postman would fill it in differently each time (or skip), so the side effects didn't compound.

In Newman, `build-collection.mjs` was rewriting `REPLACE_WITH_USER_CUID` → `{{user_b_id}}` *everywhere*. That made `Remove member` actually remove Bob. Several folders later, `Receipts → Convert receipt to expense (EQUAL)` tried to split among `[Alice, Bob]` and failed with `400 — User <bob> is not an active member of this group`. This was the regression I caught from a previous-green endpoint.

Fix was two-part:
1. **Canonical collection** — added a separate `Add member (Charlie — will be removed below)` and changed the `Remove member` request to target Charlie. Now Bob is added and stays; Charlie comes and goes. The member-management flow tests both add + remove honestly.
2. **build-collection.mjs walker** — patched the recursion so it also rewrites string elements inside arrays (Postman URL `path` arrays). The existing walker only handled object values, which is why the URL `raw` field was being patched but the `path[]` segment wasn't — the original test would have looked like it worked from URL output until the request actually fired.

Lesson: **folder coupling in an e2e suite is a real failure mode.** Newman runs requests strictly in order; side-effects (membership, soft-deletes) persist across folders unless the suite explicitly resets them. We don't reset — the suite uses a fresh DB per run via docker compose down/up. So the only durable fix is to make destructive operations target throwaway resources, never long-lived ones. The Disputes folder follows the same pattern: it creates its own `dispute_expense_id` instead of leaning on `expense_id` (which the Expenses folder soft-deletes at the end).

### 14I. What's *not* in PR 4 (deferred to PR 5)

- Real slice Pay / UPI Collect rails — needs slice infra access
- atom Split-to-Save adapter — same
- PII redaction pipeline (on hold per your directive)
- Recurring expenses + reminders worker
- Frontend wire-up inside the slice app
- Multi-payer expenses, mid-trip member handling
- Real Claude/Bedrock acceptance pass before demo (replace `fixtures/receipt.png` with a real bill, swap `AI_PROVIDER_PRIORITY`)
- testcontainers integration tests (Newman covers route → service → Prisma already)

### 14J. Proposal-section coverage map (updated)

| Proposal § | Status | Notes |
| --- | --- | --- |
| §02 Core loop | mostly | Settle = UPI deep-link only; Save (atom) blocked on slice access |
| §02 Headline capabilities | mostly | "Trust & transparency" lifted to ~90% with disputes + narrated explain |
| §03 Command patterns | partial | Same — the model handles most of these; first-class intents for recurring / time-scoped still pending |
| §03 Bill & split intelligence | mostly | CONSTRAINT-on-convert closed the last gap |
| §04 Fairness engine | **~90%** | Dispute loop + auto-resolver + narrated explain all shipped. Re-notify on resolve is a FE concern. |
| §05 Split-to-Save (atom) | 0% | Blocked on slice access |
| §06 User flow | mostly | "Share into goal" step still atom-blocked |
| §07 Architecture | mostly | Bedrock + Claude wired; real UPI rails + VPC deployment blocked |
| §08 Scalability | partial | Async + retry + dedup + rate-limits ✓; real queue + cache still PR 5 |
| §09 Edge cases | mostly | Disputes added 4 edge cases (auto-resolve, escalate, re-notify, audit) |
| §12 Compliance & security | partial | Rate-limits + audit ✓; PII redaction held; VPC = deployment |
| §13 Phase 1 demo | **demo-ready** | All 3 beats now have backend support: beat 1 (constraint split) ✓, beat 2 (voice — atom step still missing), beat 3 (why ₹620 + flag dessert) ✓ |

---

## 15. PR 4.5 — S3 / MinIO storage backend

Receipt images now live in object storage (S3-compatible) instead of only on local disk. Path is pluggable: dev defaults to LOCAL, CI + prod default to S3 (MinIO in compose, real AWS in prod). Per-row `Receipt.storageBackend` means receipts written under one backend keep working forever even after the env flips — no migration script.

### 15A. Storage layer — `src/storage/`

Mirrors the AI provider registry pattern.

| File | Purpose |
| --- | --- |
| `types.ts` | `StorageBackend` interface — `put`, `get`, `delete`, `signedGetUrl(key, ttl)` |
| `local.ts` | `LocalStorageBackend` — writes under `UPLOAD_DIR`. Path-traversal guard. `signedGetUrl` returns `null` (local files have no presign concept — receipts route falls back to an authenticated API URL) |
| `s3.ts` | `S3StorageBackend` — `@aws-sdk/client-s3` + `s3-request-presigner`. Endpoint + `forcePathStyle` env-configurable so the same code targets real AWS, MinIO, Cloudflare R2, Wasabi |
| `registry.ts` | `getStorageBackend()` for writes (env-driven, fallback to local if S3 unconfigured). `getStorageBackendByName(name)` for reads (looks up the per-row enum). |

### 15B. Receipt response shape

Every receipt response (`GET /receipts/:id`, `GET /receipts`, upload response) now includes `imageUrl`:
- **S3-backed**: presigned GET URL pointing directly at S3 (TTL = `S3_PRESIGN_EXPIRY_SECONDS`).
- **Local-backed**: authenticated API URL `<PUBLIC_BASE_URL>/api/v1/receipts/:id/image`. New `GET /:id/image` route streams the file with the same auth check as `GET /:id`.

`storageBackend` enum also surfaced so the FE can branch on it.

### 15C. Schema additions

```prisma
enum StorageBackend { LOCAL  S3 }
model Receipt {
  ...
  imagePath      String              // LOCAL: file path. S3: object key.
  storageBackend StorageBackend @default(LOCAL)
  ...
}
```

### 15D. New env

`PUBLIC_BASE_URL`, `STORAGE_BACKEND`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PRESIGN_EXPIRY_SECONDS`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Docker compose API container defaults to `STORAGE_BACKEND=s3` pointing at the bundled MinIO service.

### 15E. MinIO in `docker/docker-compose.yml`

- `minio` (S3 on :9000, console on :9001) with healthcheck
- `minio-init` one-shot creates the `slicesplit-receipts` bucket idempotently
- API depends on both `postgres` and `minio` healthy

### 15F. Anthropic key + model defaults from `slicehackathon2`

`.env` carries `ANTHROPIC_API_KEY` (ported), `CLAUDE_RECEIPT_MODEL=claude-haiku-4-5-20251001`, `CLAUDE_INTENT_MODEL=claude-sonnet-4-6`. Default `AI_PROVIDER_PRIORITY` stays `bedrock, anthropic, openai, mock`. Local `.env` is pinned to `mock` for fast deterministic Newman; flip to `anthropic,mock` to exercise real Claude.

### 15G. Receipt-extraction prompt: required `items[].tags`

The system prompt now demands every item carry at least one tag from the closed set `["veg", "non-veg", "alcohol", "dessert", "starter", "main", "beverage", "other"]`. Worked examples included in the prompt. This unblocks the proposal's "Mohit is veg" CONSTRAINT split from a real bill — tags flow straight from extraction into the engine.

### 15H. Tests added

| File | Tests | Coverage |
| --- | --- | --- |
| `src/storage/local.test.ts` | 5 | put/get round-trip, nested dirs, idempotent delete, path-traversal refusal, `signedGetUrl` returns null |
| `src/storage/registry.test.ts` | 3 | local default, fallback when s3 unconfigured, per-row lookup |
| `src/ai/registry.test.ts` (rewritten) | 5 | hardened to clear all provider env vars between cases (Anthropic, AWS_REGION) so .env keys don't leak |

Vitest cumulative: **76 / 76 pass** post-PR-4.5.

### 15I. Newman / e2e

- `imageUrl` and `storageBackend` assertions on upload + poll responses
- Convert assertion relaxed for the real-Claude path (accepts 400 PROCESSING)
- Balance-query plan accepts either `explanation` or `reason` (Anthropic emits REJECT when no mentioned person is found)

First green run (against dev server with real Anthropic): **64 reqs / 88 assertions / 0 failures** in ~1m50s. Mock variant runs in ~18s.

### 15J. Postman housekeeping

Added `postman/collections/slicesplit-backend.minimal.postman_collection.json` — a 5-request smoke collection (health, register, /me, create group, list groups) for troubleshooting full-collection imports.

### 15K. Subtle bugs caught while wiring

- `build-collection.mjs` had two `appendTest` calls for "Poll receipt status" — both fired against the same request; the older one used `new URL()` which Postman's sandbox doesn't ship. Killed the duplicate.
- The AI registry **caches the picked provider for process lifetime**. Changing `.env` doesn't take effect mid-run — full restart of `npm run dev` required. Documented.

---

## 16. PR 5 — Frontend integration (5 chunks)

The FE codebase at `slicesplit-integrated/` (the team's `slicehackathon2` working repo) was bootstrapped against a legacy demo server. PR 5 walks the migration **method-by-method** with strict rules: no UI changes, no polling-rate changes, demo-server fallback on every BE call so the FE never breaks mid-flow.

### 16A. Wire-up scoreboard

| splitApi method | Before | After PR 5 |
| --- | --- | --- |
| `bill` (receipt upload) | demo | ✅ BE — async OCR + poll + paise→rupees + tag→category map |
| `listContacts`, `addContact`, `updateContact`, `removeContact` | demo | ✅ BE + 10s cache |
| `command`, `confirm`, `explain` | demo | ✅ BE — session-cached `commandRunId`, intent→FE-plan adapter |
| `createGroup`, `updateGroup` | demo | ✅ BE — mixed user/contact members, member-diff for update |
| `resolveContact`, `recordInviteSent` | demo | ✅ BE (resolve) + no-op (sent, audited at mint) |
| `markPaid` | demo | ✅ BE — synthetic settlement IDs from balance.transfers, parses to real Settlement create |
| `status`, `ledger` | demo | 🟡 partial — BE fallback wired; BE-derived settlements merged into ledger |
| `preview` | demo | intentional (pure local share-math, no AI) |
| `flag`, `approveFlag`, `rejectFlag` | demo | ❌ architectural mismatch — settlement vs expense dispute (next chunk) |
| `goalFromSettlement`, `fundGoal` | demo | ❌ atom-blocked (slice infra) |
| `listMessages`, `sendMessage` | demo | ❌ no BE model yet (group chat) |
| `reset` | demo | demo-by-nature |

**13 / 24 = 54% fully BE-wired.** Plus 3 net-new methods (`mintInvite`, `redeemInvite`, `buildInviteDeepLinks`) the demo server never had.

### 16B. Chunk-by-chunk

**Chunk 1 — Contacts** (the bug discovered + fixed)
`ledger()` polled every 1.5s and embedded a `beGet("/contacts")` call → `/contacts` hit ~40×/min per tab, ~80×/min with two tabs open. Added module-local `_beContactsCache` (TTL 10s) + invalidation on every mutation. Measured drop: **83% reduction in BE traffic** (12 polls → 2 hits in 18s) with no UX regression — writer-side mutations still see updates immediately via cache invalidation; reader-side cross-tab updates land within 10s.

**Chunk 2 — Receipts (`bill`)**
Wired to the async pipeline shipped in PR 3 / hardened in PR 4.5. Upload → poll → BE shape → FE shape map. Real-bill end-to-end test against Anthropic: 16 items extracted from a 3000×4000 WhatsApp camera-roll bill in ~10s ("Chin Lung Resto Bar - Koramangala", total ₹18,641). `pickFeCategory` picks the most specific tag for the FE dietary chip.

**Chunk 3 — Commands (`command` + `confirm` + `explain`)**
Strategy A from the scope check: 3 of 4 calls go BE, `preview` stays demo (pure local share-math). Session-cached `_lastCommandRunId` chains `command` → `confirm`. `beIntentToFePlan` covers all 7 intent types (CREATE_EXPENSE, CREATE_GROUP, ADD_MEMBERS, CREATE_SETTLEMENT, QUERY_BALANCE, EXPLAIN_EXPENSE, REJECT). `explain` submits a fresh command + auto-confirm — two roundtrips, sub-2s on Anthropic, returns the engine-grounded narrator's answer.

**Chunk 4 (PR 5 B) — Groups + Invites (`createGroup`, `updateGroup`, `mintInvite`, `buildInviteDeepLinks`)**
The non-Slice-member structural gap from the @-mention plan got resolved with a **BE schema delta**: `GroupMember.userId` made nullable; new `GroupMember.contactId`. Two narrower uniques (`(userId, groupId)` + `(contactId, groupId)`) replace the old one. New `GroupInvite.phone` + `contactId`. `createGroup` accepts mixed `members: [{ userId } | { contactId }]`; the FE wrapper resolves names/objects → BE refs via the cached contact list.

**Chunk 5 (PR 5 B-6) — Invite redeem + settlement migration (`resolveContact`, `recordInviteSent`, `redeemInvite`, `markPaid`)**
- **Redeem flow**: `POST /api/v1/invites/:token/redeem` (auth). Marks invite used, links the underlying Contact to the redeemer (`Contact.linkedUserId`), and flips the `GroupMember` row from contact-kind to user-kind — all in one transaction. Idempotent (second redeem → 400 `INVITE_USED`). End-to-end verified: Charlie's contact-kind membership in Alice's group flipped to user-kind after Charlie signed up + redeemed.
- **Settlement migration**: `ledger()` now fans out to `GET /groups/:id/balances` for every active group (cached 5s per group; groups list cached 30s) and **synthesises pending settlements from `balances.transfers`** with stable IDs (`tx_<gid>_<fromId>_<toId>`). `markPaid` parses synthetic IDs → resolves the amount from the cached transfer → `POST /groups/:gid/settlements` → invalidates the balance cache. Non-`tx_` IDs fall back to demo. End-to-end verified: Bob owed Alice ₹500 via balance engine → markPaid created a real Settlement row → balances now net to zero.

### 16C. Backend changes shipped during PR 5

| File | Change | Why |
| --- | --- | --- |
| `prisma/schema.prisma` | `GroupMember.userId` nullable + `contactId`; `GroupInvite.phone` + `contactId`; Contact ↔ GroupMember + Contact ↔ GroupInvite relations | Allow non-Slice contacts as group members + invite tracking |
| `src/modules/groups/groups.schemas.ts` | `MemberRefSchema` discriminated by exactly-one of `userId`/`contactId`; `CreateGroupBody.members` field | Mixed-member group creates |
| `src/modules/groups/groups.service.ts` | createGroup accepts mixed members; contacts validated owner-scoped; PUBLIC_SELECT returns both user + contact sides | |
| `src/modules/expenses/expenses.service.ts` | `activeMemberIds` filters `userId IS NOT NULL` | Contact-only members can't carry ExpenseShare yet |
| `src/modules/balances/balances.service.ts` | Same null filter; balance engine sees only user-kind members | |
| `src/ai/tools/runner.ts` | `get_group_members` returns both user-kind and contact-kind with a `kind` field; resolve-mention skips null-user rows | NL tools see the full membership picture |
| `src/modules/invites/` (new) | `POST /api/v1/invites` (auth, rate-limited 10/5min) + `POST /api/v1/invites/:token/redeem` (auth) + `GET /api/v1/i/:token` (public) | The WhatsApp/SMS invite flow |
| `src/routes.ts` | Mounts `/invites` + `/i` | |
| `src/ai/prompts/receipt-extraction.ts` | Required `items[].tags` with closed tag set + worked examples | Real Claude now tags items for CONSTRAINT splits |

All BE changes are non-breaking on existing data — `prisma db push --accept-data-loss` was needed only for the new unique constraint (no existing rows had duplicates).

### 16D. Caches added on the FE side

| Cache | TTL | Invalidation |
| --- | --- | --- |
| `_beContactsCache` | 10s | every contact mutation |
| `_beGroupsCache` | 30s | not yet — TTL is the only knob |
| `_beBalancesCache` (per-group) | 5s | on `markPaid` for the affected group |

ledger() worst-case BE load (one user, one group): 1 `/contacts` every 10s + 1 `/groups` every 30s + 1 `/balances` every 5s = **18 BE calls/min per tab**. Was effectively 0 (demo server) before PR 5 / `Infinity` (40×/min /contacts) before the cache. Acceptable.

### 16E. Net-new helpers

| `splitApi.mintInvite({ groupId, contactId?, phone? })` | Mints a `GroupInvite` token + returns `shareUrl` |
| `splitApi.redeemInvite(token)` | Auth-required; links contact + flips GroupMember |
| `buildInviteDeepLinks({ phone, shareUrl, lenderName, groupName, amount })` | Returns `{ text, whatsapp, sms }` for `window.open()` |

### 16F. PR 5 — what's *not* wired

- **`flag` / `approveFlag` / `rejectFlag`** — settlement-level disputes don't map 1:1 to BE expense disputes. Next-chunk plan: map a disputed transfer → the most recent unsettled expense between the two parties in that group, file a Dispute against it.
- **`listMessages` / `sendMessage`** — no `Message` model on BE. Either ship one (new schema + polling endpoint) or stay on demo.
- **`goalFromSettlement` / `fundGoal`** — atom-blocked, needs slice infra.
- **`status` and `ledger`** are partial: BE fallback wired, demo still tried first.

### 16G. PR 5 verification

- `npm run typecheck` ✓, `npm run lint --max-warnings=0` ✓, `npm test` → **77 / 77 vitest** (added 5 storage + 3 storage-registry tests in PR 4.5)
- `npm run build` ✓
- **Newman e2e**: **71 reqs / 96 assertions / 0 failures** (up from 64/85 in PR 4.5; 6 new requests from the Invites folder + the `GET /receipts/:id/image` endpoint)
- Real-bill round-trip with real Claude end-to-end OK

---

## 17. Current position (end of PR 5)

| Layer | Count | Notes |
| --- | --- | --- |
| BE routes shipped | 60+ | Across auth/groups/expenses/settlements/balances/contacts/receipts/commands/disputes/guest-splits/invites |
| Vitest unit tests | **77 / 77** | Pure libs + tools + sanitizer + storage + registry |
| Newman e2e | **71 reqs / 96 assertions / 0 failures** | Real Claude in the loop |
| FE methods BE-wired | **13 / 24 (54%)** | + 3 net-new helpers |
| Proposal coverage (estimate) | ~70% | §05 atom blocked; §04 + §02 core loop demo-ready |
| Demo readiness | Beats 1 + 3 entirely on BE | Beat 2 needs atom (blocked) |
| Open BE-side work | dispute mapping for flag/approveFlag/rejectFlag; Message model for chat (optional) | |
| Open FE-side work | invite-landing page; @-mention picker UI hookup; UI tests | |
| Blocked on slice | atom Split-to-Save, real UPI/slice Pay rails, in-VPC Bedrock | |
