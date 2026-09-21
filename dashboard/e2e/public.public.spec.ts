import { test, expect } from '@playwright/test';

/**
 * Tier-1 public smoke + VRT. No auth. Runs against the deployed target.
 *
 * Goal: catch the "a marketing/entry route 500s or renders blank after a deploy"
 * class cheaply, on every PR — plus a visual baseline so layout regressions get
 * flagged without anyone clicking around.
 *
 * VRT baselines are generated on the Linux CI runner (npm run test:e2e:update),
 * never committed from macOS. Until a baseline exists, toHaveScreenshot creates
 * one and the assertion is skipped on that first run.
 */

// Public routes that should always render for a logged-out visitor.
const PUBLIC_ROUTES: Array<{ path: string; expect: RegExp }> = [
  { path: '/', expect: /Hivra|Deploy/i },
  { path: '/features', expect: /feature/i },
  { path: '/why-hivra', expect: /Hivra/i },
  { path: '/get-started', expect: /start|deploy|get/i },
  { path: '/sign-in', expect: /sign|continue|email/i },
];

for (const route of PUBLIC_ROUTES) {
  test(`public route renders: ${route.path}`, async ({ page }) => {
    const resp = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
    // 1) HTTP is healthy (no 5xx after a deploy).
    expect(resp, `no response for ${route.path}`).toBeTruthy();
    expect(resp!.status(), `bad status for ${route.path}`).toBeLessThan(400);
    // 2) The page actually rendered meaningful content (not a blank error shell).
    await expect(page.locator('body')).toContainText(route.expect, { timeout: 15_000 });
    // 3) No obvious client crash surfaced to the user.
    await expect(page.locator('body')).not.toContainText(/Application error|Internal Server Error/i);
  });

  // VRT is fixme until baselines are generated ON the Linux runner
  // (`gh workflow run dashboard-e2e.yml -f update_snapshots=true`), committed,
  // then flipped to `test(...)`. Avoids a first-run "no baseline" failure.
  test.fixme(`visual baseline: ${route.path}`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: 'networkidle' });
    // Mask volatile regions (carousels, live counters) as you discover them:
    // await expect(page).toHaveScreenshot({ mask: [page.locator('[data-vrt-mask]')] });
    await expect(page).toHaveScreenshot(`${route.path.replace(/\W+/g, '_') || 'home'}.png`, {
      fullPage: true,
    });
  });
}
