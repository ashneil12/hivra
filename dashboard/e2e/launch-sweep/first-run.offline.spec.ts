import { expect, test } from '@playwright/test';

import { acknowledgeOpenHandsUsageConsent } from './chat';

for (const label of ['Confirm', 'Confirm preferences']) {
  test(`declines OpenHands telemetry before clicking "${label}"`, async ({ page }) => {
    await page.setContent(`
      <dialog open>
        <h2>Help improve OpenHands</h2>
        <p>We collect anonymous usage data to improve the product.</p>
        <label><input type="checkbox" checked>Send anonymous usage data</label>
        <button onclick="this.closest('dialog').close()">${label}</button>
      </dialog>
    `);

    await expect(page.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await acknowledgeOpenHandsUsageConsent(page.mainFrame())).toBe(true);
    await expect(page.getByRole('checkbox', { includeHidden: true })).not.toBeChecked();
    await expect(page.getByRole('dialog')).toBeHidden();
  });
}

test('leaves a different consent screen untouched', async ({ page }) => {
  await page.setContent(`
    <dialog open>
      <h2>Help improve another app</h2>
      <label><input type="checkbox" checked>Send anonymous usage data</label>
      <button>Confirm preferences</button>
    </dialog>
  `);

  expect(await acknowledgeOpenHandsUsageConsent(page.mainFrame())).toBe(false);
  await expect(page.getByRole('checkbox')).toBeChecked();
});
