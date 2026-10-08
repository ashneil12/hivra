/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ClientLayoutWrapper } from '../ClientLayoutWrapper';
import { usePathname } from 'next/navigation';
import { useWorkspaceModalLayer } from '@/components/workspace/WorkspaceModalLayerContext';
import { useDashboardResources } from '../useDashboardResources';
import type { DashboardResource } from '../dashboard-resources';
import { useWorkspaceViewport } from '../useWorkspaceViewport';
import { FleetControlPane } from '@/components/hivra/FleetControlPane';
import { resetResourceInventory, resourceInventory } from '@/lib/workspace/resource-inventory';
import { recordVisit } from '@/lib/workspace/recents';

jest.mock('../ClientLayoutWrapper.module.css', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_target, key) => key }),
}));

// Mock the Next.js hooks
jest.mock('next/navigation', () => ({
  usePathname: jest.fn(),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('../useDashboardResources', () => ({
  useDashboardResources: jest.fn(),
}));
jest.mock('../useWorkspaceViewport', () => ({ useWorkspaceViewport: jest.fn() }));

jest.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setTheme: jest.fn() }),
}));

function WorkspaceModalProbe({ active }: { active: boolean }) {
  useWorkspaceModalLayer('agent-picker', active);
  return <div data-testid="workspace-modal-probe">Workspace</div>;
}

