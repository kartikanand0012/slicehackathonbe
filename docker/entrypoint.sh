#!/bin/sh
# slicesplit-backend entrypoint
#
# Responsibilities:
#   1. Validate required env (DATABASE_URL, JWT_SECRET)
#   2. Wait for Postgres to be reachable
#   3. Apply pending Prisma migrations
#   4. Hand off to the supplied CMD (the node process)
#
# Designed to be idempotent so `docker compose up` can be rerun safely.
set -eu

log() { printf '[entrypoint] %s\n' "$*"; }
fail() { printf '[entrypoint][FATAL] %s\n' "$*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required"
[ -n "${JWT_SECRET:-}" ]   || fail "JWT_SECRET is required"
case "${JWT_SECRET}" in
  *change-me-please*|*"change-me"*)
    fail "JWT_SECRET is still the default placeholder. Generate one with: openssl rand -base64 48"
    ;;
esac

# ── Wait for Postgres ──
# Parses host/port out of DATABASE_URL via Node so we don't pull in extra tools.
# IMPORTANT: do NOT name these `HOST` / `PORT` — those collide with env vars
# the app reads (PORT is the HTTP listen port). Use PG_* names to be safe.
WAIT_HOST_PORT=$(node -e "
  const u = new URL(process.env.DATABASE_URL);
  process.stdout.write(\`\${u.hostname} \${u.port || 5432}\`);
")
PG_HOST=$(echo "$WAIT_HOST_PORT" | awk '{print $1}')
PG_PORT=$(echo "$WAIT_HOST_PORT" | awk '{print $2}')

log "Waiting for Postgres at $PG_HOST:$PG_PORT ..."
TRIES=0
until node -e "
  const net = require('node:net');
  const s = net.connect({ host: '$PG_HOST', port: $PG_PORT });
  s.once('connect', () => { s.end(); process.exit(0); });
  s.once('error',   () => process.exit(1));
  setTimeout(() => process.exit(1), 1500);
" >/dev/null 2>&1; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -gt 60 ]; then
    fail "Postgres unreachable after 60 attempts"
  fi
  sleep 1
done
log "Postgres is reachable."

# ── Apply migrations ──
# `migrate deploy` is the production-safe runner: it never resets, never
# generates, just applies pending migrations.
if [ -d "/app/prisma/migrations" ] && [ -n "$(ls -A /app/prisma/migrations 2>/dev/null || true)" ]; then
  log "Running prisma migrate deploy ..."
  npx prisma migrate deploy
else
  # First-run convenience: if no migrations exist yet, push the schema so
  # the container is usable end-to-end out of the box.
  log "No migrations directory found — running prisma db push ..."
  npx prisma db push --skip-generate --accept-data-loss
fi

log "Starting application: $*"
exec "$@"
