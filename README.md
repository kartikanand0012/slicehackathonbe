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

- **Expenses** with full split-mode coverage (EQUAL / EXACT / PERCENTAGE / SHARES), transactional share replacement on update, soft-delete
- **Settlements** scoped to group members
- **Balances** endpoint that runs the engine and returns per-member balances + minimal transfers + **UPI deep-link intents** (`upi://pay?...`)
- **Contacts** address-book, auto-linked to platform users on phone/email match
- **AI provider registry**: pluggable receipt extractor (`mock`, `openai`); env-driven priority; mock fallback so the demo always works
- **Receipts**: multipart upload → AI extraction → list/get → convert into a real Expense
- **Guest splits**: no-auth share token + per-person claim tokens; `CLAIMING → FINALIZED` state machine; proportional tax/tip allocation on finalize
- Receipt models, Guest-split models, and 5 new `AuditAction` entries in Prisma

## Deferred to PR 3

- Real Prisma migrations folder (replaces first-run `db push`)
- Integration tests against a real Postgres (testcontainers)
- Frontend wire-up

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

## Tests

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
