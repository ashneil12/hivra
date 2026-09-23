/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { usePathname, useRouter } from 'next/navigation';
import { LocaleProvider } from '@/components/i18n/LocaleProvider';
import { DashboardSidebar } from '../DashboardSidebar';
import { useDashboardResources } from '../useDashboardResources';
import type { DashboardResource } from '../dashboard-resources';

jest.mock('next/navigation', () => ({ usePathname: jest.fn(), useRouter: jest.fn() }));
jest.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark', setTheme: jest.fn() }) }));
jest.mock('../useDashboardResources', () => ({ useDashboardResources: jest.fn() }));
jest.mock('../DashboardSidebar.module.css', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_target, key) => key }),
}));

const resources: DashboardResource[] = [
  { uid: 'h-same', id: 'same', source: 'hermes', kind: 'agent', name: 'Writer', description: 'Hermes', status: 'running', href: '/dashboard/instances/same' },
  { uid: 'x-same', id: 'same', source: 'hivra', kind: 'agent', name: 'Writer', description: 'Codex', status: 'stopped', href: '/dashboard/agent/same' },
  { uid: 'x-desktop', id: 'desktop', source: 'hivra', kind: 'computer', name: 'My desktop', description: 'Ubuntu Desktop', status: 'running', href: '/dashboard/agent/desktop?tab=desktop' },
];
const props = { userName: 'Test User', userEmail: 'test@example.com', resourceOwnerKey: 'owner-1' };
const push = jest.fn();
const refresh = jest.fn();
let viewportWidth = 1280;
const mediaQueries = new Map<string, EventTarget>();

function setViewportWidth(width: number) {
  act(() => {
    viewportWidth = width;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    mediaQueries.forEach(query => query.dispatchEvent(new Event('change')));
  });
}

beforeEach(() => {
  viewportWidth = 1280;
  mediaQueries.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn((query: string) => {
      if (!mediaQueries.has(query)) {
        const list = new EventTarget();
        Object.defineProperties(list, {
          media: { value: query },
          matches: { get: () => {
            const minimum = query.match(/min-width:\s*(\d+)px/);
            const maximum = query.match(/max-width:\s*(\d+)px/);
            return (!minimum || viewportWidth >= Number(minimum[1])) && (!maximum || viewportWidth <= Number(maximum[1]));
          } },
        });
        mediaQueries.set(query, list);
      }
      return mediaQueries.get(query);
    }),
  });
  window.localStorage.clear();
  (usePathname as jest.Mock).mockReturnValue('/dashboard');
  (useRouter as jest.Mock).mockReturnValue({ push });
  (useDashboardResources as jest.Mock).mockReturnValue({ resources, loading: false, errors: { hermes: null, hivra: null }, refresh });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  jest.clearAllMocks();
});

