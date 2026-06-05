# e2e tests — Newman over the Postman collection

End-to-end smoke + assertion suite that hits a real running backend.

## What runs

`build-collection.mjs` rewrites the canonical `postman/collections/slicesplit-backend.postman_collection.json` into an e2e-ready variant:

1. Prepends a **`0. Setup (e2e bootstrap)`** folder that registers three timestamped users (`alice-<runId>@e2e.local` etc.) and stores `user_a_id`, `user_b_id`, `user_c_id` in the environment. Leaves Alice authenticated. So no `REPLACE_WITH_USER_CUID` placeholders survive into the run.
2. Wires `fixtures/receipt.png` (a tiny valid PNG) into the multipart receipt upload, so OCR is actually exercised.
3. Layers extra `pm.test(...)` assertions on demo-critical requests (balances sum to zero, expense shares sum to total, OWNER role assigned, etc.).

The original collection stays untouched — humans still import it into Postman.

## Quick start (boots + runs + tears down)

```bash
npm run test:e2e
```

Requires Docker Desktop to be running. The script:

- generates an ephemeral `JWT_SECRET` if you don't have one exported
- bumps `AUTH_RATE_LIMIT_MAX` so the suite's repeated registrations don't trip the rate limiter
- pins `AI_PROVIDER_PRIORITY=mock` so we test the pipeline without burning real Claude / Bedrock tokens
- spins up `docker compose -f docker/docker-compose.yml`, waits for `/api/v1/health/ready`, runs Newman, then tears the stack down

## Variants

```bash
NEWMAN_KEEP_RUNNING=1 npm run test:e2e          # leave Postgres + API up after the run
npm run test:e2e:no-boot                        # run against an already-up server
BASE_URL=https://staging.example.com \
  npm run test:e2e:no-boot                      # point at any hostname
```

## Reports

- `tests/e2e/reports/newman-report.html` — pretty interactive report (htmlextra)
- `tests/e2e/reports/newman-report.json` — machine-readable, good for CI

Both are gitignored.

## Switching providers for a full real-AI pass

To test the Bedrock or Anthropic path instead of mock:

```bash
export AI_PROVIDER_PRIORITY=bedrock,mock      # or anthropic,mock
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# or:
export ANTHROPIC_API_KEY=sk-ant-...

# Replace fixtures/receipt.png with a real bill photo first.
npm run test:e2e
```

The mock provider is the default for a reason: it makes the suite deterministic and free. The real providers are for **acceptance verification** before a demo, not for every push.

## Adding new assertions

Edit `build-collection.mjs` and append `appendTest(...)` calls for the requests you want to harden. Don't hand-edit the generated `slicesplit-backend.e2e.postman_collection.json` — it gets overwritten on every run.
