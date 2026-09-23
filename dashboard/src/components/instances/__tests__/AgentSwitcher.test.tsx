/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSwitcher } from '../AgentSwitcher';
import { listAgents } from '@/lib/hivra/agent-api';

const push = jest.fn();
let mockWorkspace: { enabled: boolean; ownerKey: string | null } = { enabled: false, ownerKey: null };
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/components/layout/NativeWorkspaceBridge', () => ({ useNativeWorkspace: () => mockWorkspace }));
jest.mock('@/lib/hivra/agent-api', () => ({ listAgents: jest.fn() }));

beforeEach(() => {
  mockWorkspace = { enabled: false, ownerKey: null };
  localStorage.clear();
  jest.mocked(listAgents).mockResolvedValue([]);
  global.fetch = jest.fn().mockImplementation(async (path: string) => ({ ok: true,
    json: async () => path === '/api/instances?summary=true'
      ? { success: true, data: [{ id: 'item', name: 'Writer', status: 'running' }, { id: 'other', name: 'Helper', status: 'running' }] }
      : {},
  }));
  jest.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

it('preserves the existing web switcher, browser buttons and resource navigation', async () => {
  render(<AgentSwitcher activeKind="hermes" activeId="item" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Agents: show agent switcher' }));
  expect(screen.getByRole('link', { name: 'Open console' })).toHaveAttribute('href', '/dashboard/instances/item/console');
  expect(screen.getByRole('button', { name: 'View live browser' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import cookies' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch agent' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Helper/ }));
  expect(push).toHaveBeenCalledWith('/dashboard/instances/other');
  expect(listAgents).toHaveBeenCalledTimes(1);
});

it('replaces duplicate native resource navigation with guarded browser and cookie tools', async () => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  render(<AgentSwitcher activeKind="hermes" activeId="item" />);
  expect(await screen.findByRole('group', { name: 'Agent browser tools' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /agent switcher|Switch agent/i })).not.toBeInTheDocument();
  expect(listAgents).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/instances/item/browser-sessions', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByRole('button', { name: 'View live browser' }));
  expect(window.open).toHaveBeenCalledWith('/api/instances/item/browser-stream', '_blank', 'noopener,noreferrer');
  fireEvent.click(screen.getByRole('button', { name: 'Import cookies' }));
  expect(await screen.findByRole('dialog', { name: 'Import cookies' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Import cookies' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import cookies' })).toHaveFocus();
});

it.each([false, 'rejected'])('does not offer browser tools when readiness is %s', async ready => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  jest.mocked(fetch).mockImplementation(() => ready === 'rejected' ? Promise.reject(new Error('unavailable')) : Promise.resolve({ ok: false } as Response));
  await act(async () => { render(<AgentSwitcher activeKind="hermes" activeId="item" />); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('group', { name: 'Agent browser tools' })).not.toBeInTheDocument();
});

it('does not carry readiness or an open cookie modal into another resource', async () => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  const view = render(<AgentSwitcher activeKind="hermes" activeId="item" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Import cookies' }));
  expect(await screen.findByRole('dialog', { name: 'Import cookies' })).toBeInTheDocument();
  const firstSignal = (jest.mocked(fetch).mock.calls[0][1] as RequestInit).signal;
  jest.mocked(fetch).mockResolvedValue({ ok: false } as Response);
  view.rerender(<AgentSwitcher activeKind="hermes" activeId="other" />);
  expect(screen.queryByRole('dialog', { name: 'Import cookies' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Agent browser tools' })).not.toBeInTheDocument();
  expect(firstSignal?.aborted).toBe(true);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/instances/other/browser-sessions', expect.anything()));
  view.unmount();
  expect((jest.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit).signal?.aborted).toBe(true);
});

it('does not fetch or retain native browser tools after the owner is invalidated', async () => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  const view = render(<AgentSwitcher activeKind="hermes" activeId="item" />);
  await screen.findByRole('button', { name: 'Import cookies' });
  jest.mocked(fetch).mockClear();
  mockWorkspace = { enabled: true, ownerKey: null };
  view.rerender(<AgentSwitcher activeKind="hermes" activeId="item" />);
  expect(screen.queryByRole('group', { name: 'Agent browser tools' })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps Hivra Browser access in its own resource surface', () => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  render(<AgentSwitcher activeKind="hivra" activeId="item" />);
  expect(fetch).not.toHaveBeenCalled();
  expect(listAgents).not.toHaveBeenCalled();
  expect(screen.queryByRole('group', { name: 'Agent browser tools' })).not.toBeInTheDocument();
});

it('keeps the console link to Hermes agents and accepts a CSS top offset', async () => {
  jest.mocked(listAgents).mockResolvedValue([]);
  const { container } = render(<AgentSwitcher activeKind="hermes" activeId="item" top="calc(4px + 1px)" />);
  const handle = await screen.findByRole('button', { name: 'Agents: show agent switcher' });
  expect(handle.parentElement).toHaveStyle({ top: 'calc(4px + 1px)' });
  expect(within(handle).getByText('Agents')).toBeInTheDocument();
  fireEvent.click(handle);
  expect(container.querySelector('a[href="/dashboard/instances/item/console"]')).not.toBeNull();
});

it('hosts only the collapsed handle in a toolbar slot and expands in place', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const view = render(<div data-testid="chat-column"><AgentSwitcher activeKind="hermes" activeId="item" showConsole={false} handleHost={host} /></div>);
    const handle = await within(host).findByRole('button', { name: 'Agents: show agent switcher' });
    // The visible label is part of the accessible name.
    expect(handle.getAttribute('aria-label')).toContain(within(handle).getByText('Agents').textContent);
    expect(within(view.getByTestId('chat-column')).queryByRole('button', { name: /show agent switcher/i })).not.toBeInTheDocument();

    fireEvent.click(handle);
    const column = view.getByTestId('chat-column');
    expect(within(column).getByRole('button', { name: 'Switch agent' })).toBeInTheDocument();
    expect(within(column).queryByRole('link', { name: 'Open console' })).not.toBeInTheDocument();
    expect(host).toBeEmptyDOMElement();

    fireEvent.click(within(column).getByRole('button', { name: 'Hide agent switcher' }));
    expect(within(host).getByRole('button', { name: 'Agents: show agent switcher' })).toBeInTheDocument();
  } finally {
    host.remove();
  }
});

it('renders no handle while its toolbar slot is still mounting', async () => {
  await act(async () => { render(<AgentSwitcher activeKind="hermes" activeId="item" handleHost={null} />); });
  expect(screen.queryByRole('button', { name: /show agent switcher/i })).not.toBeInTheDocument();
});

it('keeps native browser tools in place when a toolbar slot is offered', async () => {
  mockWorkspace = { enabled: true, ownerKey: 'user_123' };
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const view = render(<div data-testid="chat-column"><AgentSwitcher activeKind="hermes" activeId="item" handleHost={host} /></div>);
    expect(await within(view.getByTestId('chat-column')).findByRole('group', { name: 'Agent browser tools' })).toBeInTheDocument();
    expect(host).toBeEmptyDOMElement();
  } finally {
    host.remove();
  }
});
