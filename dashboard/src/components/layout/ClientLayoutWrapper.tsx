'use client';

import React, { useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import Link from '@/components/ui/NavigationLink';
import { UserButton } from '@clerk/nextjs';
import styles from './ClientLayoutWrapper.module.css';
import { DashboardSidebar } from './DashboardSidebar';
import { PwaBottomNavigation } from '@/components/pwa/PwaBottomNavigation';
import { WorkspaceModalLayerProvider } from '@/components/workspace/WorkspaceModalLayerContext';
import InteractiveBackground from '@/components/InteractiveBackground';
import { useWorkspaceViewport } from './useWorkspaceViewport';
import { NativeWorkspaceProvider, useNativeWorkspace, useNativeWorkspaceEnabled } from './NativeWorkspaceBridge';

interface ClientLayoutWrapperProps {
  children: React.ReactNode;
  userName: string;
  userEmail: string;
  resourceOwnerKey?: string;
  showOpsLink?: boolean;
}

const FULLSCREEN_TUI_ROUTE_PATTERN = /^\/dashboard\/instances\/[^/]+\/tui(?:\/|$)/;

function NativeAccountHeader({ userName }: { userName: string }) {
  const { ownerKey } = useNativeWorkspace();
  if (!ownerKey) return null;
  return <section aria-label="Account" className={styles.nativeAccount}>
    <div>
      <span className={styles.accountLabel}>Account</span>
      <p className={styles.accountName}>{userName}</p>
    </div>
    {/* The same Clerk/local-auth control used by the web sidebar owns account
        management and signout; the native shell never handles credentials. */}
    <UserButton />
  </section>;
}

function shouldShowPwaBottomNavigation(pathname: string | null): boolean {
  if (!pathname?.startsWith('/dashboard')) {
    return false;
  }

  return !FULLSCREEN_TUI_ROUTE_PATTERN.test(pathname);
}

export function ClientLayoutWrapper({
  children,
  userName,
  userEmail,
  resourceOwnerKey,
  showOpsLink = false,
}: ClientLayoutWrapperProps) {
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [activeResource, setActiveResource] = useState<{
    owner: string; pathname: string | null; kind: 'agent' | 'computer' | null;
  } | null>(null);
  const [attention, setAttention] = useState<{ owner: string; count: number } | null>(null);
  const pathname = usePathname();
  const nativeWorkspace = useNativeWorkspaceEnabled();
  const { keyboardOpen } = useWorkspaceViewport();
  const owner = resourceOwnerKey ?? userEmail;
  const handleActiveResourceKindChange = useCallback((kind: 'agent' | 'computer' | null) => {
    setActiveResource((current) => current?.owner === owner && current.pathname === pathname && current.kind === kind
      ? current : { owner, pathname, kind });
  }, [owner, pathname]);
  const activeResourceKind = activeResource?.owner === owner && activeResource.pathname === pathname
    ? activeResource.kind : null;
  const handleAttentionCountChange = useCallback((count: number) => {
    setAttention((current) => current?.owner === owner && current.count === count ? current : { owner, count });
  }, [owner]);
  const attentionCount = attention?.owner === owner ? attention.count : 0;
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const isInstancePage = pathname?.startsWith('/dashboard/instances/');
  const isWorkspacePage = pathname === '/dashboard/workspace' || /^\/dashboard\/agent\/[^/]+$/.test(pathname ?? '');
  // Runtime pages carry identity and back in their own resource bar.
  const showMobileHeader = !nativeWorkspace && !workspaceModalOpen && !pathname?.includes('/chat') && !pathname?.includes('/console') && !isInstancePage && !isWorkspacePage;
  const showPwaBottomNavigation = !nativeWorkspace && shouldShowPwaBottomNavigation(pathname) && !workspaceModalOpen && !keyboardOpen;
  // The canvas loop runs behind opaque runtime surfaces for no visible gain.
  const showInteractiveBackground = !pathname?.includes('/chat') && !isWorkspacePage && !isInstancePage;
  const deployEnv = process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV?.trim();
  const showEnvironmentBanner = Boolean(deployEnv && deployEnv.toLowerCase() !== 'production');
  const environmentLabel = deployEnv?.toUpperCase();

  return (
    <NativeWorkspaceProvider enabled={nativeWorkspace} pathname={pathname} ownerKey={owner}>
    <WorkspaceModalLayerProvider onActiveChange={setWorkspaceModalOpen}>
      <div data-testid="dashboard-viewport" data-keyboard-open={keyboardOpen} className={`flex flex-col md:flex-row w-full overflow-hidden relative ${styles.viewport}`}>
      {/* ServiceWorkerRegistration now mounts in the root layout so the offline
          shell registers on public routes too — see src/app/layout.tsx. */}
      {showInteractiveBackground && <InteractiveBackground />}

      {/* Main Container */}
      <div className={`flex w-full flex-1 min-h-0 relative z-10 ${showMobileHeader ? styles.withMobileHeader : ''}`}>
        {/* First in source order so screen readers and Tab reach it before the
            page; it is absolutely positioned, so layout is unchanged. */}
        {showMobileHeader && (
          <header data-testid="dashboard-mobile-header" className={styles.mobileHeader}>
            <Link href="/dashboard" aria-label="Hivra home" className={styles.brand}>
              <span className={styles.brandMark} aria-hidden="true">H.</span>
              <span className={styles.brandName}>Hivra</span>
            </Link>
            <button
              type="button"
              data-testid="mobile-search-btn"
              className={styles.searchButton}
              aria-label="Switch agent or computer"
              aria-haspopup="dialog"
              aria-expanded={switcherOpen}
              onClick={openSwitcher}
            >
              <Search size={18} aria-hidden="true" />
            </button>
          </header>
        )}

        {/* Sidebar */}
        {!nativeWorkspace && <div
          data-testid="dashboard-sidebar-chrome"
          aria-hidden={workspaceModalOpen ? "true" : undefined}
          className={workspaceModalOpen ? "hidden" : "contents"}
        >
          <DashboardSidebar
            userName={userName}
            userEmail={userEmail}
            resourceOwnerKey={resourceOwnerKey}
            onActiveResourceKindChange={handleActiveResourceKindChange}
            onAttentionCountChange={handleAttentionCountChange}
            switcherOpen={switcherOpen}
            onSwitcherOpenChange={setSwitcherOpen}
            showOpsLink={showOpsLink}
          />
        </div>}

        {/* Content Area. No z-index: a stacking context here would trap page
            modals beneath the mobile header and bottom bar. */}
        <main
          className={`flex-1 relative w-full min-w-0 ${
            isWorkspacePage ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto'
          } ${
            showPwaBottomNavigation ? 'hermes-pwa-bottom-nav-offset' : ''
          }`}
        >
          {showEnvironmentBanner && !workspaceModalOpen && (
            <div
              data-testid="environment-banner"
              style={{ color: "var(--ink-black)" }}
              className="static md:sticky top-0 z-[70] overflow-hidden text-ellipsis whitespace-nowrap md:overflow-visible border-b border-amber-500/40 bg-amber-500/15 px-4 py-1 text-center text-[11px] font-semibold uppercase tracking-[0.12em] shadow-[0_4px_20px_rgba(0,0,0,0.16)] backdrop-blur md:whitespace-normal md:py-2 md:text-xs md:tracking-[0.24em]"
            >
              <span className="md:hidden">{environmentLabel} · test env</span>
              <span className="hidden md:inline">{environmentLabel} — non-production test environment</span>
            </div>
          )}
          {nativeWorkspace && pathname === '/dashboard/settings' && <NativeAccountHeader userName={userName} />}
          {children}
        </main>

        {showPwaBottomNavigation && (
          <PwaBottomNavigation
            resourceKind={activeResourceKind}
            attentionCount={attentionCount}
            userName={userName}
            userEmail={userEmail}
            onOpenSwitcher={openSwitcher}
          />
        )}
      </div>
      </div>
    </WorkspaceModalLayerProvider>
    </NativeWorkspaceProvider>
  );
}
