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
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
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
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  onActiveResourceKindChange?: (kind: DashboardResource['kind'] | null) => void;
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
  userName, userEmail, resourceOwnerKey, isMobileOpen = false, onMobileClose, onActiveResourceKindChange,
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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const { resources, loading, errors, refresh } = useDashboardResources(owner, pathname);
  const attentionCount = resources.filter(item => !loading && !errors[item.source] && (item.attention || item.status === "error")).length;
  const currentResource = resources.find((item) => resourceMatchesPath(item, pathname));
  const effectivelyExpanded = isMobileOpen || (compactRail ? compactExpanded : isExpanded);
  const currentResourceKind = currentResource?.kind ?? null;

  useEffect(() => {
    onActiveResourceKindChange?.(currentResourceKind);
  }, [currentResourceKind, onActiveResourceKindChange]);

  useEffect(() => {
    // Browser preferences hydrate after the server/client initial render agrees.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    try {
      const saved = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
      setIsExpanded(saved !== 'false');
    } catch { /* A display preference cannot block navigation. */ }
  }, []);

  useEffect(() => {
    // The switcher closes when the authenticated owner changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSwitcherOpen(false);
  }, [owner]);

  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      // Do not interrupt an unrelated modal or a runtime-owned native dialog.
      if (!switcherOpen && document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      if (!switcherOpen) refresh();
      setSwitcherOpen(!switcherOpen);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [switcherOpen, refresh]);

  useEffect(() => {
    if (!isMobileOpen) return;
    const previous = document.activeElement;
    searchButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [isMobileOpen]);

  const closeNavigation = () => {
    setCompactExpanded(false);
    onMobileClose?.();
  };
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

  const localizedLabel = (item: DashboardNavigationItem): string => {
    const labels: Partial<Record<DashboardNavigationItem['id'], string>> = {
      home: dashboard.nav.home, chat: dashboard.nav.chat, computers: dashboard.nav.computers, agents: dashboard.nav.agents,
      infrastructure: dashboard.nav.infrastructure, settings: dashboard.nav.settings, launch: dashboard.nav.launch,
    };
    return labels[item.id] ?? item.label;
  };
  const workspaceShellEnabled = isWorkspaceShellNavigationEnabled();
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
    return <Link key={item.id} href={item.href} className={`${styles.navItem} ${active ? styles.active : ''}`}
      aria-current={active ? 'page' : undefined} aria-label={label} title={!effectivelyExpanded ? label : undefined}
      onClick={closeNavigation}><Icon size={17} aria-hidden />{effectivelyExpanded && <span>{label}</span>}</Link>;
  };
  const openResource = (item: DashboardResource) => {
    closeSwitcher();
    closeNavigation();
    router.push(item.href);
  };
  const LaunchIcon = DASHBOARD_LAUNCH_NAVIGATION.icon;

  return <>
    <div className={styles.spacer} style={{ width: !compactRail && isExpanded ? 248 : 72, minWidth: !compactRail && isExpanded ? 248 : 72 }} />
    <aside ref={aside} id="dashboard-navigation" aria-label="Workspace navigation" className={`${styles.sidebar} ${effectivelyExpanded ? styles.expanded : styles.collapsed} ${isMobileOpen ? styles.mobileOpen : ''} ${compactRail && compactExpanded ? styles.compactOpen : ''}`}
      onKeyDown={(event) => {
        if (compactRail && compactExpanded && event.key === 'Escape' && !switcherOpen) {
          event.preventDefault(); setCompactExpanded(false); toggleButton.current?.focus(); return;
        }
        if (!isMobileOpen || switcherOpen) return;
        if (event.key === 'Escape') { event.preventDefault(); onMobileClose?.(); }
        if (event.key !== 'Tab') return;
        const controls = [...(aside.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') ?? [])]
          .filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className={styles.header}>
        <Link href="/dashboard" aria-label="Hivra home" className={styles.brand} onClick={closeNavigation}>
          <span className={styles.brandMark}>H.</span>{effectivelyExpanded && <span className={styles.brandName}>Hivra</span>}
        </Link>
        <button ref={toggleButton} type="button" className={styles.collapseButton} onClick={toggleExpanded}
          title={effectivelyExpanded ? dashboard.controls.collapseSidebarTitle : dashboard.controls.expandSidebarTitle}
          aria-label={effectivelyExpanded ? dashboard.controls.collapseSidebarLabel : dashboard.controls.expandSidebarLabel}
          aria-expanded={effectivelyExpanded} style={getDashboardSidebarToggleStyle(effectivelyExpanded)}>
          {effectivelyExpanded ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      <button ref={searchButton} type="button" className={styles.searchButton} onClick={() => { refresh(); setSwitcherOpen(true); }}
        aria-label="Switch agent or computer" title={!effectivelyExpanded ? 'Switch agent or computer (⌘/Ctrl K)' : undefined}
        aria-haspopup="dialog" aria-expanded={switcherOpen}>
        <Search size={16} aria-hidden />{effectivelyExpanded && <><span>Switch or search</span><kbd>⌘ K</kbd></>}
      </button>
      <Link href={DASHBOARD_LAUNCH_NAVIGATION.href} className={styles.launch} aria-label={localizedLabel(DASHBOARD_LAUNCH_NAVIGATION)} onClick={closeNavigation}>
        <LaunchIcon size={17} aria-hidden />{effectivelyExpanded && <span>{localizedLabel(DASHBOARD_LAUNCH_NAVIGATION)}</span>}
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
    </aside>
    {switcherOpen && <DashboardResourceSwitcher resources={resources} loading={loading} errors={errors}
      onSelect={openResource} onClose={closeSwitcher} onBrowse={() => { closeSwitcher(); closeNavigation(); }} onRefresh={refresh} />}
  </>;
});
