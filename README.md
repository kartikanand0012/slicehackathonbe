# slicesplit-backend

INR-first expense-splitting backend for the Slice hackathon. Express + Prisma + Postgres, JWT auth, paise precision throughout.

## What's in PR 1

- TypeScript + Express + Prisma + Postgres
- JWT auth (register / login / refresh-rotate / logout) with argon2id password hashing
- Prisma schema: `User`, `Contact`, `Group`, `GroupMember`, `GroupInvite`, `Expense`, `ExpenseShare`, `Settlement`, `AuditEvent`, `RefreshToken`
- Balance engine ported from ShareTab (multi-currency stripped) with vitest coverage
- Core CRUD: `/api/v1/{health,auth,me,groups}`
- Dockerfile + docker-compose with bundled Postgres → `docker compose up` works end-to-end
- Structured logging (pino), helmet, CORS allowlist, per-IP rate limiting

## Deferred to PR 2

- AI provider registry + receipt extraction pipeline
- Guest-split state machine (no-auth shareable bills)
- Expense + settlement HTTP routes (engine is ready, routes pending)
- Wire-up with the React frontend

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
| GET    | `/api/v1/health/live`                 | —    |
| GET    | `/api/v1/health/ready`                | —    |
| POST   | `/api/v1/auth/register`               | —    |
| POST   | `/api/v1/auth/login`                  | —    |
| POST   | `/api/v1/auth/refresh`                | —    |
| POST   | `/api/v1/auth/logout`                 | —    |
| GET    | `/api/v1/me`                          | ✓    |
| PATCH  | `/api/v1/me`                          | ✓    |
| GET    | `/api/v1/groups`                      | ✓    |
| POST   | `/api/v1/groups`                      | ✓    |
| GET    | `/api/v1/groups/:groupId`             | ✓    |
| PATCH  | `/api/v1/groups/:groupId`             | ✓    |
| POST   | `/api/v1/groups/:groupId/members`     | ✓    |
| DELETE | `/api/v1/groups/:groupId/members/:userId` | ✓ |

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
