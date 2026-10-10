import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Tier-3 SYNTHETIC USER JOURNEY A: Launch readiness (assert-only).
 *
 * Walks the bounded Canary path from Choose -> Codex plan -> Review.
 * Routine CI must stop before Launch so it cannot provision a VM. Actual
 * provisioning remains double-gated by the dedicated first-run audit.
 */

function isAuthed(): boolean {
  try {
    const state = JSON.parse(readFileSync('e2e/.auth/qa-user.json', 'utf8'));
    return (state.cookies?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

test.describe('Tier 3 Journey A: Launch Readiness', () => {
  test.skip(!isAuthed(), 'No authenticated QA session (CLERK_SECRET_KEY/QA_USER_ID not set).');

  test('walks Choose -> Codex plan -> exact Review without provisioning', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const response = await page.goto('/dashboard/launch?kind=agent', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('body')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('body')).not.toContainText(/sign in|signed out/i);

    await expect(page.getByRole('heading', { name: 'What do you want to launch?' })).toBeVisible({ timeout: 20_000 });
    // Choosing a tile goes straight to the plan; there is no Continue step.
    await page.getByRole('button', { name: /^Codex/i }).click();

    await expect(page.getByRole('heading', { name: "Codex — here's the plan" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByRole('button', { name: /Hivra Cloud/i })).toHaveAttribute('aria-pressed', 'true');

    const continueCta = page.getByTestId('launch-primary-action');
    const capacityAlert = page.getByRole('alert').filter({
      hasText: /no open agent slots|needs [\d.]+ CPU \/ [\d.]+ GB|is set to use up to|needs a paid (managed )?plan|could not be verified/i,
    });
    const readiness = async () => {
      if (await continueCta.isEnabled()) return 'ready';
      if (await capacityAlert.isVisible()) return 'blocked';
      return 'pending';
    };

    await expect.poll(readiness, { timeout: 15_000 }).not.toBe('pending');
    if ((await readiness()) === 'ready') {
      await continueCta.click();
      await expect(page.getByRole('heading', { name: /^Review and launch/ })).toBeVisible();
      const review = page.getByLabel('Launch review');
      await expect(review).toContainText('Codex');
      await expect(review).toContainText('Hivra Cloud');
      await expect(review).toContainText('Sign in to ChatGPT inside Codex after it opens.');
      await expect(page.getByRole('button', { name: 'Launch Codex' })).toBeEnabled();
    } else {
      await expect(continueCta).toBeDisabled();
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
