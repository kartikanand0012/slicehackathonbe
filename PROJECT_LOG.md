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
| PR 2 — AI + guest splits + frontend wire-up | ⏳ next | expense/settlement routes, AI provider registry, receipt pipeline, guest-split state machine |
