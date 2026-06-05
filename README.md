# slicesplit-backend

INR-first expense-splitting backend for the Slice hackathon. Express + Prisma + Postgres, JWT auth, paise precision throughout.

## What's shipped (PR 1 + PR 2)

### Foundation (PR 1)

- TypeScript + Express + Prisma + Postgres
- JWT auth (register / login / refresh-rotate / logout) with argon2id password hashing
- Prisma schema: `User`, `Contact`, `Group`, `GroupMember`, `GroupInvite`, `Expense`, `ExpenseShare`, `Settlement`, `AuditEvent`, `RefreshToken`
- Balance engine ported from ShareTab (multi-currency stripped) with vitest coverage
- Dockerfile + docker-compose with bundled Postgres → `docker compose up` works end-to-end
- Structured logging (pino), helmet, CORS allowlist, per-IP rate limiting

### Domain + AI (PR 2)

- **Expenses** with full split-mode coverage (EQUAL / EXACT / PERCENTAGE / SHARES / CONSTRAINT), transactional share replacement on update, soft-delete
- **Settlements** scoped to group members
- **Balances** endpoint that runs the engine and returns per-member balances + minimal transfers + **UPI deep-link intents** (`upi://pay?...`)
- **Contacts** address-book, auto-linked to platform users on phone/email match
- **AI provider registry**: pluggable receipt extractor; env-driven priority; mock fallback so the demo always works
- **Receipts**: multipart upload → AI extraction → list/get → convert into a real Expense
- **Guest splits**: no-auth share token + per-person claim tokens; `CLAIMING → FINALIZED` state machine; proportional tax/tip allocation on finalize

### Claude / Bedrock + NL command layer (PR 3 — matches SliceLab 3.0 proposal)

- **AI-agnostic** — `ReceiptExtractor` + `IntentParser` interfaces. Concrete providers: **`bedrock`** (Claude on AWS Bedrock via the `Converse` API), **`anthropic`** (direct Claude API), **`openai`** (legacy receipt-only), **`mock`** (always available fallback). Default priority is `bedrock, anthropic, openai, mock`.
- **Tools / skills layer** (`src/ai/tools/`) — typed read-only functions the model can call: `resolve_mention`, `get_receipt_items`, `categorize_items`, `get_group_members`, `get_group_balances`, etc. Same surface a future subagent can pull from.
- **NL command layer** (`POST /commands`) — voice + chat both hit the same endpoint. Two-stage by design: parse → dry-run plan → user confirms → executor applies via existing services. Implicit constraint inference (e.g. "split this bill … mohit is veg") produces a `CONSTRAINT` split via the deterministic engine.
- **CONSTRAINT split mode** — items have tags, participants have `allow` / `deny` lists, common charges (tax + tip) distributed proportionally; sum is exact.
- **OCR pipeline production-ready** — SHA-256 image dedup, async `setImmediate` worker, 3-attempt exponential backoff retry, sanitizer that enforces money invariants and whitelists tags. `POST /receipts/extract` returns **202 Accepted** with status `PROCESSING`; FE polls `GET /receipts/:id`.

## Deferred to PR 4

- Real Prisma migrations folder (replaces first-run `db push`)
- Integration tests against a real Postgres (testcontainers)
- PII redaction (mask card last-4, GST before image hits model)
- Real slice Pay / UPI Collect rails (today: deep-link only)
- atom Split-to-Save adapter
- Dispute flag/resolve loop
- Frontend wire-up inside the slice app

## Local development

```bash
cp .env.example .env
# edit .env: set DATABASE_URL + JWT_SECRET (openssl rand -base64 48)

npm install
npm run prisma:generate
npm run prisma:push       # creates the schema in your local Postgres
npm run dev
```

## Docker (single-click)

```bash
export JWT_SECRET="$(openssl rand -base64 48)"
docker compose -f docker/docker-compose.yml up --build
# → API on http://localhost:4000, Postgres bundled
```

## API quick reference

