/** @jest-environment jsdom */
// ⌘K lists the agents added to the owner's computers, each right after its
// computer. The sidebar doesn't list them, so ⌘K reads that list when opened.

import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';

import { DashboardResourceSwitcher } from '../DashboardResourceSwitcher';
import type { DashboardResource } from '../dashboard-resources';
import { resetResourceInventory } from '@/lib/workspace/resource-inventory';

jest.mock('@/lib/hivra/hivra-flag', () => ({ isHivraEnabled: () => true }));

const COMPUTER_ID = '11111111-1111-4111-8111-111111111111';
const computer: DashboardResource = { uid: `x-${COMPUTER_ID}`, id: COMPUTER_ID, source: 'hivra', kind: 'computer', name: 'MY_UBUNTU_DESKTOP',
  description: 'Ubuntu Desktop', status: 'running', href: `/dashboard/agent/${COMPUTER_ID}?tab=desktop` };
const other: DashboardResource = { uid: 'x-lab', id: 'lab', source: 'hivra', kind: 'computer', name: 'Z_LAB', description: 'Ubuntu Desktop',
  status: 'running', href: '/dashboard/agent/lab?tab=desktop' };
const agent: DashboardResource = { uid: 'x-codex', id: 'codex', source: 'hivra', kind: 'agent', name: 'CODEX_AGENT', description: 'Codex',
  status: 'running', href: '/dashboard/agent/codex?tab=chat' };

const originalFetch = global.fetch;
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
afterAll(() => { global.fetch = originalFetch; });
beforeEach(() => {
  window.localStorage.clear();
  resetResourceInventory();
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe('/api/hivra/attached-agents');
    return { ok: true, status: 200, json: async () => ({ success: true, data: { enabled: true, agents: [
      { id: '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', phase: 'attached', agentName: 'Codex', computerId: COMPUTER_ID, computerName: 'MY_UBUNTU_DESKTOP', computerStatus: 'running' },
    ] } }) } as Response;
  }) as jest.Mock;
});

it('lists an agent added to a computer right after that computer, opening its Chat', async () => {
  const onSelect = jest.fn();
  render(<DashboardResourceSwitcher resources={[agent, computer, other]} loading={false} errors={{ hermes: null, hivra: null }}
    onSelect={onSelect} onClose={jest.fn()} onRefresh={jest.fn()} />);

  const list = screen.getByRole('listbox', { name: 'Agents and computers' });
  await waitFor(() => expect(within(list).getByRole('option', { name: /Codex on MY_UBUNTU_DESKTOP/ })).toBeInTheDocument());
  const names = within(list).getAllByRole('option').map((option) => option.textContent ?? '');
  const desk = names.findIndex((name) => name.includes('MY_UBUNTU_DESKTOP') && !name.includes('Codex on'));
  expect(names[desk + 1]).toMatch(/Codex on MY_UBUNTU_DESKTOP/);
  expect(names.findIndex((name) => name.includes('Z_LAB'))).toBeGreaterThan(desk + 1);
  expect(global.fetch).toHaveBeenCalledTimes(1);

  within(list).getByRole('option', { name: /Codex on MY_UBUNTU_DESKTOP/ }).click();
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
    uid: 'a-7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', href: `/dashboard/agent/${COMPUTER_ID}?tab=chat`,
  }));
});
