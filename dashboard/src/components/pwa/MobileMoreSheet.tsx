'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { AlertCircle, LogOut, Moon, Search, Sun, UserRound, X } from 'lucide-react';
import Link from '@/components/ui/NavigationLink';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { switchThemeWithTransition } from '@/components/theme-toggle';
import {
  DASHBOARD_MOBILE_MORE_GROUPS,
  DASHBOARD_RUNTIME_LIST_HREF,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
  labelForNavigationItem,
  mobileNavigationCopy,
} from '@/lib/dashboard-navigation';
import { isWorkspaceShellNavigationEnabled } from '@/lib/flags/workspace-shell';
import { isLocalAuthMode } from '@/lib/self-host/config';

export interface MobileMoreSheetProps {
  onClose: () => void;
  onOpenSwitcher: () => void;
  attentionCount: number;
  userName: string;
  userEmail: string;
  /** The account code the server setup script shows. */
  accountCode?: string | null;
  resourceKind?: 'agent' | 'computer' | null;
}

type HostedAccountControls = {
  openUserProfile: () => void;
  signOut: () => Promise<unknown>;
};

/**
 * Local-auth builds alias @clerk/nextjs to a shim without useClerk, so hosted
 * account actions call the loaded ClerkJS instance (window.Clerk) directly.
 * Clerk's own UserButton popover cannot be used here: it portals outside this
 * modal dialog, where the page is inert.
 */
function hostedAccountControls(): HostedAccountControls | null {
  const clerk = (window as Window & { Clerk?: Partial<HostedAccountControls> & { loaded?: boolean } }).Clerk;
  return clerk?.loaded !== false && typeof clerk?.openUserProfile === 'function' && typeof clerk.signOut === 'function'
    ? (clerk as HostedAccountControls)
    : null;
}

/** How often an open sheet checks whether ClerkJS has finished loading. */
const CLERK_READY_POLL_MS = 250;

/** Same request as the local-auth UserButton in src/lib/self-host/clerk-client-shim.tsx. */
async function signOutLocalOperator() {
  await fetch('/api/self-host/auth/logout', { method: 'POST' }).catch(() => undefined);
  // A full load drops every client cache of the signed-out session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign('/sign-in');
}

const SHEET_STYLES = `
  .hivra-more-sheet {
    inset: auto 0 0 0;
    margin: 0;
    width: 100%;
    max-width: 100%;
    max-height: calc(var(--workspace-viewport-height, 100dvh) - env(safe-area-inset-top, 0px) - 24px);
    padding: 0;
    color: var(--ink-black);
    background: var(--bg-surface);
    border: 0;
    border-top: 1px solid var(--etched-border);
    border-radius: 0;
    box-shadow: 0 -16px 48px rgba(0, 0, 0, 0.24);
    overflow: hidden;
  }
  .hivra-more-sheet[open] { display: flex; flex-direction: column; }
  .hivra-more-sheet::backdrop { background: rgba(0, 0, 0, 0.5); }
  .hivra-more-sheet__head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 56px;
    padding: 6px max(8px, env(safe-area-inset-right, 0px)) 6px max(16px, env(safe-area-inset-left, 0px));
    border-bottom: 1px solid var(--etched-border);
  }
  .hivra-more-sheet__title,
  .hivra-more-sheet__heading {
    margin: 0;
    color: var(--text-muted);
    font-family: var(--font-mono), 'Space Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .hivra-more-sheet__close {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--etched-border);
    cursor: pointer;
    touch-action: manipulation;
  }
  .hivra-more-sheet__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 0 calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .hivra-more-sheet__group { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--etched-border); }
  .hivra-more-sheet__heading { padding: 0 max(16px, env(safe-area-inset-left, 0px)) 4px; }
  .hivra-more-sheet__row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 0 max(16px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));
    color: var(--text-secondary);
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    font-family: var(--font-mono), 'Space Mono', monospace;
    font-size: 13px;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .hivra-more-sheet__row svg { flex-shrink: 0; }
  .hivra-more-sheet__label { flex: 1; min-width: 0; }
  .hivra-more-sheet__hint { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }
  .hivra-more-sheet__row:active { background: var(--hivra-red-soft); transition: none; }
  .hivra-more-sheet__row[aria-current='page'] { color: var(--ink-black); background: var(--hivra-red-soft); border-left-color: var(--hivra-red); font-weight: 700; }
  .hivra-more-sheet__row:disabled { opacity: 0.5; cursor: default; }
  .hivra-more-sheet__row--attention { color: var(--ink-black); }
  .hivra-more-sheet__badge {
    display: inline-grid;
    place-items: center;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    color: #fff;
    background: var(--hivra-red);
    font-family: var(--font-mono), 'Space Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .hivra-more-sheet__identity {
    display: grid;
    gap: 2px;
    padding: 4px max(16px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px));
  }
  .hivra-more-sheet__identity strong { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .hivra-more-sheet__identity small { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
  .hivra-more-sheet :is(a, button):focus-visible { outline: 2px solid var(--hivra-red); outline-offset: -2px; }
`;

