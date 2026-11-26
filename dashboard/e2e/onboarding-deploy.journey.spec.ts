import { test, expect } from '@playwright/test';
import { CANARY_QA_EMAIL_ENV } from './canary-qa/config';

/**
 * Tier-3 SYNTHETIC USER JOURNEY A: Launch readiness (assert-only).
 *
 * Walks the bounded Canary path from Choose to Codex review.
 * Routine CI must stop before Launch so it cannot provision a VM. Actual
 * provisioning remains double-gated by the dedicated first-run audit.
 */

test.describe('Tier 3 Journey A: Launch Readiness', () => {
  test.skip(!process.env[CANARY_QA_EMAIL_ENV], `${CANARY_QA_EMAIL_ENV} is not set.`);

  test('walks from Choose to Codex review without provisioning', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const response = await page.goto('/dashboard/launch?kind=agent', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/dashboard\/launch\?kind=agent$/);
    const chooser = page.getByRole('region', { name: 'What do you want to launch?', exact: true });
    await chooser.getByRole('button', { name: /^Codex\b/ }).click();

    const review = page.getByRole('region', { name: /^Review and launch Codex\b/ });
    await expect(review.getByRole('textbox', { name: 'Agent name' })).toHaveValue(/^Codex\b/);
    const settings = review.getByRole('group', { name: 'Launch settings' });
    await settings.getByRole('button', { name: 'Change where it runs', exact: true }).click();
    await expect(settings.getByRole('button', { name: /^Hivra Cloud\b/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(settings.getByRole('button', { name: 'Sign in with my existing account', exact: true })).toBeVisible();
    await expect(settings.getByText(/^Use an eligible ChatGPT account after Codex opens/)).toBeVisible();

    const launch = review.getByRole('button', { name: 'Launch Codex', exact: true });
    await expect(launch).toBeVisible();
    const capacityAlert = review.getByRole('alert').filter({
      hasText: /no open agent slots|needs [\d.]+ CPU \/ [\d.]+ GB|is set to use up to|needs a paid (managed )?plan|could not be verified/i,
    });
    const readiness = async () => {
      if (await launch.isEnabled()) return 'ready';
      if (await capacityAlert.isVisible()) return 'blocked';
      return 'pending';
    };

    await expect.poll(readiness, { timeout: 15_000 }).not.toBe('pending');
    if (await launch.isDisabled()) {
      await expect(capacityAlert).toBeVisible();
    }

    const fatalErrors = consoleErrors.filter(
      (error) =>
        !error.includes('favicon') &&
        !error.includes('PostHog') &&
        !error.includes('404') &&
        !error.includes('Failed to load resource'),
    );
    expect(fatalErrors).toHaveLength(0);

    // DO NOT CLICK Launch Codex. This journey is deliberately assert-only.
  });
});
