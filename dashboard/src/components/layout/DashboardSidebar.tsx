'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UserButton } from '@clerk/nextjs';
import { AlertCircle, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from '@/components/ui/NavigationLink';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from '@/components/theme-toggle';
import { useLocale } from '@/components/i18n/LocaleProvider';
import {
  DASHBOARD_LAUNCH_NAVIGATION,
  DASHBOARD_PRIMARY_NAVIGATION,
  DASHBOARD_RAIL_SHORT_LABELS,
  DASHBOARD_RUNTIME_LIST_HREF,
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
  isRuntimeDetailPath,
  labelForNavigationItem,
  type DashboardNavigationItem,
} from '@/lib/dashboard-navigation';
import { isWorkspaceShellNavigationEnabled } from '@/lib/flags/workspace-shell';
import { DashboardResourceSwitcher } from './DashboardResourceSwitcher';
import { resourceMatchesPath, type DashboardResource } from './dashboard-resources';
import { useDashboardResources } from './useDashboardResources';
import styles from './DashboardSidebar.module.css';

interface DashboardSidebarProps {
  userName: string;
  userEmail: string;
  resourceOwnerKey?: string;
  onActiveResourceKindChange?: (kind: DashboardResource['kind'] | null) => void;
  /** The phone bar has no sidebar, so it badges More with this count. */
  onAttentionCountChange?: (count: number) => void;
  /** Controlled by the shell so the phone header and More sheet can open it. */
  switcherOpen?: boolean;
  onSwitcherOpenChange?: (open: boolean) => void;
  showOpsLink?: boolean;
}

const SIDEBAR_EXPANDED_STORAGE_KEY = 'hivra:dashboard:sidebar-expanded';

export function getDashboardSidebarToggleStyle(isExpanded: boolean): React.CSSProperties {
  return {
    background: isExpanded ? 'var(--bg-elevated)' : 'var(--bg-surface)',
    border: isExpanded ? '1px solid var(--gold-leaf)' : '1px solid var(--etched-border)',
    color: isExpanded ? 'var(--ink-black)' : 'var(--text-muted)',
  };
}

const COMPACT_RAIL_QUERY = '(min-width: 768px) and (max-width: 1023px)';
function subscribeCompactRail(onChange: () => void) {
  const query = window.matchMedia(COMPACT_RAIL_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function compactRailSnapshot() { return window.matchMedia(COMPACT_RAIL_QUERY).matches; }
function serverCompactRailSnapshot() { return false; }

export const DashboardSidebar = React.memo(function DashboardSidebar({
  userName, userEmail, resourceOwnerKey, onActiveResourceKindChange, onAttentionCountChange,
  switcherOpen: controlledSwitcherOpen, onSwitcherOpenChange,
}: DashboardSidebarProps) {
  const owner = resourceOwnerKey ?? userEmail;
  const pathname = usePathname();
  const router = useRouter();
  const { copy } = useLocale();
  const dashboard = copy.dashboard;
  const [isExpanded, setIsExpanded] = useState(true);
  const compactRail = useSyncExternalStore(subscribeCompactRail, compactRailSnapshot, serverCompactRailSnapshot);
  const [compactExpanded, setCompactExpanded] = useState(false);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const [ownSwitcherOpen, setOwnSwitcherOpen] = useState(false);
  const switcherOpen = controlledSwitcherOpen ?? ownSwitcherOpen;
  const setSwitcherOpen = useCallback((open: boolean) => {
    setOwnSwitcherOpen(open);
    onSwitcherOpenChange?.(open);
  }, [onSwitcherOpenChange]);
  const aside = useRef<HTMLElement>(null);
  const { resources, loading, errors, refresh } = useDashboardResources(owner, pathname);
  const attentionCount = resources.filter(item => !loading && !errors[item.source] && (item.attention || item.status === "error")).length;
  const currentResource = resources.find((item) => resourceMatchesPath(item, pathname));
  const effectivelyExpanded = compactRail ? compactExpanded : isExpanded;
  const currentResourceKind = currentResource?.kind ?? null;

  useEffect(() => {
    onActiveResourceKindChange?.(currentResourceKind);
  }, [currentResourceKind, onActiveResourceKindChange]);

  useEffect(() => {
    onAttentionCountChange?.(attentionCount);
  }, [attentionCount, onAttentionCountChange]);

  useEffect(() => {
    // Browser preferences hydrate after the server/client initial render agrees.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    try {
      const saved = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
      setIsExpanded(saved !== 'false');
    } catch { /* A display preference cannot block navigation. */ }
  }, []);

  const previousOwner = useRef(owner);
  useEffect(() => {
    // The switcher closes when the authenticated owner changes.
    if (previousOwner.current === owner) return;
    previousOwner.current = owner;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSwitcherOpen(false);
  }, [owner, setSwitcherOpen]);

  // Every open refreshes the inventory once, whichever control opened it.
  const wasSwitcherOpen = useRef(false);
  useEffect(() => {
    if (switcherOpen && !wasSwitcherOpen.current) refresh();
    wasSwitcherOpen.current = switcherOpen;
  }, [switcherOpen, refresh]);

  const closeSwitcher = useCallback(() => setSwitcherOpen(false), [setSwitcherOpen]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      // Do not interrupt an unrelated modal or a runtime-owned native dialog.
      if (!switcherOpen && document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      setSwitcherOpen(!switcherOpen);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [switcherOpen, setSwitcherOpen]);

  const closeNavigation = () => setCompactExpanded(false);
  useEffect(() => {
    if (!compactRail || !compactExpanded || switcherOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!aside.current?.contains(event.target as Node)) setCompactExpanded(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [compactRail, compactExpanded, switcherOpen]);

  const toggleExpanded = () => {
    if (compactRail) { setCompactExpanded(current => !current); return; }
    const next = !isExpanded;
    setIsExpanded(next);
    try { window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(next)); } catch { /* Keep the current view usable. */ }
  };

  const localizedLabel = (item: DashboardNavigationItem): string => labelForNavigationItem(item, copy);
  // Touch tablets cannot see title tooltips, so the collapsed rail shows a label.
  const railLabel = (item: DashboardNavigationItem, label: string) =>
    effectivelyExpanded ? null : <span className={styles.railLabel} aria-hidden>{label === item.label ? DASHBOARD_RAIL_SHORT_LABELS[item.id] ?? label : label}</span>;
  const workspaceShellEnabled = isWorkspaceShellNavigationEnabled();
  // /dashboard can resume the last runtime (server shell flag, which self-host
  // builds hide from the client); from inside a runtime that reopens the one you
  // are leaving, so Home goes to the list. The legacy page ignores ?runtimes=1.
  const homeHref = pathname && isRuntimeDetailPath(pathname) ? DASHBOARD_RUNTIME_LIST_HREF : '/dashboard';
  const primaryNavigation = filterDashboardNavigation(
    DASHBOARD_PRIMARY_NAVIGATION,
    workspaceShellEnabled,
  );
  const renderNavigationItem = (item: DashboardNavigationItem) => {
    const active = isDashboardNavigationItemActive(
      item,
      pathname,
      currentResourceKind,
      workspaceShellEnabled,
    );
    const label = localizedLabel(item);
    const Icon = item.icon;
    return <Link key={item.id} href={item.id === 'home' ? homeHref : item.href} className={`${styles.navItem} ${active ? styles.active : ''}`}
      aria-current={active ? 'page' : undefined} aria-label={label} title={!effectivelyExpanded ? label : undefined}
      onClick={closeNavigation}><Icon size={17} aria-hidden />{effectivelyExpanded ? <span>{label}</span> : railLabel(item, label)}</Link>;
  };
  const openResource = (item: DashboardResource) => {
    closeSwitcher();
    closeNavigation();
    router.push(item.href);
  };
  const LaunchIcon = DASHBOARD_LAUNCH_NAVIGATION.icon;
  const launchLabel = localizedLabel(DASHBOARD_LAUNCH_NAVIGATION);

  return <>
    <div className={styles.spacer} style={{ width: !compactRail && isExpanded ? 248 : 72, minWidth: !compactRail && isExpanded ? 248 : 72 }} />
    <aside ref={aside} id="dashboard-navigation" aria-label="Workspace navigation" className={`${styles.sidebar} ${effectivelyExpanded ? styles.expanded : styles.collapsed} ${compactRail && compactExpanded ? styles.compactOpen : ''}`}
      onKeyDown={(event) => {
        if (compactRail && compactExpanded && event.key === 'Escape' && !switcherOpen) {
          event.preventDefault(); setCompactExpanded(false); toggleButton.current?.focus();
        }
      }}>
      <div className={styles.header}>
        <Link href={homeHref} aria-label="Hivra home" className={styles.brand} onClick={closeNavigation}>
          <span className={styles.brandMark}>H.</span>{effectivelyExpanded && <span className={styles.brandName}>Hivra</span>}
        </Link>
        <button ref={toggleButton} type="button" className={styles.collapseButton} onClick={toggleExpanded}
          title={effectivelyExpanded ? dashboard.controls.collapseSidebarTitle : dashboard.controls.expandSidebarTitle}
          aria-label={effectivelyExpanded ? dashboard.controls.collapseSidebarLabel : dashboard.controls.expandSidebarLabel}
          aria-expanded={effectivelyExpanded} style={getDashboardSidebarToggleStyle(effectivelyExpanded)}>
          {effectivelyExpanded ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {/* Only this part scrolls, so the collapse toggle that overhangs the rail
          is never clipped and the footer is reachable at any height. */}
      <div className={styles.body}>
        <button type="button" className={styles.searchButton} onClick={() => setSwitcherOpen(true)}
          aria-label="Switch agent or computer" title={!effectivelyExpanded ? 'Switch agent or computer (⌘/Ctrl K)' : undefined}
          aria-haspopup="dialog" aria-expanded={switcherOpen}>
          <Search size={16} aria-hidden />{effectivelyExpanded ? <><span>Switch or search</span><kbd>⌘ K</kbd></> : <span className={styles.railLabel} aria-hidden>Search</span>}
        </button>
        <Link href={DASHBOARD_LAUNCH_NAVIGATION.href} className={styles.launch} aria-label={launchLabel} onClick={closeNavigation}>
          <LaunchIcon size={17} aria-hidden />{effectivelyExpanded ? <span>{launchLabel}</span> : railLabel(DASHBOARD_LAUNCH_NAVIGATION, launchLabel)}
        </Link>
        <nav aria-label="Primary" data-navigation-group="primary" className={styles.navigation}>{primaryNavigation.map(renderNavigationItem)}</nav>
        {attentionCount > 0 && <Link href="/dashboard?runtimes=1&attention=1" className={`${styles.navItem} ${styles.attention}`} onClick={closeNavigation} aria-label={`${attentionCount} agents or computers need attention`}>
          <AlertCircle size={17} aria-hidden />{effectivelyExpanded && <span>Needs attention</span>}<span className={styles.attentionCount}>{attentionCount}</span>
        </Link>}
        <div className={styles.footer}>
          <nav aria-label="Manage" data-navigation-group="secondary" className={styles.navigation}>{filterDashboardNavigation(DASHBOARD_SECONDARY_NAVIGATION, isWorkspaceShellNavigationEnabled()).map(renderNavigationItem)}</nav>
          <nav aria-label="Applications and help" className={styles.navigation}>{DASHBOARD_UTILITY_NAVIGATION.map(renderNavigationItem)}</nav>
          <div className={styles.account}>
            {mounted ? <UserButton /> : <span className={styles.userPlaceholder} />}
            {effectivelyExpanded && <span className={styles.accountName}><strong>{userName}</strong><small>{userEmail}</small></span>}
            <ThemeToggle />
          </div>
        </div>
      </div>
    </aside>
    {switcherOpen && <DashboardResourceSwitcher resources={resources} loading={loading} errors={errors}
      onSelect={openResource} onClose={closeSwitcher} onBrowse={() => { closeSwitcher(); closeNavigation(); }} onRefresh={refresh} />}
  </>;
});
