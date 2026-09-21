import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Tier-1 GOLDEN PATH (authed): the flow Ash flagged as "sometimes just breaks" —
 * logged-in user lands on the dashboard and can kick off a deploy.
 *
 * Auth comes from e2e/.auth/qa-user.json (minted in global-setup via the Clerk
 * ticket). If that state is empty (secrets absent), every test here SKIPS rather
 * than failing — so the suite degrades gracefully on forks/no-secret runs.
 *
 * The deploy assertions use intentionally loose, role/text-based locators with
 * TODO markers — tighten them to real selectors/`data-testid`s as the flow is
 * confirmed. This file is the skeleton of the contract; fill the selectors in.
 */

function isAuthed(): boolean {
  try {
    const s = JSON.parse(readFileSync('e2e/.auth/qa-user.json', 'utf8'));
    return (s.cookies?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

test.describe('golden path: dashboard + deploy', () => {
  test.skip(!isAuthed(), 'No authenticated QA session (CLERK_SECRET_KEY/QA_USER_ID not set).');

  // Selectors below are first-pass guesses against live canary. Tightened after
  // the first real run rather than left disabled — a .fixme test that never
  // executes provides zero protection, which is how this golden path went
  // untested for weeks.
  test('dashboard shell loads for the QA user', async ({ page }) => {
    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(resp!.status()).toBeLessThan(400);
    // Signed-in proof: the Clerk user button / an authed-only shell element.
    // TODO: replace with a stable data-testid on the dashboard shell.
    await expect(
      page.locator('[data-clerk-user-button], [data-testid="dashboard-shell"], header'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('body')).not.toContainText(/sign in|signed out/i);
  });

  // Assert-only: confirms the deploy entry point exists and is clickable
  // without actually clicking it. Clicking would fire a real provisioning
  // call against live canary (real Hetzner/Proxmox infra, real billing) on
  // every test run — that's why this was fixme'd, not bureaucracy. A
  // separate, explicitly-guarded test can cover the actual click path later.
  //
  // No VRT screenshot here on purpose: baselines must be generated on the
  // Linux CI runner per playwright.config.ts, and this was run locally on
  // macOS. A darwin-generated baseline would fail every Linux CI run on
  // font-rendering noise, not real breakage. Add toHaveScreenshot back once
  // this runs in CI and can generate its own baseline.
  test('deploy control is reachable', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    const deployTrigger = page.getByRole('button', { name: /deploy|launch|new (instance|agent)/i });
    await expect(deployTrigger.first()).toBeVisible({ timeout: 20_000 });
    await expect(deployTrigger.first()).toBeEnabled();
  });
});
