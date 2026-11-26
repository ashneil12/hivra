import { expect, test } from '@playwright/test';

const CLAIM_LAUNCH = '/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE';

test.use({ javaScriptEnabled: false });

test('the standing account follows the Venice claim link to the protected Launch document', async ({ page, baseURL }) => {
  await page.goto('/venice', { waitUntil: 'domcontentloaded' });

  const claim = page.locator('[data-cta="venice-promo-claim"]');
  await expect(claim).toBeVisible();
  await expect(claim).toHaveAttribute('href', CLAIM_LAUNCH);

  const launchUrl = new URL(CLAIM_LAUNCH, baseURL);
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.request().isNavigationRequest() && response.url() === launchUrl.href),
    claim.click(),
  ]);
  expect(response.ok()).toBe(true);
  await expect(page).toHaveURL(launchUrl.href);
});