describe('DashboardSidebar', () => {
  it('starts expanded for a new preference and keeps work above secondary destinations', () => {
    render(<DashboardSidebar {...props} />);
    expect(screen.getByTitle('Collapse Sidebar')).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Computers', 'Agents', 'Activity']);
    expect(screen.getByRole('link', { name: 'Applications' })).toHaveAttribute('href', '/dashboard/settings/applications');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/dashboard/settings/help');
    expect(screen.queryByText('Install Hivra')).not.toBeInTheDocument();
    expect(screen.queryByText('Upgrade to Pro')).not.toBeInTheDocument();
    expect(screen.queryByText('Discord')).not.toBeInTheDocument();
  });

  it('keeps one landing item as the shell rollout turns on', () => {
    // There is no separate Chat entry any more: the interaction area IS home,
    // and a fourth item listed the same runtimes Agents and Computers already
    // list. The shell rollout therefore adds no item — it only decides which
    // renderer /dashboard uses.
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = '1';
    (usePathname as jest.Mock).mockReturnValue('/dashboard');
    try {
      render(<DashboardSidebar {...props} />);
      const primary = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link');
      expect(primary.map((link) => link.textContent)).toEqual(['Home', 'Computers', 'Agents', 'Activity']);
      expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    } finally {
      delete process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED;
    }
  });

  it('keeps Home current inside a runtime while the shell rollout is on', () => {
    // Opening a runtime used to highlight Agents, so the item naming the place
    // you came from lost to the one naming its kind.
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = '1';
    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/abc-123');
    try {
      render(<DashboardSidebar {...props} />);
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Agents' })).not.toHaveAttribute('aria-current');
    } finally {
      delete process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED;
    }
  });

  // The resume at /dashboard follows the server shell flag, which self-host
  // builds hide from the client, so the route decides, not the client flag.
  it.each([
    ['/dashboard/agent/desktop', '/dashboard?runtimes=1'],
    ['/dashboard/instances/same', '/dashboard?runtimes=1'],
    ['/dashboard/settings', '/dashboard'],
  ])('sends Home and the brand from %s to %s with the client shell flag off', (pathname, href) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);
    render(<DashboardSidebar {...props} />);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', href);
    expect(screen.getByRole('link', { name: 'Hivra home' })).toHaveAttribute('href', href);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    expect(screen.getByRole('link', { name: 'All agents and computers' })).toHaveAttribute('href', '/dashboard?runtimes=1');
  });

  it('closes the switcher when browsing all agents and computers', () => {
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    fireEvent.click(screen.getByRole('link', { name: 'All agents and computers' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['/dashboard/agent/abc-123', '/dashboard?runtimes=1'],
    ['/dashboard/instances/inst_1/console', '/dashboard?runtimes=1'],
    ['/dashboard/settings', '/dashboard'],
  ])('under the shell, sends Home from %s to %s so it cannot resume the runtime being left', (pathname, href) => {
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = '1';
    (usePathname as jest.Mock).mockReturnValue(pathname);
    try {
      render(<DashboardSidebar {...props} />);
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', href);
    } finally {
      delete process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED;
    }
  });

  it('reports the attention count so the phone bar can badge More', () => {
    const onAttentionCountChange = jest.fn();
    (useDashboardResources as jest.Mock).mockReturnValue({ resources: [{ ...resources[0], status: 'error' }, resources[2]], loading: false, errors: { hermes: null, hivra: null }, refresh });
    render(<DashboardSidebar {...props} onAttentionCountChange={onAttentionCountChange} />);
    expect(onAttentionCountChange).toHaveBeenLastCalledWith(1);
  });

  it('lets the shell open and close the switcher, refreshing once per open', () => {
    const onSwitcherOpenChange = jest.fn();
    const view = render(<DashboardSidebar {...props} switcherOpen={false} onSwitcherOpenChange={onSwitcherOpenChange} />);
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(<DashboardSidebar {...props} switcherOpen onSwitcherOpenChange={onSwitcherOpenChange} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close switcher' }));
    expect(onSwitcherOpenChange).toHaveBeenLastCalledWith(false);
    view.rerender(<DashboardSidebar {...props} switcherOpen={false} onSwitcherOpenChange={onSwitcherOpenChange} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    expect(onSwitcherOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('labels the collapsed rail so touch tablets without tooltips can read it', () => {
    window.localStorage.setItem('hivra:dashboard:sidebar-expanded', 'false');
    const { container } = render(<DashboardSidebar {...props} />);
    const labels = [...container.querySelectorAll('.railLabel')].map((label) => label.textContent);
    expect(labels).toEqual(['Search', 'Launch', 'Home', 'Computers', 'Agents', 'Activity', 'Infra', 'Settings', 'Billing', 'Apps', 'Help']);
    expect(screen.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('title', 'Infrastructure');
    fireEvent.click(screen.getByTitle('Expand Sidebar'));
    expect(container.querySelector('.railLabel')).not.toBeInTheDocument();
  });

  it('shows attention only for current, actionable resource signals', () => {
    (useDashboardResources as jest.Mock).mockReturnValue({ resources: [{ ...resources[0], attention: 'approval' }, resources[2]], loading: false, errors: { hermes: null, hivra: null }, refresh });
    const view = render(<DashboardSidebar {...props} />);
    expect(screen.getByRole('link', { name: '1 agents or computers need attention' })).toHaveAttribute('href', '/dashboard?runtimes=1&attention=1');
    (useDashboardResources as jest.Mock).mockReturnValue({ resources: [{ ...resources[0], attention: 'approval' }], loading: false, errors: { hermes: 'Unavailable', hivra: null }, refresh });
    view.rerender(<DashboardSidebar {...props} userName="Updated user" />);
    expect(screen.queryByRole('link', { name: /need attention/ })).not.toBeInTheDocument();
  });

  it('preserves both desktop choices through remount', () => {
    const first = render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByTitle('Collapse Sidebar'));
    first.unmount();
    const second = render(<DashboardSidebar {...props} />);
    expect(screen.getByTitle('Expand Sidebar')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTitle('Expand Sidebar'));
    second.unmount();
    render(<DashboardSidebar {...props} />);
    expect(screen.getByTitle('Collapse Sidebar')).toHaveAttribute('aria-expanded', 'true');
  });

  it.each([
    { width: 768, saved: 'true' },
    { width: 1023, saved: 'false' },
  ])('uses a local overlay at $width without changing the saved $saved desktop preference', ({ width, saved }) => {
    window.localStorage.setItem('hivra:dashboard:sidebar-expanded', saved);
    const { container } = render(<DashboardSidebar {...props} />);
    setViewportWidth(width);
    expect(screen.getByTitle('Expand Sidebar')).toHaveAttribute('aria-expanded', 'false');
    const spacer = container.querySelector('.spacer');
    expect(spacer).toHaveStyle({ width: '72px', minWidth: '72px' });
    fireEvent.click(screen.getByTitle('Expand Sidebar'));
    expect(screen.getByTitle('Collapse Sidebar')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Switch agent or computer' })).toBeInTheDocument();
    expect(spacer).toHaveStyle({ width: '72px', minWidth: '72px' });
    expect(window.localStorage.getItem('hivra:dashboard:sidebar-expanded')).toBe(saved);

    setViewportWidth(1024);
    const desktopToggle = screen.getByTitle(saved === 'true' ? 'Collapse Sidebar' : 'Expand Sidebar');
    expect(desktopToggle).toHaveAttribute('aria-expanded', saved);
    expect(spacer).toHaveStyle({ width: saved === 'true' ? '248px' : '72px' });
    expect(window.localStorage.getItem('hivra:dashboard:sidebar-expanded')).toBe(saved);
  });

  it('closes the tablet overlay on Escape and returns focus to its rail toggle', () => {
    setViewportWidth(900);
    render(<DashboardSidebar {...props} />);
    const toggle = screen.getByTitle('Expand Sidebar');
    toggle.focus();
    fireEvent.click(toggle);
    const search = screen.getByRole('button', { name: 'Switch agent or computer' });
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(window.localStorage.getItem('hivra:dashboard:sidebar-expanded')).toBeNull();
  });

  it('closes the tablet overlay after choosing a resource in the switcher without changing its native route', () => {
    setViewportWidth(900);
    window.localStorage.setItem('hivra:dashboard:sidebar-expanded', 'true');
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByTitle('Expand Sidebar'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'x-desktop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/agent/desktop?tab=desktop');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTitle('Expand Sidebar')).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem('hivra:dashboard:sidebar-expanded')).toBe('true');
  });

  it('keeps the sidebar and all of its controls out of reach on phones, where the bottom bar navigates', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(__dirname, '..', 'DashboardSidebar.module.css'), 'utf8');
    document.head.append(style);
    try {
      const rules = Array.from(style.sheet!.cssRules);
      const mobile = rules.find((rule) => rule instanceof CSSMediaRule && rule.conditionText === '(max-width: 767px)') as CSSMediaRule;
      // JSDOM does not evaluate viewport media queries. Apply the real mobile
      // rules after the base rules, as the browser does at 360px.
      style.textContent = [
        ...rules.filter((rule) => rule.type === CSSRule.STYLE_RULE),
        ...Array.from(mobile.cssRules),
      ].map((rule) => rule.cssText).join('\n');
      render(<DashboardSidebar {...props} />);
      const theme = screen.getByTitle('Switch to light mode');
      theme.style.visibility = 'visible';
      expect(screen.queryByRole('button', { name: 'Toggle theme' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    } finally {
      style.remove();
    }
  });

  it('shows switcher status on phones with a dot that desktop keeps hidden', () => {
    const css = readFileSync(join(__dirname, '..', 'DashboardSidebar.module.css'), 'utf8');
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(css).toContain('.resultDot { display: none; }');
    expect(mobile.slice(0, mobile.indexOf('\n}'))).toContain('.resultDot { display: block; }');
    expect(mobile.slice(0, mobile.indexOf('\n}'))).not.toContain('.resultStatus { display: none; }');
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    const option = screen.getAllByRole('option')[0];
    expect(option.querySelector('.resultDot')).toHaveAttribute('data-state', 'running');
    expect(option).toHaveTextContent('Running');
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('enterkeyhint', 'go');
    expect(input).toHaveAttribute('autocapitalize', 'none');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  it.each([
    ['/dashboard/agent/desktop', 'Computers', 'Agents'],
    ['/dashboard/agent/same', 'Agents', 'Computers'],
    ['/dashboard/instances/same/console', 'Agents', 'Computers'],
  ])('selects the loaded resource section at %s', (pathname, active, inactive) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);
    render(<DashboardSidebar {...props} />);
    const primary = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(primary.getByRole('link', { name: active })).toHaveAttribute('aria-current', 'page');
    expect(primary.getByRole('link', { name: inactive })).not.toHaveAttribute('aria-current');
  });

  it.each([
    ['/dashboard/agent/same', 'Computers'],
    ['/dashboard/instances/same/console', 'Agents'],
  ])('uses source-qualified routes when an agent and computer share an ID at %s', (pathname, active) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);
    (useDashboardResources as jest.Mock).mockReturnValue({
      resources: resources.map((item) => item.uid === 'x-same'
        ? { ...item, kind: 'computer', href: '/dashboard/agent/same?tab=desktop' }
        : item),
      loading: true, errors: { hermes: null, hivra: null }, refresh,
    });
    render(<DashboardSidebar {...props} />);
    const primary = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(primary.getAllByRole('link', { current: 'page' })).toEqual([primary.getByRole('link', { name: active })]);
  });

  it.each([true, false])('does not guess the kind of an unresolved shared detail route when loading is %s', (loading) => {
    (usePathname as jest.Mock).mockReturnValue('/dashboard/agent/unknown');
    (useDashboardResources as jest.Mock).mockReturnValue({
      resources, loading, errors: { hermes: null, hivra: loading ? null : 'Other agents and computers could not be refreshed.' }, refresh,
    });
    render(<DashboardSidebar {...props} />);
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });

  it.each(['metaKey', 'ctrlKey'])('opens keyboard search with %s and navigates the matched source', (modifier) => {
    render(<DashboardSidebar {...props} />);
    const trigger = screen.getByRole('button', { name: 'Switch agent or computer' });
    trigger.focus();
    fireEvent.keyDown(window, { key: 'k', [modifier]: true });
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'x-same' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/agent/same');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('restores focus on cancel and keeps inventory mounted while searching', () => {
    render(<DashboardSidebar {...props} />);
    const trigger = screen.getByRole('button', { name: 'Switch agent or computer' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('moves the active option with arrow keys and opens the exact source on Enter', () => {
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    const input = screen.getByRole('combobox');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/agent/same');
  });

  it('keeps the normal result compact and adds source identity only for duplicate names', () => {
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Hermes · hermes · same');
    expect(options[1]).toHaveTextContent('Codex · hivra · same');
    expect(options[2]).toHaveTextContent('Ubuntu Desktop · Computer');
    expect(options[2]).not.toHaveTextContent('x-desktop');
    expect(options[2]).toHaveAttribute('title', 'Ubuntu Desktop · x-desktop');
  });

  it('does not steal the shortcut from a different open modal', () => {
    render(<><dialog open aria-label="Other modal" /><DashboardSidebar {...props} /></>);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('surfaces partial-source failure in the switcher and retries explicitly', () => {
    (useDashboardResources as jest.Mock).mockReturnValue({ resources, loading: false, errors: { hermes: 'Hermes agents could not be refreshed.', hivra: null }, refresh });
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    expect(screen.getByText('Hermes agents could not be refreshed.')).toBeInTheDocument();
    refresh.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading resources' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('closes the tablet overlay after a primary navigation selection', () => {
    setViewportWidth(900);
    render(<DashboardSidebar {...props} />);
    fireEvent.click(screen.getByTitle('Expand Sidebar'));
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
    expect(screen.getByTitle('Expand Sidebar')).toHaveAttribute('aria-expanded', 'false');
  });

  // The rail is a fixed flex column. Its only grow child (the resource list) was
  // removed when recents moved to the workspace rail, which left the column
  // packing everything under the header — the tail went blank at any window
  // taller than the content. JSDOM does no layout, so the mechanism itself is
  // asserted here; dropping either half silently revives the empty rail.
  it('keeps the footer riding the bottom edge of its flex column', () => {
    const css = readFileSync(join(__dirname, '..', 'DashboardSidebar.module.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      return start === -1 ? '' : css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.footer')).toContain('margin-top: auto');
    // The divider only applies between the two sibling navs, so the footer has to
    // keep Manage and the utility group adjacent and in that order.
    expect(rule('.footer > .navigation + .navigation')).toContain('border-top');

    const { container } = render(<DashboardSidebar {...props} />);
    const footer = container.querySelector('aside')?.querySelector(':scope > .body > .footer');
    const groups = [...(footer?.querySelectorAll(':scope > nav') ?? [])];
    expect(groups.map((nav) => nav.getAttribute('aria-label'))).toEqual(['Manage', 'Applications and help']);
  });

  // The labelled touch-tablet rail and short windows are taller than the
  // viewport. Only the body scrolls: scrolling the fixed aside itself clips the
  // collapse toggle that overhangs the collapsed rail.
  it('scrolls the rail body, not the aside, so the footer and the collapse toggle stay reachable', () => {
    const css = readFileSync(join(__dirname, '..', 'DashboardSidebar.module.css'), 'utf8');
    const body = css.slice(css.indexOf('\n.body {'), css.indexOf('}', css.indexOf('\n.body {')));
    for (const declaration of ['flex: 1 1 auto', 'flex-direction: column', 'min-height: 0', 'overflow-y: auto']) {
      expect(body).toContain(declaration);
    }
    expect(css).not.toMatch(/\.sidebar\s*\{[^}]*overflow/);
    expect(css).toContain('.collapsed .collapseButton { position: absolute; right: -16px;');

    window.localStorage.setItem('hivra:dashboard:sidebar-expanded', 'false');
    const { container } = render(<DashboardSidebar {...props} />);
    const scroller = container.querySelector('aside > .body');
    expect(scroller).toContainElement(screen.getByRole('button', { name: 'Switch agent or computer' }));
    expect(scroller).toContainElement(screen.getByRole('link', { name: 'Help' }));
    expect(scroller).toContainElement(screen.getByTitle('Switch to light mode'));
    expect(scroller).not.toContainElement(screen.getByTitle('Expand Sidebar'));
  });

  it('keeps localized primary navigation and usable controls when storage is blocked', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    try {
      render(<LocaleProvider initialLocale="zh-CN"><DashboardSidebar {...props} /></LocaleProvider>);
      expect(screen.getByRole('link', { name: '首页' })).toHaveAttribute('href', '/dashboard');
      fireEvent.click(screen.getByRole('button', { expanded: true, name: /侧/ }));
      expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    } finally { jest.restoreAllMocks(); }
  });
});
