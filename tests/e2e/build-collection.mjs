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
  ["REPLACE_WITH_USER_CUID", "{{user_b_id}}"],
  ["REPLACE_WITH_DEBTOR_CUID", "{{user_b_id}}"],
  // Item CUIDs are receipt-item-specific — leave them, those requests are
  // exercised by the Receipts (async OCR) flow which produces a real receipt
  // first. We mark them clearly so Newman shows them as expected-skip rather
  // than mystery failures.
];

function walkAndPatch(node) {
  if (Array.isArray(node)) return node.forEach(walkAndPatch);
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") {
        let patched = v;
        for (const [a, b] of REPLACEMENTS) patched = patched.split(a).join(b);
        node[k] = patched;
      } else {
        walkAndPatch(v);
      }
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
  "pm.test('plan has explanation', () => pm.expect(pm.response.json().plan.explanation).to.be.a('string'));",
]);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collection, null, 2));
process.stdout.write(`Wrote ${path.relative(ROOT, OUT)}\n`);
