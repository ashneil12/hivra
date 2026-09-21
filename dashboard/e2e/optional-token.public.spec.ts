import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`product to optional token journey at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('main')).not.toContainText(/\$HIVRA|\$HermesOS/);
    if (width < 1200) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const nav = page.getByRole('navigation', { name: width < 1200 ? 'Mobile navigation' : 'Primary navigation', exact: true });
    await expect(nav.getByRole('link', { name: 'Token', exact: true })).toHaveCount(0);
    await nav.getByRole('link', { name: 'Ecosystem', exact: true }).click();
    await expect(page).toHaveURL(/\/ecosystem$/);
    await expect(page).toHaveTitle(/Hivra ecosystem/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const main = page.locator('main');
    for (const name of ['Gate', 'Exchange', 'Arena', 'Signal', 'Vault', 'Passport', 'Seal', 'Rescue', 'Challenges', 'Experience', 'Missions', 'Foundry', 'Colony', 'Interchange', 'Ports']) {
      await expect(main).toContainText(`${name}:`);
    }
    await main.getByRole('link', { name: 'Token: current access and proposals' }).click();
    await expect(page).toHaveURL(/\/token$/);
    await expect(page).toHaveTitle(/current access and proposals/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(main).toContainText('0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3');
    await expect(main.getByRole('heading', { name: 'The proposed $HIVRA migration' })).toBeVisible();
    await main.getByRole('link', { name: 'Open Billing & Access' }).click();
    await expect(page).toHaveURL(/\/sign-in|\/dashboard\/billing/);
    await expect(page.locator('body')).not.toContainText(/Application error|Internal Server Error/);
  });
}
