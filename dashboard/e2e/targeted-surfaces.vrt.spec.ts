import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Tier-2 TARGETED VISUAL REGRESSION TESTING (VRT):
 * Targeted VRT specs for the 3 core business surfaces agreed upon with lead (@Fizz):
 *   1. Launch (/dashboard/launch), the one place agents and computers start
 *   2. Pricing & Plans Surface (/dashboard/billing)
 *   3. Dashboard Main Shell (/dashboard)
 *
 * Baselines are generated on Linux CI runners (dashboard-e2e.yml) to avoid OS font/rendering noise.
 */

function isAuthed(): boolean {
  try {
    const s = JSON.parse(readFileSync('e2e/.auth/qa-user.json', 'utf8'));
    return (s.cookies?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

test.describe('Tier 2 Targeted VRT Surfaces', () => {
  test.skip(!isAuthed(), 'No authenticated QA session (CLERK_SECRET_KEY/QA_USER_ID not set).');

  test('VRT Surface 1: Launch (/dashboard/launch)', async ({ page }) => {
    const resp = await page.goto('/dashboard/launch?start=1', { waitUntil: 'domcontentloaded' });
    expect(resp!.status()).toBeLessThan(400);

    // Wait for the Choose screen to settle
    await expect(page.locator('body')).not.toContainText(/sign in|signed out/i);
    await expect(page.getByRole('heading', { name: 'What do you want to launch?' })).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Visual snapshot assertion (Linux baseline generated in CI)
    await expect(page).toHaveScreenshot('vrt-launch-choose.png', {
      mask: [page.locator('[data-clerk-user-button]')],
      maxDiffPixelRatio: 0.05,
    });
  });

  test('VRT Surface 2: Pricing & Plans Surface (/dashboard/billing)', async ({ page }) => {
    const resp = await page.goto('/dashboard/billing', { waitUntil: 'domcontentloaded' });
    expect(resp!.status()).toBeLessThan(400);

    await expect(page.locator('body')).not.toContainText(/sign in|signed out/i);
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page).toHaveScreenshot('vrt-pricing-plans.png', {
      mask: [page.locator('[data-clerk-user-button]')],
      maxDiffPixelRatio: 0.05,
    });
  });

  test('VRT Surface 3: Dashboard Main Shell (/dashboard)', async ({ page }) => {
    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(resp!.status()).toBeLessThan(400);

    await expect(page.locator('header, [data-testid="dashboard-shell"], nav').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page).toHaveScreenshot('vrt-dashboard-shell.png', {
      mask: [page.locator('[data-clerk-user-button]')],
      maxDiffPixelRatio: 0.05,
    });
  });
});
