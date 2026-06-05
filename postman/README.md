# Postman collection

```
postman/
├── collections/
│   └── slicesplit-backend.postman_collection.json   # one collection, folders per module
├── environments/
│   ├── local.postman_environment.json               # http://localhost:4000 (npm run dev)
│   └── docker.postman_environment.json              # http://localhost:4000 (docker compose up)
└── examples/
    └── curl-cheatsheet.md
```

## How to use

1. **Import** the collection from `collections/slicesplit-backend.postman_collection.json`.
2. **Import** an environment from `environments/` and activate it (top-right selector in Postman).
3. Run **Auth → Register** (or **Login**). Test scripts auto-populate `access_token`, `refresh_token`, and `user_id` on the active environment.
4. All requests under **Me** and **Groups** use the collection-level Bearer auth, which reads `{{access_token}}` — no manual header copying.
5. **Create group** stores the new id in `{{group_id}}`, so the follow-up Get/Update/Members requests work out of the box.

## Folder layout matches `src/modules/`

| Postman folder | Source                | Notes                                                |
| -------------- | --------------------- | ---------------------------------------------------- |
| Health         | `src/modules/health`  | `/health/live`, `/health/ready` (DB ping)            |
| Auth           | `src/modules/auth`    | Register, Login, Refresh (rotates), Logout (revoke)  |
| Me             | `src/modules/me`      | GET, PATCH profile (name, avatarUrl, upiHandle)      |
| Groups         | `src/modules/groups`  | List (cursor paginated), Create, Get, Update/Archive, Add/Remove member |

## Validation & logging

Every endpoint pictured in the collection is fronted by:

- **Zod validation** on body, query, and params (`src/middleware/validate.ts`). Failures return `400 VALIDATION_ERROR` with a `details[]` array — visible directly in the Postman response pane.
- **Structured request logging** via `pino-http` (`src/app.ts`). Each request logs method, path, status, response time, and request id, with `Authorization`, `Cookie`, `password`, `refreshToken`, and password/token hashes redacted (`src/lib/logger.ts`).
- **Central error handler** (`src/middleware/error-handler.ts`) — maps Zod, JWT (`TOKEN_EXPIRED` / `INVALID_TOKEN`), and Prisma (`UNIQUE_CONSTRAINT`, `NOT_FOUND`) errors to consistent JSON responses.

When debugging in Postman, watch the server logs to correlate via the auto-attached request id.

## Curl

If you'd rather not import anything, see `examples/curl-cheatsheet.md`.