/** Phone "More": every destination that is not on the bottom bar, plus account and theme. */
export function MobileMoreSheet({ onClose, onOpenSwitcher, attentionCount, userName, userEmail, accountCode = null, resourceKind }: MobileMoreSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pathname = usePathname();
  const { copy } = useLocale();
  const text = mobileNavigationCopy(copy);
  const { resolvedTheme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const workspaceShellEnabled = isWorkspaceShellNavigationEnabled();
  const localAuth = isLocalAuthMode();
  // On phones this sheet is the only sign-out, so rows enable once ClerkJS loads.
  const [hosted, setHosted] = useState(() => (localAuth ? null : hostedAccountControls()));
  const dark = resolvedTheme === 'dark';

  useEffect(() => {
    if (localAuth || hosted) return;
    const timer = window.setInterval(() => {
      const controls = hostedAccountControls();
      if (controls) setHosted(controls);
    }, CLERK_READY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [localAuth, hosted]);

  useEffect(() => {
    const previous = document.activeElement;
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    try {
      if (localAuth) await signOutLocalOperator();
      else await hosted?.signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return createPortal(
    <dialog ref={dialog} className="hivra-more-sheet" aria-labelledby={titleId} data-testid="mobile-more-sheet"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{SHEET_STYLES}</style>
      <div className="hivra-more-sheet__head">
        <h2 id={titleId} className="hivra-more-sheet__title">{text.more}</h2>
        <button type="button" className="hivra-more-sheet__close" aria-label={text.close} onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="hivra-more-sheet__body">
        <button type="button" className="hivra-more-sheet__row" aria-haspopup="dialog"
          onClick={() => { onClose(); onOpenSwitcher(); }}>
          <Search size={18} aria-hidden /><span className="hivra-more-sheet__label">{text.switchOrSearch}</span>
        </button>
        {attentionCount > 0 && (
          <Link href={`${DASHBOARD_RUNTIME_LIST_HREF}&attention=1`} onClick={onClose}
            className="hivra-more-sheet__row hivra-more-sheet__row--attention"
            aria-label={`${attentionCount} agents or computers need attention`}>
            <AlertCircle size={18} aria-hidden /><span className="hivra-more-sheet__label">{text.needsAttention}</span>
            <span className="hivra-more-sheet__badge" aria-hidden>{attentionCount}</span>
          </Link>
        )}
        {DASHBOARD_MOBILE_MORE_GROUPS.map((group) => (
          <section key={group.id} className="hivra-more-sheet__group" aria-labelledby={`${titleId}-${group.id}`}>
            <h3 id={`${titleId}-${group.id}`} className="hivra-more-sheet__heading">{text[group.id]}</h3>
            {filterDashboardNavigation(group.items, workspaceShellEnabled).map((item) => {
              const Icon = item.icon;
              const active = isDashboardNavigationItemActive(item, pathname, resourceKind, workspaceShellEnabled);
              return (
                <Link key={item.id} href={item.href} onClick={onClose} className="hivra-more-sheet__row"
                  aria-current={active ? 'page' : undefined}>
                  <Icon size={18} aria-hidden /><span className="hivra-more-sheet__label">{labelForNavigationItem(item, copy)}</span>
                </Link>
              );
            })}
          </section>
        ))}
        <section className="hivra-more-sheet__group" aria-labelledby={`${titleId}-account`}>
          <h3 id={`${titleId}-account`} className="hivra-more-sheet__heading">{text.account}</h3>
          <div className="hivra-more-sheet__identity">
            <strong>{userName}</strong>
            {userEmail && <small>{userEmail}</small>}
            {accountCode && <small>Account code {accountCode}</small>}
          </div>
          {!localAuth && (
            <button type="button" className="hivra-more-sheet__row" disabled={!hosted}
              onClick={() => { onClose(); hosted?.openUserProfile(); }}>
              <UserRound size={18} aria-hidden /><span className="hivra-more-sheet__label">{text.manageAccount}</span>
            </button>
          )}
          <button type="button" className="hivra-more-sheet__row" disabled={signingOut || (!localAuth && !hosted)}
            onClick={() => void signOut()}>
            <LogOut size={18} aria-hidden /><span className="hivra-more-sheet__label">{signingOut ? text.signingOut : text.signOut}</span>
          </button>
          <button type="button" className="hivra-more-sheet__row"
            onClick={() => switchThemeWithTransition(setTheme, dark ? 'light' : 'dark')}>
            {dark ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
            <span className="hivra-more-sheet__label">{dark ? text.themeDark : text.themeLight}</span>
            <span className="hivra-more-sheet__hint">{dark ? text.switchToLight : text.switchToDark}</span>
          </button>
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