| Method | Path                                  | Auth |
| ------ | ------------------------------------- | ---- |
| GET    | `/api/v1/health/{live,ready}`               | —    |
| POST   | `/api/v1/auth/{register,login,refresh,logout}` | — |
| GET    | `/api/v1/me`                                | ✓    |
| PATCH  | `/api/v1/me`                                | ✓    |
| GET    | `/api/v1/groups`                            | ✓    |
| POST   | `/api/v1/groups`                            | ✓    |
| GET    | `/api/v1/groups/:groupId`                   | ✓    |
| PATCH  | `/api/v1/groups/:groupId`                   | ✓    |
| POST   | `/api/v1/groups/:groupId/members`           | ✓    |
| DELETE | `/api/v1/groups/:groupId/members/:userId`   | ✓    |
| GET    | `/api/v1/groups/:groupId/expenses`          | ✓    |
| POST   | `/api/v1/groups/:groupId/expenses`          | ✓    |
| GET    | `/api/v1/groups/:groupId/expenses/:id`      | ✓    |
| PATCH  | `/api/v1/groups/:groupId/expenses/:id`      | ✓    |
| DELETE | `/api/v1/groups/:groupId/expenses/:id`      | ✓    |
| GET    | `/api/v1/groups/:groupId/settlements`       | ✓    |
| POST   | `/api/v1/groups/:groupId/settlements`       | ✓    |
| GET    | `/api/v1/groups/:groupId/balances`          | ✓    |
| GET    | `/api/v1/contacts`                          | ✓    |
| POST   | `/api/v1/contacts`                          | ✓    |
| PATCH  | `/api/v1/contacts/:id`                      | ✓    |
| DELETE | `/api/v1/contacts/:id`                      | ✓    |
| GET    | `/api/v1/receipts`                          | ✓    |
| POST   | `/api/v1/receipts/extract` (multipart)      | ✓    |
| GET    | `/api/v1/receipts/:id`                      | ✓    |
| POST   | `/api/v1/receipts/:id/convert`              | ✓    |
| GET    | `/api/v1/guest-splits`                      | ✓    |
| POST   | `/api/v1/guest-splits`                      | ✓    |
| GET    | `/api/v1/guest-splits/:id`                  | ✓    |
| GET    | `/api/v1/g/:shareToken`                     | —    |
| POST   | `/api/v1/g/:shareToken/people`              | —    |
| POST   | `/api/v1/g/:shareToken/claims`              | —    |
| DELETE | `/api/v1/g/:shareToken/claims`              | —    |
| POST   | `/api/v1/g/:shareToken/finalize`            | ✓    |
| GET    | `/api/v1/commands`                          | ✓    |
| POST   | `/api/v1/commands`                          | ✓    |
| GET    | `/api/v1/commands/:id`                      | ✓    |
| POST   | `/api/v1/commands/:id/confirm`              | ✓    |
| POST   | `/api/v1/commands/:id/reject`               | ✓    |
| GET    | `/api/v1/expenses/:expenseId/disputes`      | ✓    |
| POST   | `/api/v1/expenses/:expenseId/disputes`      | ✓    |
| POST   | `/api/v1/disputes/:id/resolve`              | ✓    |
| POST   | `/api/v1/disputes/:id/reject`               | ✓    |

## Testing

Two layers:

### Unit (vitest, ~600 ms)

```bash
npm test
```

Covers pure libs: `money`, `balance-engine`, `split-calculator`, `upi`, `ai/registry`, `guest/service` math. 58 tests today.

### End-to-end (Newman over docker compose, ~17 s)

```bash
npm run test:e2e                    # boot Docker → newman → teardown
npm run test:e2e:no-boot            # against an already-running server
NEWMAN_KEEP_RUNNING=1 npm run test:e2e   # leave the stack up after
```

Self-bootstrapping suite: registers three timestamped users, exercises every module the API exposes (auth, groups, expenses in all 4 modes, settlements, balances, contacts, async OCR receipts, NL commands, guest splits). Pins `AI_PROVIDER_PRIORITY=mock` for determinism. See `tests/e2e/README.md` for the real-AI override.

First run was 57 requests / 25 assertions / 0 failures — **and caught 3 real bugs** (a broken `docker-compose.yml`, a Prisma engine-target mismatch, and a `PORT` env-var collision in `entrypoint.sh`) that pure-function tests can't see.

## Tests (legacy header, kept for backlinks)

```bash
npm test              # vitest run
npm run lint
npm run typecheck
```

## Conventions

- All money is stored as integer **paise** (1 INR = 100 paise). The only place we touch floats is `src/lib/money.ts`.
- Domain errors live in `src/lib/errors.ts`; throw them and the central error middleware maps to HTTP status codes.
- Each module follows `routes → service → prisma`. Schemas (Zod) live next to the routes and gate every input.
- Module structure: `src/modules/<name>/{routes,service,schemas}.ts`.
