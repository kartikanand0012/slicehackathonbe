/**
 * Vitest global setup. Injects the minimum env vars our env validator
 * requires so tests that transitively import `@/config/env` don't trigger
 * `process.exit(1)`. Tests that want to assert env behaviour should
 * override `process.env` inside the test body.
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.PORT = process.env.PORT ?? "4001";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://test:test@localhost:5432/slicesplit_test";
process.env.JWT_SECRET =
  process.env.JWT_SECRET ??
  "test-secret-must-be-at-least-32-characters-long-yes-it-is";
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:3000";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
