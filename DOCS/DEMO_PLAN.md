# SliceSplit — Demo-Readiness Execution Plan

Granular work plan to close the five demo-readiness gaps before SliceLab 3.0 demo day. Each workstream is independently shippable; ordering is by criticality + dependency.

**Target:** all five workstreams green on Newman + manually rehearsed against real Bedrock inside docker compose, two full days before the slot.

**Branch convention:** one branch per workstream off `phase2/db-selection`. Squash-merge in the order below.

---

## Workstream 0 — Pre-flight (½ day, blocking everything else)

The next four workstreams assume Bedrock + Anthropic actually work end-to-end. Do not start them until W0 passes.

### W0.1 — Verify Bedrock credentials reach the container
- [ ] Add `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_RECEIPT_MODEL_ID`, `BEDROCK_INTENT_MODEL_ID` to `docker/.env.example`.
- [ ] Pull values from team 1Password / AWS console; populate local `docker/.env`.
- [ ] Add `AWS_*` passthrough into the `api` service block of `docker/docker-compose.yml` `environment:`.
- [ ] `docker compose up -d --build && docker compose exec api node -e "require('@aws-sdk/client-bedrock-runtime')"` — confirms package present in runtime image.

### W0.2 — Add a deep-health probe for AI providers
- [ ] New file: `src/modules/health/health.routes.ts` — add `GET /api/v1/health/ai`.
- [ ] Implementation: call `getReceiptExtractor().healthCheck?.()` and `getIntentParser().healthCheck?.()` (add optional method to `ReceiptExtractor` / `IntentParser` interfaces in `src/ai/types.ts`).
- [ ] Concrete providers: `anthropic.ts` and `bedrock.ts` implement `healthCheck()` as a 1-token call to the cheapest model (Haiku) with prompt `"ping"`. Return `{ ok: true, latencyMs }`.
- [ ] Update `entrypoint.sh` to optionally curl `/health/ai` and warn (don't fail) if not reachable — keeps the container booting even if AWS is flaky.

**Acceptance:** `curl localhost:4000/api/v1/health/ai` returns `{ receipt: {provider: "bedrock", ok: true}, intent: {provider: "bedrock", ok: true} }` from inside `docker compose up`.

---

## Workstream 1 — Real receipt fixture + Bedrock acceptance pass (1 day)

**Why first:** every other workstream sits on top of "Claude actually parses Indian bills." If the model can't handle handwritten Devanagari or a Zomato screenshot, beat 1 of the demo (§14) collapses and we need to know now.

### W1.1 — Source three real fixtures (2 hours)
- [ ] `tests/e2e/fixtures/printed-restaurant.jpg` — a real printed Indian restaurant bill (paneer / dal / roti line items, GST line, service charge). Acquire from a teammate; redact card last-4 manually before checking in.
- [ ] `tests/e2e/fixtures/zomato-screenshot.png` — a Zomato or Swiggy order summary screenshot (these have a very specific layout the model needs to handle).
- [ ] `tests/e2e/fixtures/handwritten.jpg` — a handwritten kirana / chai bill. The proposal §09 calls this out explicitly.
- [ ] Delete the placeholder `tests/e2e/fixtures/receipt.png` (100×100 blank).
- [ ] Add a `tests/e2e/fixtures/README.md` documenting what each fixture exercises.

### W1.2 — Expected-output ground truth (1 hour)
For each fixture, create a sibling JSON with the *correct* extraction:
- [ ] `printed-restaurant.expected.json` — `{ merchantName, totalPaise, subtotalPaise, taxPaise, items: [{name, quantity, unitPaise, totalPaise, tags}] }`.
- [ ] `zomato-screenshot.expected.json` — same shape.
- [ ] `handwritten.expected.json` — same shape; accept the model emitting fewer items if confidence is low (low-confidence handling is §09 behaviour).

### W1.3 — Bedrock acceptance script (3 hours)
New file: `tests/acceptance/bedrock-receipts.test.ts` (NOT vitest — a standalone script so it isn't run by CI).
- [ ] For each fixture: call `getReceiptExtractor().extract(image)` against real Bedrock.
- [ ] Diff result against expected JSON with fuzzy tolerance (±5% on paise, fuzzy string match on item names via Levenshtein ≤ 3).
- [ ] Print a per-fixture table: `merchant ✓ | total ✓ | items 7/8 (1 missing: "extra cheese")`.
- [ ] Exit code 0 if every fixture has merchant + total within tolerance; else 1.
- [ ] Add `npm run test:acceptance` script.

### W1.4 — Update Newman to use real fixture (1 hour)
- [ ] `tests/e2e/build-collection.mjs` — point the multipart upload at `printed-restaurant.jpg` instead of `receipt.png`.
- [ ] Update Newman assertions on `GET /receipts/:id` to expect non-empty `items[]` (currently just asserts `COMPLETED`).
- [ ] Add a new assertion: at least one item has a `tags` array including `"veg"` or `"non-veg"` (the CONSTRAINT demo beat needs this).

### W1.5 — Provider pinning safety (½ hour)
- [ ] `src/ai/registry.ts` — log the chosen provider on first call with `logger.info({ provider, model }, "AI provider selected")`. This is what we'll screenshot during the dry run to prove the demo isn't accidentally on mock.
- [ ] Add a startup banner in `src/server.ts` that prints `[AI] receipt=bedrock(claude-3-5-haiku-...) intent=bedrock(claude-3-5-sonnet-...)` so the operator sees it in the docker logs before the demo starts.

**Acceptance:**
- `npm run test:acceptance` passes against real Bedrock for all 3 fixtures.
- `npm run test:e2e` passes with the new `printed-restaurant.jpg` and asserts a `veg`/`non-veg` tag in the output.
- Server boot log shows `[AI] receipt=bedrock(...)` not `mock`.

**Risk:** if W1.3 finds Bedrock can't tag items reliably, the entire CONSTRAINT beat is in trouble. Mitigation: fall back to instructing the model to tag in a separate post-extraction call (`categorize_items` tool, already exists in `src/ai/tools/`).

---

## Workstream 2 — Voice transcript ingestion (1 day)

**Why second:** §14 beat 2 is "the voice showstopper — one sentence, five actions." Today the chat path works; voice has never been wired. We need at least one happy-path utterance going through real Amazon Transcribe.

### W2.1 — Decide STT integration mode (½ hour decision, then build)

Two options — pick before writing code:

**Option A (recommended for demo):** client-side STT. The mobile app does Amazon Transcribe locally and POSTs the transcript text. Backend just accepts `{ transcript, source: "voice" }` on the existing `POST /commands` route. **Pros:** zero new backend deps, lowest latency, matches proposal §07. **Cons:** demo needs a real client.

**Option B:** server-side STT. New endpoint accepts audio, calls Transcribe Streaming, forwards transcript. **Pros:** can demo from Postman with an audio file. **Cons:** more code, audio handling is fiddly, adds an AWS SDK.

If no slice mobile app cut for demo → **Option B**. Plan below assumes B since A is a 5-line change.

### W2.2 — New endpoint: `POST /api/v1/voice/transcript` (3 hours)
- [ ] New module: `src/modules/voice/{voice.routes.ts, voice.service.ts, voice.schemas.ts}`.
- [ ] Schema: `voice.schemas.ts` — `transcribeSchema = z.object({ audioBase64: z.string(), mimeType: z.enum(["audio/wav", "audio/mp3", "audio/mp4", "audio/webm"]), contextGroupId: z.string().optional(), contextReceiptId: z.string().optional() })`.
- [ ] Service: `voice.service.ts` — calls `@aws-sdk/client-transcribe-streaming` (`StartStreamTranscriptionCommand`), returns `{ transcript: string, confidence: number }`.
- [ ] Route handler: decode base64 → `transcribe()` → if confidence < 0.6 throw `BadRequestError("Low confidence — please type instead")` (matches §09 "Mis-heard voice" handling).
- [ ] After transcription, internally forward to `commandsService.parseCommand({ utterance: transcript, source: "voice", contextGroupId, contextReceiptId })`.
- [ ] Response: `{ commandRunId, transcript, confidence, intent, plan }`.

### W2.3 — Rate limit + size limits (½ hour)
- [ ] `src/middleware/rate-limit.ts` — add `voiceLimiter: 10 / 5min per IP` (matches receipts.extract). Voice is expensive.
- [ ] `src/app.ts` — bump `express.json({ limit: '5mb' })` for the voice route only via per-route middleware. Default stays 1mb. Audio is ~50KB/sec so 5mb covers ~90s.

### W2.4 — Wire into routes (5 min)
- [ ] `src/routes.ts` — `apiRouter.use("/voice", voiceRouter)`.

### W2.5 — Newman + Postman (1 hour)
- [ ] Add `tests/e2e/fixtures/voice-create-group.wav` — a 4-second recording of the §14 utterance: *"Create a group Goa, add Sukant Mohit Kartik, split tonight's dinner, Mohit's veg, put my share in my Goa savings goal."*
- [ ] `tests/e2e/build-collection.mjs` — add a "Voice" folder with one request that uploads the WAV, asserts `confidence > 0.6`, captures `commandRunId`, and chains to `POST /commands/:id/confirm`.
- [ ] Add the showstopper utterance fixture variants too: `voice-balance-query.wav` ("how much does Mohit owe me overall?") and `voice-explain.wav` ("why do I owe 620?").

### W2.6 — Polly spoken confirmation (optional, 2 hours — only if W2.1–2.5 finished early)
- [ ] `voice.service.ts` — add `synthesize(text)` using `@aws-sdk/client-polly` `SynthesizeSpeechCommand` with `OutputFormat: "mp3"`, `VoiceId: "Kajal"` (Indian English).
- [ ] `POST /api/v1/voice/transcript` response gets a `confirmationAudioBase64` field with a Polly readback of the parsed `intent.summary`.

**Acceptance:**
- `npm run test:e2e` includes the voice folder; transcript matches the recorded utterance within Levenshtein ≤ 5.
- Confirming the command actually creates the group + expense + dispatches the CONSTRAINT split.
- Boot log shows Transcribe SDK initialized.

**Risk:** Transcribe latency over 3 seconds breaks the demo flow. Mitigation: pre-warm the streaming client at boot in `server.ts`. If too slow, fall back to Option A (client-side transcript) and just demo the chat path live.

---

## Workstream 3 — Atom Split-to-Save mock adapter (1 day)

**Why third:** §05 / §14 beat 2 says "share routed into Goa atom." Without this, the voice showstopper is missing its punchline. We won't get real atom access — a credible mock is the deliverable.

### W3.1 — Schema additions (½ hour)
Add to `prisma/schema.prisma`:

```prisma
model AtomGoal {
  id              String    @id @default(cuid())
  userId          String
  name            String    // "Goa Trip"
  targetPaise     Int
  currentPaise    Int       @default(0)
  status          AtomGoalStatus @default(ACTIVE)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  contributions   AtomContribution[]
  @@index([userId])
}

model AtomContribution {
  id             String   @id @default(cuid())
  goalId         String
  sourcePaise    Int
  sourceType     String   // "SETTLEMENT_INFLOW" | "MANUAL" | "ROUND_UP"
  sourceRefId    String?  // settlementId, expenseId, etc.
  createdAt      DateTime @default(now())
  goal           AtomGoal @relation(fields: [goalId], references: [id], onDelete: Cascade)
  @@index([goalId, createdAt])
}

enum AtomGoalStatus { ACTIVE FUNDED PAID_OUT CANCELLED }
```

Add reverse relation `atomGoals AtomGoal[]` on `User`.

### W3.2 — Atom provider abstraction (1.5 hours)
- [ ] New dir: `src/integrations/atom/`.
- [ ] `src/integrations/atom/types.ts` — `AtomProvider` interface: `createGoal`, `getGoal`, `listGoals(userId)`, `contribute(goalId, paise, ref)`, `payOut(goalId)`.
- [ ] `src/integrations/atom/mock.ts` — `MockAtomProvider` — pure Prisma operations on the new tables, simulates instant funding. Used in dev + demo.
- [ ] `src/integrations/atom/registry.ts` — `getAtomProvider()` — selects by `ATOM_PROVIDER` env (`mock` default; reserves `slice` for the real adapter later).

### W3.3 — Goals module (2 hours)
- [ ] New module `src/modules/goals/` with `routes.ts`, `service.ts`, `schemas.ts`.
- [ ] Routes (all `requireAuth`):
  - `GET /api/v1/goals` — list current user's goals.
  - `POST /api/v1/goals` — create `{ name, targetPaise }`.
  - `GET /api/v1/goals/:id` — fetch with contributions.
  - `POST /api/v1/goals/:id/contribute` — manual contribution `{ paise }`.
  - `POST /api/v1/goals/:id/payout` — flips status to `PAID_OUT`.
- [ ] Audit events: new `AuditAction` values `GOAL_CREATED`, `GOAL_CONTRIBUTION`, `GOAL_PAID_OUT`.

### W3.4 — Wire settlements → goal auto-contribute (1 hour)
The proposal §05 promise: "Money owed to you → grows a goal." Implementation:
- [ ] Extend `Settlement` with an optional `routeToGoalId String?`. Schema migration.
- [ ] `POST /groups/:groupId/settlements` body accepts `routeToGoalId` — when present **and** the authenticated user is the `to` side, on settle the service calls `atomProvider.contribute(goalId, amountPaise, { sourceType: "SETTLEMENT_INFLOW", sourceRefId: settlement.id })` in the same transaction.
- [ ] Returns `{ settlement, goalContribution }` so the FE can show the savings beat.

### W3.5 — Wire NL command → goal contribution (1 hour)
- [ ] Add a new tool to `src/ai/tools/definitions.ts`: `get_my_goals()` returning `{ id, name, targetPaise, currentPaise }[]`.
- [ ] Extend the `CREATE_EXPENSE` intent schema in `src/modules/commands/commands.schemas.ts` to accept `routeMyShareToGoalId?: string`. When set, the executor:
  1. Creates the expense (as today).
  2. Creates a contribution against the goal for the *paid-by user's portion of their own expense* — semantically, "I paid 1000, owed 1000 back, route my recovered share to Goa goal."
- [ ] Update `src/ai/prompts/intent-parser.ts` to teach the model the "put my share in my Goa goal" pattern.

### W3.6 — Tests + Newman (1 hour)
- [ ] `src/modules/goals/goals.service.test.ts` — 4 tests covering create, contribute, payout, listGoals.
- [ ] Newman: new "Goals (atom)" folder — create goal, contribute manually, settle-with-route, assert `goal.currentPaise` increased.

**Acceptance:**
- Voice demo utterance with "put my share in my Goa savings goal" produces an `AtomContribution` row visible via `GET /goals/:id`.
- Newman asserts goal balance grew after the settlement.
- Boot log indicates atom provider in use: `[Atom] provider=mock`.

**Risk:** none — entirely owned code, no external calls.

---

## Workstream 4 — Time-scoped + recurring commands (1 day)

**Why fourth:** §03 lists "Split everything I paid this group today" and "Every month auto-split rent" as headline command patterns. Currently neither intent exists. Both are demo-impactful and low-risk to implement.

### W4.1 — Time-scoped queries (3 hours)

Two intents to add to the NL pipeline:

**(a) `QUERY_EXPENSES_BY_TIME`** — read-only "what did I pay between dates."
- [ ] Extend `commands.schemas.ts` `ParsedIntent` discriminated union with `{ type: "QUERY_EXPENSES_BY_TIME", groupId?, payerId?, fromDate, toDate }`.
- [ ] New tool `get_expenses_by_time(groupId?, payerId?, fromIso, toIso)` in `src/ai/tools/definitions.ts` + handler in `runner.ts`. Returns expense list.
- [ ] Executor branch in `commands.executor.ts` calls the tool, formats result as a plan, status flips to `EXECUTED` (no confirmation needed for reads).

**(b) `CREATE_EXPENSES_BY_TIME_BULK`** — write "split everything I paid this week with the group."
- [ ] Extend intent: `{ type: "CREATE_EXPENSES_BY_TIME_BULK", groupId, fromDate, toDate, splitMode }`.
- [ ] Plan-stage: tool resolves the un-split expenses (status filter: payer = user, group = current, no shares created, occurredAt in range), returns total + count + per-expense breakdown.
- [ ] Confirm-stage: executor wraps in a transaction, calls `expensesService.createShares` for each.
- [ ] Two-stage confirmation **required** — moves money.

### W4.2 — Date-range parser (1 hour)
Real utterances use relative dates: *"today"*, *"this week"*, *"Jun 1–4"*. The model can parse these but we shouldn't trust it for the actual boundary.
- [ ] New lib: `src/lib/date-range.ts` — `parseRange(phrase, now): { from: Date, to: Date }`. Cases: `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`, `<month> <day>–<day>`, ISO range.
- [ ] Unit tests in `src/lib/date-range.test.ts` — 12 cases including timezone (assume `Asia/Kolkata`).
- [ ] Executor calls `parseRange` on the model's `dateRange` field; if parse fails, throws back to the model as a tool error so it can retry.

### W4.3 — Recurring rules (3 hours)

Schema:
```prisma
model RecurringRule {
  id              String   @id @default(cuid())
  createdById     String
  groupId         String
  title           String
  amountPaise     Int?     // null = "ask each time"
  splitMode       SplitMode
  splitConfig     Json     // { participants, allows, basisPoints, ... }
  cadence         RecurringCadence  // MONTHLY | WEEKLY
  anchorDay       Int      // 1–31 for MONTHLY; 0–6 for WEEKLY
  startsOn        DateTime
  endsOn          DateTime?
  lastMaterializedAt DateTime?
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  createdBy       User     @relation(...)
  group           Group    @relation(...)
}
enum RecurringCadence { WEEKLY MONTHLY }
```

- [ ] Module `src/modules/recurring/` with CRUD routes.
- [ ] `src/workers/recurring-materializer.ts` — runs every 1 hour (`setInterval` for demo; replace with proper cron in prod). Picks rules where `nextDue ≤ now AND active`, creates an Expense, advances `lastMaterializedAt`.
- [ ] Boot in `src/server.ts`: `if (env.NODE_ENV !== "test") startRecurringWorker()`.
- [ ] Intent: `CREATE_RECURRING_RULE` in NL pipeline → creates the rule, returns the rendered plan. Confirmation required.

### W4.4 — Demo-safe materializer trigger (½ hour)
For demo: the worker won't fire mid-presentation. Add `POST /api/v1/recurring/:id/materialize-now` (admin-only) so a teammate can poke the rule from Postman to prove it works.

### W4.5 — Tests + Newman (1 hour)
- [ ] `date-range.test.ts` — 12 cases.
- [ ] `recurring.service.test.ts` — 4 cases: materialize-once-per-month, no-double-fire, end-date respect, inactive skip.
- [ ] Newman: add Commands folder requests for both new intents; assert the resulting expense exists.

**Acceptance:**
- `"Split everything I paid in Goa group today"` produces a plan listing today's expenses, confirm creates shares, balances update.
- `"Every month auto-split rent equally with my flat"` creates a `RecurringRule`; `POST /recurring/:id/materialize-now` produces an expense.

**Risk:** date parsing edge cases (DST, month-end). Mitigation: hard-pin to `Asia/Kolkata`, no DST, no surprises.

---

## Workstream 5 — Multi-payer expense (½ day)

**Why fifth:** §09 explicitly tables "Multiple payers on one bill — each payer's contribution tracked separately." Single-payer is a question a judge will ask about. Smallest workstream — slot into any spare slot before demo.

### W5.1 — Schema (½ hour)
```prisma
model ExpensePayer {
  id           String  @id @default(cuid())
  expenseId    String
  userId       String
  amountPaise  Int     // what this user actually paid
  expense      Expense @relation(fields: [expenseId], references: [id], onDelete: Cascade)
  user         User    @relation(fields: [userId], references: [id])
  @@unique([expenseId, userId])
  @@index([userId])
}
```

- [ ] Keep `Expense.paidById` for backward compat — make it represent the "primary payer" (largest contributor).
- [ ] Add `Expense.payers ExpensePayer[]` reverse relation.

### W5.2 — Service updates (1.5 hours)
- [ ] `expenses.schemas.ts` — extend create schema with optional `payers: { userId, amountPaise }[]`. If absent, fall back to `{ paidById, amountPaise: totalPaise }`.
- [ ] `expenses.service.ts createExpense`:
  - Validate `sum(payers.amountPaise) === amountPaise`.
  - Validate every payer is an active group member.
  - Auto-set `paidById = payers[0].userId` (largest by amountPaise).
  - Write `ExpensePayer` rows in the same transaction.
- [ ] Balance engine update — `src/lib/balance-engine.ts`:
  - Today: for each expense, credit `paidById` the full `amountPaise`, debit each share-holder their `shares[].amountPaise`.
  - New: credit each `ExpensePayer.userId` their `amountPaise`. Falls back to single-payer when `payers` is empty (back-compat for old rows).
- [ ] Soft-delete already cascades; nothing to do for delete.

### W5.3 — Tests (½ hour)
- [ ] `balance-engine.test.ts` — 2 new cases: "two payers split among three", "three payers, EXACT mode".
- [ ] `expenses.service.test.ts` — sum validation, primary payer assignment.

### W5.4 — Newman (½ hour)
- [ ] One new request in Expenses folder: 2-payer EQUAL split (Alice paid 600, Bob paid 400, total 1000, split equally among Alice/Bob/Charlie). Assert balances reflect both payers.

**Acceptance:**
- Two-payer expense balances correctly: payer credited, share-holder debited.
- Old single-payer expenses still work unchanged (back-compat).

**Risk:** balance engine is core. Mitigation: 2 new tests + Newman net-to-zero assertion will catch any regression.

---

## Cross-cutting: demo-day checklist

These are not workstreams but must happen the day before:

### D-1 final dry run
- [ ] Tear down + rebuild Docker stack from scratch: `cd docker && docker compose down -v && docker compose up -d --build`.
- [ ] Confirm boot logs show `[AI] receipt=bedrock(...) intent=bedrock(...)` and `[Atom] provider=mock`.
- [ ] Run full Newman: `npm run test:e2e` — must be 100% green, **including the new workstream folders**.
- [ ] Run acceptance: `npm run test:acceptance` — must report ✓ on all three fixtures.
- [ ] Run the 3 demo utterances end-to-end via Postman against the live container:
  1. *"Create a group Goa, add Sukant Mohit Kartik, split tonight's dinner, Mohit's veg, put my share in my Goa savings goal."* → expect: group + expense (CONSTRAINT split) + atom contribution.
  2. *"How much does Mohit owe me overall?"* → expect: aggregated balance across groups.
  3. *"Why do I owe 620?"* → expect: narrated explain with the specific items.
- [ ] Manually flag a dispute from one of the resulting expenses; confirm `RESOLVED` flips and audit row exists.

### Fallback rehearsals
The proposal §13 says "judges reward honesty about fallbacks." Have these ready as muscle memory:
- [ ] **Voice fails on stage** → flip to the chat box, paste the same utterance. The command pipeline is identical.
- [ ] **Bedrock latency spike** → registry already falls back to `anthropic` direct; have a fixture screen ready showing it succeeded against a previously cached run.
- [ ] **Atom mock crashes** → goal contribution wraps in a try/catch that logs but doesn't fail the parent settlement. The settle still goes through; you note "atom is mocked, the contribution row didn't write, here's what it would have looked like."

### Environment snapshot
- [ ] Freeze a docker image: `docker compose build && docker tag slicesplit-backend:latest slicesplit-backend:demo-2026-06-08`. This is the artifact you actually run on stage.
- [ ] Snapshot the seeded database to a SQL dump: `docker compose exec postgres pg_dump -U slicesplit slicesplit > demo-seed.sql`. If anything goes sideways, restore in ~5s.

---

## Effort + ownership grid

| WS | Title | Effort | Hard deps | Suggested owner | Risk |
| --- | --- | --- | --- | --- | --- |
| W0 | Pre-flight (creds + health) | ½ day | none | backend lead | Low |
| W1 | Real fixtures + Bedrock pass | 1 day | W0 | backend + 1 person to source bills | **High** — if Bedrock fails on real bills, scope changes |
| W2 | Voice transcript endpoint | 1 day | W0 | backend | Med — Transcribe latency |
| W3 | Atom mock + goals module | 1 day | none | backend | Low — owned code |
| W4 | Time-scoped + recurring | 1 day | W1 (prompt updates) | backend | Low |
| W5 | Multi-payer expense | ½ day | none | backend | Low |

**Total:** ~5 dev-days. If only 3 days available, drop W4 (time-scoped/recurring) and W5 (multi-payer) — neither is in the demo flow, only in §03 / §09 read-out. W0–W3 are non-negotiable for the demo to work.

---

## Order of merge

1. **W0** (blocking; unblocks all)
2. **W1** (validates the AI thesis — do this *before* writing more code on top of Bedrock)
3. **W3** (parallel-safe with W2; finishes the voice showstopper punchline)
4. **W2** (depends on nothing from W1/W3 but slots in last so demo rehearsal can use it)
5. **W5** (parallel-safe with anything)
6. **W4** (depends on W1 prompt updates)
7. **Demo-day checklist** the day before.

---

## What this plan deliberately does NOT include

To stay scoped, I left these out — they are either covered elsewhere or post-demo:

- Real slice Pay / UPI Collect rails — needs slice access; demo uses existing UPI deep-link from PR 2.
- PII redaction pipeline — on hold per your prior call; revisit pre-Phase-2.
- Real Postgres migrations baseline — production-readiness item, not demo-blocking.
- Idempotency-Key middleware — production-readiness item.
- Job queue (BullMQ / pg-boss) — production-readiness item; setImmediate is fine for the demo.
- Notification fan-out — FE concern for the demo; backend audit events already fire.
- Recurring worker as real cron — `setInterval` is acceptable for demo; harden post-demo.
- Multilingual commands — §03 mentions, not in the demo flow.
- WhatsApp forward-a-bill — §03 future-roadmap.
- Trip mode — covered today by groups + simplifyDebts; no schema change needed.
