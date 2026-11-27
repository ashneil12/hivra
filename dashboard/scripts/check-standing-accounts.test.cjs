const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { scan, violations } = require('./check-standing-accounts.cjs');

test('rejects Clerk SDK, REST and browser e2e signup attempts', () => {
  const examples = [
    'await clerk.users.createUser({ emailAddress: [email] })',
    'const { createInvitation: invite } = clerk.invitations; await invite({ emailAddress: email })',
    'await clerk.invitations?.["createInvitation"]({ emailAddress: email })',
    "await clerkFetch(key, '/invitations', { method: 'POST', body })",
    "await fetch('https://api.clerk.com/v1/users', { method: 'POST' })",
    'curl --request POST https://api.clerk.com/v1/users ',
    'await page.request.post("https://instance.clerk.accounts.dev/v1/client/sign_ups")',
    'await window.Clerk.client.signUp.create({ emailAddress: email })',
    'await page.goto("/sign-up"); await page.locator("input").fill(email)',
    'await page.goto("/sign-up"); await page.getByRole("button", { name: "Create account" }).click()',
    'await page.locator("[data-cta=venice-promo-claim]").click(); await page.keyboard.type(code)',
    'await ensureCanaryQaAccount(options)',
  ];
  for (const example of examples) assert.notEqual(violations('test/run.ts', example).length, 0, example);
});

test('allows standing sign-in, read-only signup assertions, and the exact repair module', () => {
  for (const example of [
    'await page.goto("/sign-in"); await page.locator("input").fill(email)',
    'await page.locator("[data-cta=venice-promo-claim]").click(); await expect(page).toHaveURL("/sign-up")',
    'await fetch("https://api.clerk.com/v1/users", { method: "GET" })',
  ]) assert.deepEqual(violations('test/run.ts', example), []);
  const repair = 'await fetch("https://api.clerk.com/v1/users", { method: "POST" })';
  assert.deepEqual(violations('dashboard/scripts/lib/repair-canary-qa-account.ts', repair), []);
  assert.notEqual(violations('dashboard/scripts/lib/another-account.ts', repair).length, 0);
  assert.notEqual(violations('dashboard/scripts/lib/repair-canary-qa-account.ts', repair.replace('/users', '/invitations')).length, 0);
});

test('tree scan reports a new harness outside the dashboard', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'standing-accounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(path.join(root, 'new-harness.sh'), 'curl -X POST https://api.clerk.com/v1/invitations\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'npm run qa:canary-account' } }));
  assert.deepEqual(scan(root), [
    'new-harness.sh: Clerk account or invitation creation',
    'package.json: standing-account repair invoked outside its operator entry point',
  ]);
});
