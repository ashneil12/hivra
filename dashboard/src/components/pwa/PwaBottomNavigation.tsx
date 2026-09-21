'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DASHBOARD_MOBILE_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
} from '@/lib/dashboard-navigation';
import { isWorkspaceShellNavigationEnabled } from '@/lib/flags/workspace-shell';

export function PwaBottomNavigation({ resourceKind }: { resourceKind?: 'agent' | 'computer' | null }) {
  const pathname = usePathname();
  const navItems = filterDashboardNavigation(
    DASHBOARD_MOBILE_NAVIGATION,
    isWorkspaceShellNavigationEnabled(),
  );

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
        gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))`,
        gap: 0,
        padding: '3px max(4px, env(safe-area-inset-left, 0px)) calc(4px + env(safe-area-inset-bottom, 0px)) max(4px, env(safe-area-inset-right, 0px))',
        borderTop: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
      }}
    >
      <style>{`
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
        }
      `}</style>
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = isDashboardNavigationItemActive(
          item,
          pathname,
          resourceKind,
          isWorkspaceShellNavigationEnabled(),
        );
        const launch = item.id === 'launch';

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="mono grid min-h-[56px] min-w-0 items-center justify-items-center gap-0.5 px-0 py-1 text-[11px] no-underline"
            style={{
              color: launch || active ? 'var(--ink-black)' : 'var(--text-muted)',
              background: launch ? 'rgba(255,66,68,0.12)' : active ? 'var(--hivra-red-soft)' : 'transparent',
              borderTop: launch ? '1px solid rgba(255,66,68,0.72)' : '1px solid transparent',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            <Icon size={18} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
            <span
              className={active ? "font-semibold" : "font-normal"}
              style={{
                overflow: 'hidden',
                maxWidth: '100%',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                letterSpacing: 0,
                lineHeight: 1.3,
              }}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