describe('ClientLayoutWrapper', () => {
  const mockChildren = <div data-testid="test-content">Test Content</div>;
  const mockProps = {
    userName: 'Test User',
    userEmail: 'test@example.com',
    activeAgents: 1,
    totalAgents: 2,
    uptime: 100,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    (usePathname as jest.Mock).mockReturnValue('/dashboard');
    (useWorkspaceViewport as jest.Mock).mockReturnValue({ keyboardOpen: false });
    (useDashboardResources as jest.Mock).mockReturnValue({ resources: [], loading: false, errors: { hermes: null, hivra: null }, refresh: jest.fn() });
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV;
    const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
    delete host.__HIVRA_NATIVE_WORKSPACE__;
    delete host.webkit;
  });

  it('shows the account code the server setup script names in the account menu (T5)', () => {
    render(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    // accountCode("user_123"), the same fixed vector as account-code.test.ts.
    expect(screen.getAllByText('Account code QJK7-53FK').length).toBeGreaterThan(0);
  });

  it('uses native chrome only when both injected capabilities are present, with one metadata source', () => {
    const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
    host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
    const view = render(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    expect(screen.getByTestId('dashboard-sidebar-chrome')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-mobile-header')).toBeInTheDocument();

    const postMessage = jest.fn();
    host.webkit = { messageHandlers: { hivraWorkspace: { postMessage } } };
    (useDashboardResources as jest.Mock).mockClear();
    view.rerender(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    expect(screen.queryByTestId('dashboard-sidebar-chrome')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-mobile-header')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'App navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveClass('hermes-pwa-bottom-nav-offset');
    expect(screen.getByTestId('test-content')).toBeInTheDocument();
    expect(useDashboardResources).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workspace', ownerKey: 'user_123' }));
  });

  it('restores the existing auth account control in native Settings without duplicating web account access', () => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/settings');
    const view = render(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('dashboard-sidebar-chrome')).getByTestId('mock-user-button')).toBeInTheDocument();

    const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
    host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
    host.webkit = { messageHandlers: { hivraWorkspace: { postMessage: jest.fn() } } };
    view.rerender(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    const account = within(screen.getByRole('region', { name: 'Account' }));
    expect(account.getByText(mockProps.userName)).toBeInTheDocument();
    expect(account.getByTestId('mock-user-button')).toBeInTheDocument();
    expect(screen.getAllByTestId('mock-user-button')).toHaveLength(1);
    expect(screen.queryByTestId('dashboard-sidebar-chrome')).not.toBeInTheDocument();

    view.rerender(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="another-owner">{mockChildren}</ClientLayoutWrapper>);
    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();

    (usePathname as jest.Mock).mockReturnValue('/dashboard/agents');
    view.rerender(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="user_123">{mockChildren}</ClientLayoutWrapper>);
    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('renders children and sidebar correctly', () => {
    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.getByTestId('test-content')).toBeInTheDocument();
    // Verify DashboardSidebar logic minimal presence
    expect(within(screen.getByTestId('dashboard-sidebar-chrome')).getByRole('link', { name: 'Hivra home' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /app navigation/i })).toBeInTheDocument();
  });

  it('shares the resolved section with mobile navigation without confusing matching source IDs', () => {
    const resources: DashboardResource[] = [
      { uid: 'h-shared', id: 'shared', source: 'hermes', kind: 'agent', name: 'Writer', description: 'Hermes', status: 'running', href: '/dashboard/instances/shared' },
      { uid: 'x-shared', id: 'shared', source: 'hivra', kind: 'computer', name: 'Desktop', description: 'Ubuntu Desktop', status: 'running', href: '/dashboard/agent/shared?tab=desktop' },
    ];
    (useDashboardResources as jest.Mock).mockReturnValue({ resources, loading: false, errors: { hermes: null, hivra: null }, refresh: jest.fn() });
    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/shared');
    const view = render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const expectSelected = (name: string | null) => {
      for (const label of ['Primary', 'App navigation']) {
        const nav = within(screen.getByRole('navigation', { name: label }));
        if (name) expect(nav.getAllByRole('link', { current: 'page' })).toEqual([nav.getByRole('link', { name })]);
        else expect(nav.queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
      }
    };
    expectSelected('Computers');

    (usePathname as jest.Mock).mockReturnValue('/dashboard/instances/shared/console');
    view.rerender(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    expectSelected('Agents');

    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/unknown');
    view.rerender(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    expectSelected(null);

    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/shared');
    view.rerender(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    expectSelected('Computers');

    (useDashboardResources as jest.Mock).mockReturnValue({ resources: [], loading: true, errors: { hermes: null, hivra: null }, refresh: jest.fn() });
    view.rerender(<ClientLayoutWrapper {...mockProps} resourceOwnerKey="another-owner">{mockChildren}</ClientLayoutWrapper>);
    expectSelected(null);
  });

  it('preserves the active work pane while the shell switcher opens and closes', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
    render(<ClientLayoutWrapper {...mockProps}><textarea aria-label="Existing work draft" defaultValue="Keep this work" /></ClientLayoutWrapper>);
    const draft = screen.getByRole('textbox', { name: 'Existing work draft' });
    fireEvent.change(draft, { target: { value: 'Still working here' } });
    fireEvent.click(within(screen.getByTestId('dashboard-sidebar-chrome')).getByRole('button', { name: 'Switch agent or computer' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Existing work draft' })).toBe(draft);
    fireEvent.click(screen.getByRole('button', { name: 'Close switcher' }));
    expect(screen.getByRole('textbox', { name: 'Existing work draft' })).toBe(draft);
    expect(draft).toHaveValue('Still working here');
  });

  it('reclaims bottom navigation space during keyboard occlusion without remounting work', () => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/agent_123');
    const view = render(<ClientLayoutWrapper {...mockProps}><textarea aria-label="Work draft" defaultValue="Keep this" /></ClientLayoutWrapper>);
    const draft = screen.getByRole('textbox', { name: 'Work draft' });
    fireEvent.change(draft, { target: { value: 'Still here' } });
    expect(screen.getByRole('main')).toHaveClass('hermes-pwa-bottom-nav-offset');
    (useWorkspaceViewport as jest.Mock).mockReturnValue({ keyboardOpen: true });
    view.rerender(<ClientLayoutWrapper {...mockProps}><textarea aria-label="Work draft" defaultValue="Keep this" /></ClientLayoutWrapper>);
    expect(screen.getByTestId('dashboard-viewport')).toHaveAttribute('data-keyboard-open', 'true');
    expect(screen.queryByRole('navigation', { name: 'App navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveClass('hermes-pwa-bottom-nav-offset');
    expect(screen.getByRole('textbox', { name: 'Work draft' })).toBe(draft);
    expect(draft).toHaveValue('Still here');
    (useWorkspaceViewport as jest.Mock).mockReturnValue({ keyboardOpen: false });
    view.rerender(<ClientLayoutWrapper {...mockProps}><textarea aria-label="Work draft" defaultValue="Keep this" /></ClientLayoutWrapper>);
    expect(screen.getByRole('navigation', { name: 'App navigation' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('hermes-pwa-bottom-nav-offset');
    expect(screen.getByRole('textbox', { name: 'Work draft' })).toBe(draft);
  });

  it('removes global dashboard chrome while a workspace modal is active', async () => {
    const { rerender } = render(
      <ClientLayoutWrapper {...mockProps}>
        <WorkspaceModalProbe active={false} />
      </ClientLayoutWrapper>
    );

    expect(within(screen.getByTestId('dashboard-sidebar-chrome')).getByRole('link', { name: 'Hivra home' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /app navigation/i })).toBeInTheDocument();
    expect(screen.getByTestId('mobile-search-btn')).toBeInTheDocument();

    rerender(
      <ClientLayoutWrapper {...mockProps}>
        <WorkspaceModalProbe active />
      </ClientLayoutWrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-sidebar-chrome')).toHaveClass('hidden');
      expect(screen.getByTestId('dashboard-sidebar-chrome')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('navigation', { name: /app navigation/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('mobile-search-btn')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-modal-probe')).toBeInTheDocument();
  });

  it('renders a non-production environment banner when configured', () => {
    process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV = 'staging';

    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.getByTestId('environment-banner')).toHaveTextContent(
      'STAGING — non-production test environment'
    );
    // Phones get one short line instead of two wrapped lines pinned under the header.
    expect(screen.getByText('STAGING · test env')).toHaveClass('md:hidden');
    expect(screen.getByTestId('environment-banner')).toHaveClass('static', 'md:sticky', 'whitespace-nowrap', 'md:whitespace-normal');
    expect(screen.getByTestId('environment-banner')).toHaveStyle({ color: 'var(--ink-black)' });
  });

  it('does not render the environment banner for production', () => {
    process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV = 'production';

    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.queryByTestId('environment-banner')).not.toBeInTheDocument();
  });

  it.each(['/dashboard/workspace', '/dashboard/agent/agent_123'])('gives %s the remaining dashboard height instead of another viewport', (pathname) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);

    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.getByRole('main')).toHaveClass(
      'flex',
      'min-h-0',
      'flex-col',
      'overflow-hidden',
    );
  });

  it('reserves mobile navigation space above the banner on list pages', () => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/agents');
    process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV = 'staging';
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const header = screen.getByTestId('dashboard-mobile-header');
    expect(header.parentElement).toHaveClass('withMobileHeader');
    expect(within(header).getByRole('link', { name: 'Hivra home' })).toHaveAttribute('href', '/dashboard');
    expect(header).not.toContainElement(screen.getByTestId('environment-banner'));
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('environment-banner'));
  });

  it('keeps one phone navigation system: a search button, no hamburger and no drawer', () => {
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const header = screen.getByTestId('dashboard-mobile-header');
    expect(within(header).getAllByRole('button')).toEqual([within(header).getByRole('button', { name: 'Switch agent or computer' })]);
    expect(screen.queryByRole('button', { name: /open navigation/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-menu-btn')).not.toBeInTheDocument();
    expect(document.querySelector('.bg-black\\/50')).not.toBeInTheDocument();
  });

  it('puts the mobile header before the page in reading order', () => {
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const header = screen.getByTestId('dashboard-mobile-header');
    expect(header.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.compareDocumentPosition(screen.getByTestId('dashboard-sidebar-chrome')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lets page modals layer above the phone chrome by keeping main out of the stacking order', () => {
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('relative');
    expect(main.className).not.toMatch(/(^|\s)z-/);
  });

  // Without main's stacking context the sticky banner competes with the fixed
  // sidebar directly; it used to paint over the collapse toggle on canary.
  it('keeps the sidebar above the sticky environment banner and below page modals', () => {
    process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV = 'canary';
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const bannerZ = Number(screen.getByTestId('environment-banner').className.match(/(?:^|\s)z-\[?(\d+)\]?/)?.[1]);
    const css = readFileSync(join(__dirname, '..', 'DashboardSidebar.module.css'), 'utf8');
    const sidebarZ = Number(css.match(/\n\.sidebar \{[^}]*z-index:\s*(\d+)/)?.[1]);
    expect(bannerZ).toBeGreaterThan(0);
    expect(sidebarZ).toBeGreaterThan(bannerZ);
    expect(sidebarZ).toBeLessThan(1000);
  });

  it.each(['/dashboard/agent/agent_123', '/dashboard/workspace'])('drops the global header and particle canvas on runtime page %s', (pathname) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    expect(screen.queryByTestId('dashboard-mobile-header')).not.toBeInTheDocument();
    expect(document.querySelector('canvas')).not.toBeInTheDocument();
    // Global navigation stays reachable from the bottom bar.
    expect(screen.getByRole('navigation', { name: 'App navigation' })).toBeInTheDocument();
  });

  it('opens the shell switcher from the header search and from the More sheet', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    const search = screen.getByTestId('mobile-search-btn');
    fireEvent.click(search);
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close switcher' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Switch or search' }));
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('badges More with the sidebar attention count on phones', () => {
    const resources: DashboardResource[] = [
      { uid: 'h-a', id: 'a', source: 'hermes', kind: 'agent', name: 'Writer', description: 'Hermes', status: 'error', href: '/dashboard/instances/a' },
      { uid: 'x-b', id: 'b', source: 'hivra', kind: 'computer', name: 'Desktop', description: 'Ubuntu Desktop', status: 'running', href: '/dashboard/agent/b?tab=desktop' },
    ];
    (useDashboardResources as jest.Mock).mockReturnValue({ resources, loading: false, errors: { hermes: null, hivra: null }, refresh: jest.fn() });
    render(<ClientLayoutWrapper {...mockProps}>{mockChildren}</ClientLayoutWrapper>);
    expect(screen.getByRole('button', { name: 'More, 1 need attention' })).toBeInTheDocument();
  });

  it('does not render the global mobile header on instance pages', () => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/instances/inst_123');

    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.queryByTestId('mobile-search-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-mobile-header')).not.toBeInTheDocument();
    const appNav = screen.getByRole('navigation', { name: /app navigation/i });
    expect(appNav).toBeInTheDocument();
    expect(within(appNav).getByRole('link', { name: /agents/i })).toHaveAttribute('aria-current', 'page');
  });

  it('suppresses app navigation on the dedicated full-screen TUI route', () => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/instances/inst_123/tui');

    render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    expect(screen.queryByRole('navigation', { name: /app navigation/i })).not.toBeInTheDocument();
  });

  // The agents list is held between pages. Signing out and into another
  // account without a page load must not show Home the first account's list,
  // or offer to continue in one of its agents.
  it("never shows Home the list held for another account", async () => {
    const listFor = (agents: unknown[]) => jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url.startsWith('/api/instances') ? { success: true, data: [] } : { success: true, data: { agents } },
    })) as unknown as typeof fetch;
    const originalFetch = global.fetch;
    resetResourceInventory();
    window.localStorage.clear();
    try {
      global.fetch = listFor([{ id: 'secret', name: 'ACCOUNT_A_PROJECT', type: 'codex', status: 'running', cpu: 1, ram: 2 }]);
      resourceInventory.setOwner('account-a');
      await Promise.all([resourceInventory.load('hermes'), resourceInventory.load('hivra')]);
      recordVisit('x-secret', 'chat');

      global.fetch = listFor([]);
      render(
        <ClientLayoutWrapper {...mockProps} resourceOwnerKey="account-b">
          <FleetControlPane requested />
        </ClientLayoutWrapper>
      );
      expect(screen.queryByText('ACCOUNT_A_PROJECT')).not.toBeInTheDocument();
      expect(screen.queryByTestId('home-continue')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Choose an agent to work with, or a computer of your own.')).toBeInTheDocument());
      expect(screen.queryByText('ACCOUNT_A_PROJECT')).not.toBeInTheDocument();
    } finally {
      global.fetch = originalFetch;
      resetResourceInventory();
      window.localStorage.clear();
    }
  });

  it('leaves no pending timers after unmount', () => {
    const { unmount } = render(
      <ClientLayoutWrapper {...mockProps}>
        {mockChildren}
      </ClientLayoutWrapper>
    );

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });
});
