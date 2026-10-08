'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';
import Link from '@/components/ui/NavigationLink';
import { usePathname } from 'next/navigation';
import { useLocale } from '@/components/i18n/LocaleProvider';
import {
  DASHBOARD_MOBILE_MORE_NAVIGATION,
  DASHBOARD_MOBILE_NAVIGATION,
  DASHBOARD_RUNTIME_LIST_HREF,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
  labelForNavigationItem,
  mobileNavigationCopy,
} from '@/lib/dashboard-navigation';
import { isWorkspaceShellNavigationEnabled } from '@/lib/flags/workspace-shell';
import { MobileMoreSheet } from './MobileMoreSheet';

interface PwaBottomNavigationProps {
  resourceKind?: 'agent' | 'computer' | null;
  attentionCount?: number;
  userName?: string;
  userEmail?: string;
  /** The account code the server setup script shows. */
  accountCode?: string | null;
  onOpenSwitcher?: () => void;
}

const TAB_CLASS = 'hermes-pwa-bottom-nav__tab mono grid min-h-[56px] min-w-0 content-center items-center justify-items-center gap-0.5 px-0 py-[2px] text-[11px] no-underline';

const NAV_STYLES = `
  @media (min-width: 768px) {
    .hermes-pwa-bottom-nav {
      display: none !important;
    }

    .hermes-pwa-bottom-nav-offset {
      padding-bottom: 0;
    }
  }

  @media (max-width: 767px) {
    .hermes-pwa-bottom-nav-offset {
      box-sizing: border-box;
      padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
    }

    /* Fixed bottom UI (e.g. the cookie banner) sits above the bar. */
    :root:has(.hermes-pwa-bottom-nav) {
      --hivra-bottom-chrome: 64px;
    }
  }

  .hermes-pwa-bottom-nav__tab {
    color: var(--text-muted);
    background: transparent;
    border: 0;
    border-top: 2px solid transparent;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .hermes-pwa-bottom-nav__tab[data-active='true'] {
    color: var(--ink-black);
    background: var(--hivra-red-soft);
    border-top-color: var(--hivra-red);
  }
  .hermes-pwa-bottom-nav :is(a, button):active {
    background: var(--hivra-red-soft);
    transition: none;
  }
  .hermes-pwa-bottom-nav :is(a, button):focus-visible {
    outline: 2px solid var(--hivra-red);
    outline-offset: -2px;
  }
  .hermes-pwa-bottom-nav__icon {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
  }
  .hermes-pwa-bottom-nav__icon--launch {
    color: #fff;
    background: var(--hivra-red);
  }
  .hermes-pwa-bottom-nav__badge {
    position: absolute;
    top: 0;
    left: calc(50% + 4px);
    display: grid;
    place-items: center;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    color: #fff;
    background: var(--hivra-red);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .hermes-pwa-bottom-nav__label {
    overflow: hidden;
    max-width: 100%;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0;
    line-height: 1.3;
  }
`;

export function PwaBottomNavigation({
  resourceKind,
  attentionCount = 0,
  userName = '',
  userEmail = '',
  accountCode = null,
  onOpenSwitcher,
}: PwaBottomNavigationProps) {
  const pathname = usePathname();
  const { copy } = useLocale();
  const text = mobileNavigationCopy(copy);
  const workspaceShellEnabled = isWorkspaceShellNavigationEnabled();
  const navItems = filterDashboardNavigation(DASHBOARD_MOBILE_NAVIGATION, workspaceShellEnabled);
  const [moreOpen, setMoreOpen] = useState(false);
  // Any navigation closes the sheet, including back/forward while it is open.
  const [moreRoute, setMoreRoute] = useState(pathname);
  if (moreRoute !== pathname) {
    setMoreRoute(pathname);
    if (moreOpen) setMoreOpen(false);
  }
  const moreActive = DASHBOARD_MOBILE_MORE_NAVIGATION.some((item) =>
    isDashboardNavigationItemActive(item, pathname, resourceKind, workspaceShellEnabled));

  return (
    <nav
      aria-label="App navigation"
      className="hermes-pwa-bottom-nav"
      data-testid="pwa-bottom-navigation"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 80,
        display: 'grid',
        height: 'calc(64px + env(safe-area-inset-bottom, 0px))',
        boxSizing: 'border-box',
        gridTemplateColumns: `repeat(${navItems.length + 1}, minmax(0, 1fr))`,
        gap: 0,
        padding: '3px max(4px, env(safe-area-inset-left, 0px)) calc(4px + env(safe-area-inset-bottom, 0px)) max(4px, env(safe-area-inset-right, 0px))',
        borderTop: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
      }}
    >
      <style>{NAV_STYLES}</style>
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = isDashboardNavigationItemActive(item, pathname, resourceKind, workspaceShellEnabled);
        const launch = item.id === 'launch';
        // The tab always asks for the list explicitly; the legacy page
        // ignores ?runtimes=1.
        const href = item.id === 'home' ? DASHBOARD_RUNTIME_LIST_HREF : item.href;

        return (
          <Link
            key={item.id}
            href={href}
            aria-current={active ? 'page' : undefined}
            data-active={active}
            className={TAB_CLASS}
          >
            <span className={`hermes-pwa-bottom-nav__icon${launch ? ' hermes-pwa-bottom-nav__icon--launch' : ''}`} aria-hidden="true">
              <Icon size={18} strokeWidth={active || launch ? 2.4 : 2} />
            </span>
            <span className={`hermes-pwa-bottom-nav__label ${active ? 'font-semibold' : 'font-normal'}`}>
              {labelForNavigationItem(item, copy)}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-label={attentionCount > 0 ? `${text.more}, ${attentionCount} need attention` : text.more}
        data-active={moreActive}
        className={TAB_CLASS}
        onClick={() => setMoreOpen(true)}
      >
        <span className="hermes-pwa-bottom-nav__icon" aria-hidden="true">
          <Menu size={18} strokeWidth={moreActive ? 2.4 : 2} />
          {attentionCount > 0 && <span className="hermes-pwa-bottom-nav__badge">{attentionCount > 99 ? '99+' : attentionCount}</span>}
        </span>
        <span className={`hermes-pwa-bottom-nav__label ${moreActive ? 'font-semibold' : 'font-normal'}`}>{text.more}</span>
      </button>
      {moreOpen && (
        <MobileMoreSheet
          onClose={() => setMoreOpen(false)}
          onOpenSwitcher={() => onOpenSwitcher?.()}
          attentionCount={attentionCount}
          userName={userName}
          userEmail={userEmail}
          accountCode={accountCode}
          resourceKind={resourceKind}
        />
      )}
    </nav>
  );
}
