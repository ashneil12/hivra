import { expect, test } from '@playwright/test';
import { proveRustpadCollaboration } from './launch-sweep/app-open';
import type { SweepTarget } from './launch-sweep/targets';

const workspace = 'https://workspace.example.test';
const app = 'https://rustpad.example.test';
const target: SweepTarget = { profileId: 'rustpad', tile: 'Rustpad', kind: 'agent', proof: 'app-open' };

for (const relayEdits of [true, false]) {
  test(relayEdits ? 'Rustpad proof closes the workspace overlay before typing' : 'Rustpad proof requires the edit in the peer, not just the primary tab', async ({ context, page }) => {
    let workspaceVisits = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === workspace && url.pathname === '/dashboard/agent/fixture') {
        const visit = ++workspaceVisits;
        return route.fulfill({ contentType: 'text/html', body: `
          <iframe title="Rustpad · dashboard" src="${app}/app/#pad${visit}" style="width: 600px; height: 300px"></iframe>
          ${visit === 1 ? `
          <div data-testid="agent-pill-scrim" style="position:fixed; inset:0"></div>
          <button style="position:fixed; top:0; right:0" onclick="document.querySelector('[data-testid]').remove(); this.remove()">Close controls</button>
          ` : ''}
        ` });
      }
      if (url.origin === app && url.pathname === '/app/') {
        return route.fulfill({ contentType: 'text/html', body: `
          <p>You are connected!</p><p>Rustpad collaboration fixture</p>
          <div class="monaco-editor"><div class="view-lines" contenteditable="true" style="height:120px"></div></div>
          <script>
            const editor = document.querySelector('.view-lines');
            if (${relayEdits}) {
              editor.addEventListener('input', () => localStorage.setItem(location.hash, editor.textContent));
              window.addEventListener('storage', event => {
                if (event.key === location.hash) editor.textContent = event.newValue;
              });
            }
          </script>
        ` });
      }
      return route.abort();
    });
    await page.goto(`${workspace}/dashboard/agent/fixture`);
    await expect(page.getByTestId('agent-pill-scrim')).toBeVisible();
    const result = proveRustpadCollaboration(page, target, 3_000);
    if (relayEdits) {
      await expect(result).resolves.toMatchObject({
        textSample: 'A typed marker appeared in the second tab without a refresh.',
      });
    } else {
      await expect(result).rejects.toThrow('could not observe the typed marker in the second tab without refreshing');
    }
    await expect(page.getByTestId('agent-pill-scrim')).toBeHidden();
    await expect(page.frameLocator('iframe').locator('.view-lines')).toHaveText('hivra-rustpad-pilot');
    expect(workspaceVisits).toBe(2);
    expect(context.pages()).toHaveLength(1);
  });
}
