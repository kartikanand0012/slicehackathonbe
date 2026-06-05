#!/usr/bin/env bash
# tests/e2e/run.sh — end-to-end test driver.
#
# What it does:
#   1. Generates a JWT_SECRET if you haven't exported one.
#   2. Boots docker compose (Postgres + API), waits for /health/ready.
#   3. Rebuilds the e2e collection from the canonical Postman one.
#   4. Runs Newman.
#   5. Optionally tears down (set NEWMAN_KEEP_RUNNING=1 to leave it up).
#
# Usage:
#   ./tests/e2e/run.sh                          # boot, run, tear down
#   NEWMAN_KEEP_RUNNING=1 ./tests/e2e/run.sh    # boot, run, leave it up for poking
#   BASE_URL=http://10.0.0.5:4000 \
#     ./tests/e2e/run.sh --no-boot              # run against an already-up server
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker/docker-compose.yml"
NO_BOOT=0
for arg in "$@"; do
  case "$arg" in
    --no-boot) NO_BOOT=1 ;;
  esac
done

BASE_URL="${BASE_URL:-http://localhost:4000}"
API_PORT="${API_PORT:-4000}"

if [ "$NO_BOOT" = "0" ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "✗ Docker daemon isn't reachable. Start Docker Desktop and rerun." >&2
    exit 1
  fi

  if [ -z "${JWT_SECRET:-}" ]; then
    export JWT_SECRET="$(openssl rand -base64 48)"
    echo "→ Generated ephemeral JWT_SECRET for this run."
  fi
  # Bump rate limits so a fresh suite doesn't trip the auth limiter.
  export AUTH_RATE_LIMIT_MAX="${AUTH_RATE_LIMIT_MAX:-9999}"
  export AI_PROVIDER_PRIORITY="${AI_PROVIDER_PRIORITY:-mock}"
  export API_PORT

  echo "→ Booting docker compose ($COMPOSE_FILE) ..."
  docker compose -f "$COMPOSE_FILE" up -d --build
fi

echo "→ Waiting for $BASE_URL/api/v1/health/ready ..."
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/v1/health/ready" >/dev/null 2>&1; then
    echo "  ready after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    echo "✗ API never became ready" >&2
    if [ "$NO_BOOT" = "0" ]; then
      docker compose -f "$COMPOSE_FILE" logs --tail=50
    fi
    exit 1
  fi
done

echo "→ Rebuilding e2e collection ..."
node tests/e2e/build-collection.mjs

NEWMAN_BIN="$ROOT/node_modules/.bin/newman"
if [ ! -x "$NEWMAN_BIN" ]; then
  echo "✗ Newman missing — run \`npm install\`." >&2
  exit 1
fi

mkdir -p tests/e2e/reports

echo "→ Running Newman ..."
set +e
"$NEWMAN_BIN" run tests/e2e/slicesplit-backend.e2e.postman_collection.json \
  -e tests/e2e/environment.json \
  --working-dir tests/e2e \
  --delay-request 250 \
  --reporters cli,json,htmlextra \
  --reporter-json-export tests/e2e/reports/newman-report.json \
  --reporter-htmlextra-export tests/e2e/reports/newman-report.html \
  --color on
RC=$?
set -e

if [ "$NO_BOOT" = "0" ] && [ "${NEWMAN_KEEP_RUNNING:-0}" != "1" ]; then
  echo "→ Tearing down docker compose ..."
  docker compose -f "$COMPOSE_FILE" down
fi

if [ $RC -ne 0 ]; then
  echo "✗ Newman reported failures (rc=$RC). See tests/e2e/reports/newman-report.html"
else
  echo "✓ Newman passed. Report: tests/e2e/reports/newman-report.html"
fi
exit $RC
