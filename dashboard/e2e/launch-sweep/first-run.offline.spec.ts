import { expect, test } from '@playwright/test';

import { acknowledgeOpenHandsUsageConsent, proveChat } from './chat';
import { launchFromTile } from './journey';
import type { SweepTarget } from './targets';

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

const openHands: SweepTarget = { profileId: 'openhands', tile: 'OpenHands', kind: 'agent', proof: 'agent-ui-chat' };
const question = { prompt: 'What is 517 plus 312? Reply with just the number.', answer: '829' };

for (const needsProvider of [false, true]) {
  test(`opens the native OpenHands composer without changing provider settings (provider required: ${needsProvider})`, async ({ page }) => {
    await page.setContent('<iframe title="OpenHands · dashboard" style="width:750px;height:520px"></iframe>');
    await page.locator('iframe').evaluate((iframe, blocked) => {
      (iframe as HTMLIFrameElement).srcdoc = `
        <style>html, body { overflow: clip; }</style>
        <section data-testid="onboarding-modal">
          <button role="radio" aria-checked="true" data-testid="onboarding-agent-option-openhands">OpenHands</button>
          <button onclick="document.body.dataset.next = 'clicked'">Next</button>
          <button data-testid="onboarding-skip" onclick="this.closest('section').remove(); document.querySelector('main').hidden = false">Skip for now</button>
          <div contenteditable="true" style="position:absolute;left:2000px;width:240px">Offscreen wizard field</div>
        </section>
        <main hidden>
          ${blocked ? '<h2>Connect a provider</h2><input type="password" aria-label="API key">' : `
            <div data-testid="chat-input" contenteditable="true"></div><output></output>
            <script>document.querySelector('[data-testid=chat-input]').addEventListener('keydown', function (event) {
              if (event.key !== 'Enter' || !this.textContent.includes('517 plus 312')) return;
              event.preventDefault();
              this.textContent = '';
              document.querySelector('output').textContent = '829';
            })</script>
          `}
        </main>`;
    }, needsProvider);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByTestId('onboarding-modal')).toBeVisible();
    const proof = proveChat(page, openHands, { composerTimeoutMs: 2_000, replyTimeoutMs: 10_000, question });
    if (needsProvider) {
      await expect(proof).rejects.toThrow(/requires external sign-in or provider setup/);
      await expect(frame.getByLabel('API key')).toHaveValue('');
    } else {
      await expect(proof).resolves.toMatchObject({ surface: 'OpenHands web UI' });
      await expect(frame.locator('output')).toHaveText('829');
    }
    await expect(frame.getByTestId('onboarding-modal')).toHaveCount(0);
    await expect(frame.locator('body')).not.toHaveAttribute('data-next', 'clicked');
  });
}

test('does not launch OpenHands without a verified Hivra credits option', async ({ page }) => {
  await page.route('**/dashboard/launch', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <main data-testid="launch-journey">
        <h1>What do you want to launch?</h1>
        <button><strong>OpenHands</strong></button>
        <h2>Review and launch OpenHands</h2>
        <label>Agent name <input></label>
        <div role="group" aria-label="Model access"><button><strong>Bring your own key</strong></button></div>
        <button data-testid="launch-primary-action">Launch</button>
      </main>`,
  }));
  let requested = false;
  await expect(launchFromTile(page, openHands, 'abcd1234', () => { requested = true; }))
    .rejects.toThrow(/requires the Hivra credits launch option/);
  expect(requested).toBe(false);
});

test('does not treat the offscreen agent choice as an active onboarding step', async ({ page }) => {
  await page.setContent('<iframe title="OpenHands · dashboard"></iframe>');
  await page.locator('iframe').evaluate((iframe) => {
    (iframe as HTMLIFrameElement).srcdoc = `
      <section data-testid="onboarding-modal">
        <div aria-hidden="true" style="position:absolute;left:2000px">
          <button role="radio" aria-checked="true" data-testid="onboarding-agent-option-openhands">OpenHands</button>
        </div>
        <h2>Connect a provider</h2>
        <button data-testid="onboarding-skip" onclick="this.closest('section').remove()">Skip for now</button>
      </section>`;
  });
  await expect(proveChat(page, openHands, { composerTimeoutMs: 2_000, replyTimeoutMs: 10_000, question }))
    .rejects.toThrow(/cannot preserve its default agent/);
  await expect(page.frameLocator('iframe').getByTestId('onboarding-modal')).toBeVisible();
});
