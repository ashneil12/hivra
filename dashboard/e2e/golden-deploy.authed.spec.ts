import { test, expect } from '@playwright/test';
import { CANARY_QA_EMAIL_ENV } from './canary-qa/config';

/**
 * Tier-1 signed-in golden path: the dashboard opens and its Launch link
 * reaches the chooser without provisioning anything.
 */

test.describe('golden path: dashboard + deploy', () => {
  test.skip(!process.env[CANARY_QA_EMAIL_ENV], `${CANARY_QA_EMAIL_ENV} is not set.`);

  test('dashboard shell loads for the QA user', async ({ page }) => {
    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(resp?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/dashboard\/?(?:\?.*)?$/);
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible();
  });

  test('deploy control is reachable', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    const navigation = page.getByRole('complementary', { name: 'Workspace navigation' });
    const launch = navigation.getByRole('link', { name: 'Launch', exact: true });
    await expect(launch).toHaveAttribute('href', '/dashboard/launch');
    await launch.click();
    await expect(page.getByRole('heading', { name: 'What do you want to launch?', exact: true })).toBeVisible();
  });
});
