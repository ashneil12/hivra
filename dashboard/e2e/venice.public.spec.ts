import { test, expect } from '@playwright/test';

/**
 * Venice acquisition public contract. No auth and no paid infrastructure.
 *
 * These checks intentionally stop at the auth boundary. They prove that the
 * unsigned landing page preserves the exact Launch deep link and attribution
 * the signed-in journey depends on.
 */
const HERMES_LAUNCH = '/dashboard/launch?agent=hermes&inference=venice&ref=venice';
const CLAIM_LAUNCH = `${HERMES_LAUNCH}&code=VENICE`;
const CLAIM_HREF = `/sign-up?redirect_url=${encodeURIComponent(CLAIM_LAUNCH)}`;

test('Venice landing renders the launch offer and exact claim handoff', async ({ page }) => {
  const response = await page.goto('/venice', { waitUntil: 'domcontentloaded' });

  expect(response, 'no response for /venice').toBeTruthy();
  expect(response!.status(), 'bad status for /venice').toBeLessThan(400);
  await expect(page.getByRole('heading', { name: /Run your Venice agent 24\/7/i })).toBeVisible();

  const promo = page.locator('[data-venice-promo]');
  await expect(promo).toBeVisible();
  await expect(promo).toContainText('$10');
  await expect(promo).toContainText('VENICE');

  const claim = page.locator('[data-cta="venice-promo-claim"]');
  await expect(claim).toHaveAttribute('href', CLAIM_HREF);
});

test('Venice landing stores first-party attribution for the auth journey', async ({ page, context }) => {
  await page.goto('/venice', { waitUntil: 'domcontentloaded' });

  await expect
    .poll(async () => {
      const cookie = (await context.cookies()).find((entry) => entry.name === 'hivra_venice_attr');
      return cookie ? decodeURIComponent(cookie.value) : '';
    })
    .toContain('ref=venice');
});

test('promo claim enters sign-up with the Venice Launch return intact', async ({ page }) => {
  await page.goto('/venice', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-cta="venice-promo-claim"]').click();

  await expect(page).toHaveURL(/\/sign-up(?:\/|$|\?)/);
  const url = new URL(page.url());
  expect(url.searchParams.get('redirect_url')).toBe(CLAIM_LAUNCH);
});

test('agent tile auth redirect preserves the Venice Launch deep link', async ({ page }) => {
  await page.goto('/venice', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-cta="venice-agent-hermes"]').click();

  await expect(page).toHaveURL(/\/sign-in(?:\/|$|\?)/);
  const url = new URL(page.url());
  const redirectTarget = url.searchParams.get('redirect_url');
  expect(redirectTarget).toBeTruthy();

  // Clerk middleware emits an absolute same-origin URL, while hand-written
  // auth links use a relative path. Clerk accepts either form; the contract is
  // that no external target smuggles itself in and the Launch path survives.
  if (redirectTarget!.startsWith('/')) {
    expect(redirectTarget).toBe(HERMES_LAUNCH);
  } else {
    const target = new URL(redirectTarget!);
    expect(target.origin).toBe(url.origin);
    expect(`${target.pathname}${target.search}`).toBe(HERMES_LAUNCH);
  }
});

