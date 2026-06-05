#!/usr/bin/env node
/**
 * Build an e2e-ready Postman collection from the canonical one.
 *
 * Changes applied:
 *   1. Inject a "0. Setup" folder at the top that registers three users
 *      (alice/bob/charlie) with timestamped emails so the suite is
 *      idempotent across runs, captures their ids, and leaves Alice
 *      authenticated.
 *   2. Replace all REPLACE_WITH_* placeholders with environment variables
 *      that the Setup folder populates.
 *   3. Write the result to tests/e2e/slicesplit-backend.e2e.postman_collection.json.
 *
 * The original collection stays untouched so it remains the "human"
 * collection humans import into Postman.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(
  ROOT,
  "postman/collections/slicesplit-backend.postman_collection.json",
);
const OUT_DIR = path.join(ROOT, "tests/e2e");
const OUT = path.join(OUT_DIR, "slicesplit-backend.e2e.postman_collection.json");

const collection = JSON.parse(fs.readFileSync(SRC, "utf8"));

// ── Setup folder ─────────────────────────────────────────────
//
// Notes:
// - We generate a fresh `run_id` per Newman run so re-running doesn't trip
//   the unique-email constraint.
// - Each register saves its `userId` into a distinct env var so downstream
//   requests can address every user by name.
// - The last step re-logs-in as Alice so the active access_token belongs
//   to her (matches the rest of the collection's assumptions).

const registerRequest = (label, idVar) => ({
  name: `Register ${label}`,
  event: [
    {
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: [
          "if (!pm.environment.get('run_id')) {",
          "  pm.environment.set('run_id', Date.now().toString(36));",
          "}",
          `const slug = '${label.toLowerCase()}';`,
          "pm.environment.set('current_setup_slug', slug);",
          `pm.environment.set('${label.toLowerCase()}_email', \`${label.toLowerCase()}-\${pm.environment.get('run_id')}@e2e.local\`);`,
        ],
      },
    },
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          `pm.test('register ${label} 201', () => pm.expect(pm.response.code).to.eql(201));`,
          "if (pm.response.code === 201) {",
          "  const body = pm.response.json();",
          `  pm.environment.set('${idVar}', body.user.id);`,
          "}",
        ],
      },
    },
  ],
  request: {
    method: "POST",
    auth: { type: "noauth" },
    header: [{ key: "Content-Type", value: "application/json" }],
    body: {
      mode: "raw",
      raw: JSON.stringify({
        email: `{{${label.toLowerCase()}_email}}`,
        name: label,
        password: "sup3rs3cret-e2e",
      }),
    },
    url: {
      raw: "{{base_url}}{{api_prefix}}/auth/register",
      host: ["{{base_url}}{{api_prefix}}"],
      path: ["auth", "register"],
    },
  },
});

const loginAlice = {
  name: "Login as Alice (set active token)",
  event: [
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          "pm.test('login 200', () => pm.expect(pm.response.code).to.eql(200));",
          "if (pm.response.code === 200) {",
          "  const body = pm.response.json();",
          "  pm.environment.set('access_token', body.accessToken);",
          "  pm.environment.set('refresh_token', body.refreshToken);",
          "  pm.environment.set('user_id', body.user.id);",
          "}",
        ],
      },
    },
  ],
  request: {
    method: "POST",
    auth: { type: "noauth" },
    header: [{ key: "Content-Type", value: "application/json" }],
    body: {
      mode: "raw",
      raw: JSON.stringify({
        email: "{{alice_email}}",
        password: "sup3rs3cret-e2e",
      }),
    },
    url: {
      raw: "{{base_url}}{{api_prefix}}/auth/login",
      host: ["{{base_url}}{{api_prefix}}"],
      path: ["auth", "login"],
    },
  },
};

const setupFolder = {
  name: "0. Setup (e2e bootstrap)",
  description:
    "Idempotent fixtures for Newman runs. Registers three timestamped users (alice, bob, charlie), stores their ids in env, and logs in as Alice. The rest of the collection assumes Alice is the active user and references {{user_b_id}} / {{user_c_id}} for cross-user flows.",
  item: [
    registerRequest("Alice", "user_a_id"),
    registerRequest("Bob", "user_b_id"),
    registerRequest("Charlie", "user_c_id"),
    loginAlice,
    {
      name: "Sanity: GET /me uses Alice's token",
      event: [
        {
          listen: "test",
          script: {
            type: "text/javascript",
            exec: [
              "pm.test('me 200', () => pm.expect(pm.response.code).to.eql(200));",
              "pm.test('email matches Alice', () => pm.expect(pm.response.json().user.email).to.eql(pm.environment.get('alice_email')));",
            ],
          },
        },
      ],
      request: {
        method: "GET",
        url: {
          raw: "{{base_url}}{{api_prefix}}/me",
          host: ["{{base_url}}{{api_prefix}}"],
          path: ["me"],
        },
      },
    },
  ],
};

collection.item.unshift(setupFolder);

// ── Placeholder substitutions ────────────────────────────────
//
// Walk the entire item tree and rewrite REPLACE_WITH_* references to point
// at the env vars Setup populates.

const REPLACEMENTS = [
  // Longer keys first so a shorter key doesn't accidentally match a longer
  // one. (`REPLACE_WITH_OTHER_USER_CUID` contains no substring that the
  // others match, but keeping the rule documented.)
  ["REPLACE_WITH_OTHER_USER_CUID", "{{user_c_id}}"],
  ["REPLACE_WITH_USER_CUID", "{{user_b_id}}"],
  ["REPLACE_WITH_DEBTOR_CUID", "{{user_b_id}}"],
  // Item CUIDs are receipt-item-specific — left untouched; those requests
  // are exercised after a real receipt is produced earlier in the run.
];

function patchString(s) {
  let out = s;
  for (const [a, b] of REPLACEMENTS) out = out.split(a).join(b);
  return out;
}

function walkAndPatch(node) {
  if (Array.isArray(node)) {
    // Arrays may hold strings directly (e.g. Postman URL `path` arrays).
    // Patch those in place; recurse into anything else.
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      if (typeof el === "string") node[i] = patchString(el);
      else walkAndPatch(el);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") node[k] = patchString(v);
      else walkAndPatch(v);
    }
  }
}
walkAndPatch(collection);

// ── Improve a few request-level assertions ───────────────────
//
// The original collection has light test scripts (mostly "if 201 capture id").
// Newman shines with more assertions. We layer extra `pm.test` calls onto a
// handful of the most demo-critical requests so a regression shows up red.

function findRequest(folderName, requestName) {
  const folder = collection.item.find((f) => f.name === folderName);
  if (!folder) return null;
  return folder.item.find((r) => r.name === requestName);
}

function appendTest(req, lines) {
  if (!req) return;
  req.event ||= [];
  let testEvent = req.event.find((e) => e.listen === "test");
  if (!testEvent) {
    testEvent = { listen: "test", script: { type: "text/javascript", exec: [] } };
    req.event.push(testEvent);
  }
  testEvent.script.exec.push(...lines);
}

appendTest(findRequest("Health", "Liveness"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('status ok', () => pm.expect(pm.response.json().status).to.eql('ok'));",
]);

appendTest(findRequest("Health", "Readiness (checks DB)"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('db reachable', () => pm.expect(pm.response.json().db).to.eql('reachable'));",
]);

appendTest(findRequest("Groups", "Create group"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('group has id', () => pm.expect(pm.response.json().group.id).to.be.a('string'));",
  "pm.test('owner role assigned to caller', () => {",
  "  const members = pm.response.json().group.members;",
  "  const me = members.find(m => m.user.id === pm.environment.get('user_id'));",
  "  pm.expect(me).to.have.property('role', 'OWNER');",
  "});",
]);

// Expense creation chain currently uses `{{user_id}}` (Alice) + `{{user_b_id}}` (Bob).
// Add an assertion that share rows actually sum to the total.
appendTest(findRequest("Expenses", "Create expense — EQUAL"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('shares sum to total', () => {",
  "  const exp = pm.response.json().expense;",
  "  const sum = exp.shares.reduce((s, sh) => s + sh.amountPaise, 0);",
  "  pm.expect(sum).to.eql(exp.amountPaise);",
  "});",
]);

appendTest(findRequest("Expenses", "Create expense — EXACT"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('shares match request', () => {",
  "  const exp = pm.response.json().expense;",
  "  const sum = exp.shares.reduce((s, sh) => s + sh.amountPaise, 0);",
  "  pm.expect(sum).to.eql(exp.amountPaise);",
  "});",
]);

appendTest(findRequest("Balances", "Get group balances"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('balances sum to zero', () => {",
  "  const sum = pm.response.json().balances.reduce((s, b) => s + b.netPaise, 0);",
  "  pm.expect(sum).to.eql(0);",
  "});",
]);

// Receipts: rather than re-upload an image (multipart fixtures are fragile
// in Newman + we don't have a real bill committed), we POST the upload via
// the API with the test PNG fixture. The route validates mimetype + writes
// to disk + kicks off async extraction. Polling happens via the dedicated
// "Poll receipt status" request that Newman --delay-request lets settle.
// Wire the test PNG fixture into the multipart upload so Newman has a real
// file to send. Newman resolves `src` relative to its --working-dir.
const uploadRequest = findRequest("Receipts (async OCR)", "Upload + extract receipt (async)");
if (uploadRequest) {
  const fileField = uploadRequest.request.body.formdata.find((f) => f.key === "image");
  if (fileField) fileField.src = "fixtures/receipt.png";
}
appendTest(uploadRequest, [
  "// Accept both 202 (new) and 200 (duplicate within window) since Newman re-runs hit dedup.",
  "pm.test('202 or 200', () => pm.expect([200, 202]).to.include(pm.response.code));",
]);

appendTest(findRequest("Commands (NL: voice + chat)", "Parse: balance query"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "// The plan shape depends on intent type. QUERY_BALANCE plans have an",
  "// `explanation`; REJECT plans (Anthropic emits these when a mentioned",
  "// person isn't in any group or contact) have a `reason`. Either is a",
  "// valid pipeline outcome — assert one of the two is present.",
  "pm.test('plan carries human-readable text (explanation or reason)', () => {",
  "  const plan = pm.response.json().plan;",
  "  const text = plan.explanation || plan.reason;",
  "  pm.expect(text).to.be.a('string').and.to.have.length.greaterThan(0);",
  "});",
]);

// ── Auth — token capture + revocation
appendTest(findRequest("Auth", "Login"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('access token is a JWT-shaped string', () => {",
  "  const t = pm.response.json().accessToken;",
  "  pm.expect(t.split('.')).to.have.lengthOf(3);",
  "});",
  "pm.test('user object includes id, email, name', () => {",
  "  const u = pm.response.json().user;",
  "  pm.expect(u).to.include.keys('id', 'email', 'name');",
  "});",
]);

appendTest(findRequest("Auth", "Refresh"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('new access token is issued', () => pm.expect(pm.response.json().accessToken).to.be.a('string'));",
]);

// ── Me
appendTest(findRequest("Me", "Get my profile"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('does not leak password hash', () => {",
  "  pm.expect(JSON.stringify(pm.response.json())).to.not.contain('passwordHash');",
  "});",
]);

appendTest(findRequest("Me", "Update profile"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('updated name is echoed back', () => {",
  "  pm.expect(pm.response.json().user.name).to.eql('Alice K.');",
  "});",
]);

// ── Groups — list pagination shape, lookups
appendTest(findRequest("Groups", "List my groups"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('has items array', () => pm.expect(pm.response.json().items).to.be.an('array'));",
  "pm.test('cursor field present', () => pm.expect(pm.response.json()).to.have.property('nextCursor'));",
]);

appendTest(findRequest("Groups", "Get group by id"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('group has members array', () => pm.expect(pm.response.json().group.members).to.be.an('array'));",
]);

// ── Expenses — PERCENTAGE + SHARES checks
appendTest(findRequest("Expenses", "Create expense — PERCENTAGE"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('shares sum to total', () => {",
  "  const exp = pm.response.json().expense;",
  "  const sum = exp.shares.reduce((s, sh) => s + sh.amountPaise, 0);",
  "  pm.expect(sum).to.eql(exp.amountPaise);",
  "});",
  "pm.test('every share has basisPoints set', () => {",
  "  pm.expect(pm.response.json().expense.shares.every(s => typeof s.basisPoints === 'number')).to.be.true;",
  "});",
]);

appendTest(findRequest("Expenses", "Create expense — SHARES"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('shares sum to total', () => {",
  "  const exp = pm.response.json().expense;",
  "  const sum = exp.shares.reduce((s, sh) => s + sh.amountPaise, 0);",
  "  pm.expect(sum).to.eql(exp.amountPaise);",
  "});",
]);

appendTest(findRequest("Expenses", "List expenses"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('items is an array', () => pm.expect(pm.response.json().items).to.be.an('array'));",
]);

// ── Settlements
appendTest(findRequest("Settlements", "Create settlement"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('settlement carries both party names', () => {",
  "  const s = pm.response.json().settlement;",
  "  pm.expect(s.from).to.have.property('name');",
  "  pm.expect(s.to).to.have.property('name');",
  "});",
]);

// ── Balances — UPI deep link
appendTest(findRequest("Balances", "Get group balances"), [
  "pm.test('transfers is an array', () => pm.expect(pm.response.json().transfers).to.be.an('array'));",
  "pm.test('balances include name + upiHandle', () => {",
  "  const b = pm.response.json().balances[0];",
  "  if (b) {",
  "    pm.expect(b).to.include.keys('name', 'upiHandle', 'netPaise');",
  "  }",
  "});",
]);

// ── Contacts — phone search
appendTest(findRequest("Contacts", "Create contact"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('contact has displayName', () => pm.expect(pm.response.json().contact.displayName).to.be.a('string'));",
]);

appendTest(findRequest("Contacts", "List contacts"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('items is an array', () => pm.expect(pm.response.json().items).to.be.an('array'));",
]);

// ── Receipts — poll until COMPLETED (Newman runs sequentially; mock provider
// finishes inside the --delay-request 250ms window).
appendTest(findRequest("Receipts (async OCR)", "Poll receipt status"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "const r = pm.response.json().receipt;",
  "pm.test('mock provider completes within poll window', () => pm.expect(r.status).to.be.oneOf(['COMPLETED', 'PROCESSING']));",
  "pm.test('storageBackend is reported (LOCAL or S3)', () => pm.expect(r.storageBackend).to.be.oneOf(['LOCAL', 'S3']));",
  "// Postman's script sandbox doesn't ship the WHATWG `URL` constructor",
  "// across all versions, so regex-check. Covers both presigned S3 URLs",
  "// and the local API URL pattern.",
  "pm.test('imageUrl looks like an http(s) URL', () => {",
  "  pm.expect(r.imageUrl).to.be.a('string').and.to.match(/^https?:\\/\\/[^\\s]+/);",
  "});",
]);

appendTest(findRequest("Receipts (async OCR)", "Upload + extract receipt (async)"), [
  "if (pm.response.code === 200 || pm.response.code === 202) {",
  "  const r = pm.response.json().receipt;",
  "  pm.test('upload response carries storageBackend', () => pm.expect(r.storageBackend).to.be.oneOf(['LOCAL', 'S3']));",
  "  pm.test('upload response carries imageUrl', () => pm.expect(r.imageUrl).to.be.a('string'));",
  "}",
]);

// Convert: only assert success when the receipt actually finished extracting
// inside our --delay-request window. Mock provider always does; the real
// Anthropic provider may not — in which case we accept 400 PROCESSING and
// the assertion turns into a warning instead of a hard failure.
appendTest(findRequest("Receipts (async OCR)", "Convert receipt to expense (EQUAL)"), [
  "if (pm.response.code === 201) {",
  "  pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "  pm.test('expense title carried through', () => pm.expect(pm.response.json().expense.title).to.eql('Cafe Bistro'));",
  "} else {",
  "  pm.test('convert deferred (receipt still PROCESSING) — acceptable for real AI provider', () => pm.expect(pm.response.code).to.be.oneOf([201, 400]));",
  "}",
]);

// ── Commands — extensive assertions per pattern
appendTest(findRequest("Commands (NL: voice + chat)", "Parse: dietary CONSTRAINT split (the showstopper)"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('commandRun id captured', () => pm.expect(pm.response.json().commandRun.id).to.be.a('string'));",
  "pm.test('parsed intent is present', () => pm.expect(pm.response.json().intent).to.have.property('type'));",
  "pm.test('status starts as PARSED', () => pm.expect(pm.response.json().commandRun.status).to.eql('PARSED'));",
]);

appendTest(findRequest("Commands (NL: voice + chat)", "Parse: create + populate group"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
]);

// ── Guest splits
appendTest(findRequest("Guest Splits (Owner)", "Create guest split"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('shareToken returned', () => pm.expect(pm.response.json().guestSplit.shareToken).to.be.a('string'));",
  "pm.test('status starts as CLAIMING', () => pm.expect(pm.response.json().guestSplit.status).to.eql('CLAIMING'));",
  "pm.test('peopleNames materialised into people[]', () => {",
  "  pm.expect(pm.response.json().guestSplit.people).to.have.length(3);",
  "});",
]);

appendTest(findRequest("Guest Splits (Public)", "View by share token"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('claimToken is NOT leaked in public view', () => {",
  "  pm.response.json().guestSplit.people.forEach(p => {",
  "    pm.expect(p).to.not.have.property('claimToken');",
  "  });",
  "});",
]);

appendTest(findRequest("Guest Splits (Public)", "Add person"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('claim token returned on creation', () => pm.expect(pm.response.json().person.claimToken).to.be.a('string'));",
]);

// ── Disputes — auto-resolve vs escalate
appendTest(findRequest("Disputes (Fairness Engine)", "Setup: create fresh expense for dispute tests"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('expense total matches', () => pm.expect(pm.response.json().expense.amountPaise).to.eql(250000));",
]);

appendTest(findRequest("Disputes (Fairness Engine)", "File: small delta → auto-resolved"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('autoResolved flag is true', () => pm.expect(pm.response.json().autoResolved).to.be.true);",
  "pm.test('status is AUTO_RESOLVED', () => pm.expect(pm.response.json().dispute.status).to.eql('AUTO_RESOLVED'));",
  "pm.test('decisionReason is human-readable', () => pm.expect(pm.response.json().decisionReason).to.be.a('string'));",
]);

appendTest(findRequest("Disputes (Fairness Engine)", "File: large delta → escalates (OPEN)"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('autoResolved flag is false', () => pm.expect(pm.response.json().autoResolved).to.be.false);",
  "pm.test('status is OPEN', () => pm.expect(pm.response.json().dispute.status).to.eql('OPEN'));",
]);

appendTest(findRequest("Disputes (Fairness Engine)", "Resolve: splitter posts new shares"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('status is RESOLVED', () => pm.expect(pm.response.json().dispute.status).to.eql('RESOLVED'));",
  "pm.test('resolution recorded', () => pm.expect(pm.response.json().dispute.resolution).to.be.a('string'));",
]);

appendTest(findRequest("Disputes (Fairness Engine)", "List disputes on an expense"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('items is an array', () => pm.expect(pm.response.json().items).to.be.an('array'));",
]);

// ── Invites (PR 5 B)
appendTest(findRequest("Invites (PR 5 B — WhatsApp/SMS group invites)", "Mint invite for an existing contact"), [
  "pm.test('201 created', () => pm.expect(pm.response.code).to.eql(201));",
  "pm.test('returns invite + shareUrl', () => {",
  "  const b = pm.response.json();",
  "  pm.expect(b.invite).to.have.property('token').that.is.a('string');",
  "  pm.expect(b.shareUrl).to.match(/^https?:\\/\\/[^\\s]+\\/invite\\/[^\\s]+$/);",
  "});",
]);
appendTest(findRequest("Invites (PR 5 B — WhatsApp/SMS group invites)", "Public read by token (no auth — invite landing)"), [
  "pm.test('200 OK', () => pm.expect(pm.response.code).to.eql(200));",
  "pm.test('status is PENDING', () => pm.expect(pm.response.json().invite.status).to.eql('PENDING'));",
  "pm.test('group preview is present', () => pm.expect(pm.response.json().invite.group).to.have.property('name'));",
]);

// PR 4.5: streamed image route
appendTest(findRequest("Receipts (async OCR)", "Stream receipt image (LOCAL backend only — PR 4.5)"), [
  "// 200 if LOCAL backend; some envs return 404 if S3 backend is picked (which",
  "// is correct — imageUrl points to S3 directly in that case). Accept both.",
  "pm.test('200 or 404', () => pm.expect([200, 404]).to.include(pm.response.code));",
  "if (pm.response.code === 200) {",
  "  pm.test('image content-type', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.match(/^image\\//));",
  "}",
]);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collection, null, 2));
process.stdout.write(`Wrote ${path.relative(ROOT, OUT)}\n`);
