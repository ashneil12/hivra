'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
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
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [activeResource, setActiveResource] = useState<{
    owner: string; pathname: string | null; kind: 'agent' | 'computer' | null;
  } | null>(null);
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
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const closeMobileNavigation = useCallback(() => {
    setIsMobileOpen(false);
    mobileToggle.current?.focus();
  }, []);
  const isInstancePage = pathname?.startsWith('/dashboard/instances/');
  const isWorkspacePage = pathname === '/dashboard/workspace' || /^\/dashboard\/agent\/[^/]+$/.test(pathname ?? '');
  const showMobileHeader = !nativeWorkspace && !workspaceModalOpen && !pathname?.includes('/chat') && !pathname?.includes('/console') && !isInstancePage;
  const showPwaBottomNavigation = !nativeWorkspace && shouldShowPwaBottomNavigation(pathname) && !workspaceModalOpen && !keyboardOpen;
  const showInteractiveBackground = !pathname?.includes('/chat');
  const deployEnv = process.env.NEXT_PUBLIC_HERMES_DEPLOY_ENV?.trim();
  const showEnvironmentBanner = Boolean(deployEnv && deployEnv.toLowerCase() !== 'production');
  const environmentLabel = deployEnv?.toUpperCase();

  // Close sidebar on navigation on mobile
  useEffect(() => {
    const closeTimerId = window.setTimeout(() => setIsMobileOpen(false), 0);

    return () => {
      window.clearTimeout(closeTimerId);
    };
  }, [pathname]);

  const handleMobileToggle = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  return (
    <NativeWorkspaceProvider enabled={nativeWorkspace} pathname={pathname} ownerKey={owner}>
    <WorkspaceModalLayerProvider onActiveChange={setWorkspaceModalOpen}>
      <div data-testid="dashboard-viewport" data-keyboard-open={keyboardOpen} className={`flex flex-col md:flex-row w-full overflow-hidden relative ${styles.viewport}`}>
      {/* ServiceWorkerRegistration now mounts in the root layout so the offline
          shell registers on public routes too — see src/app/layout.tsx. */}
      {showInteractiveBackground && <InteractiveBackground />}

      {/* Main Container */}
      <div className={`flex w-full flex-1 min-h-0 relative z-10 ${showMobileHeader ? styles.withMobileHeader : ''}`}>
        
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
            onMobileClose={closeMobileNavigation}
            onActiveResourceKindChange={handleActiveResourceKindChange}
            isMobileOpen={isMobileOpen}
            showOpsLink={showOpsLink}
          />
        </div>}

        {/* Backdrop for mobile */}
        {!nativeWorkspace && isMobileOpen && !workspaceModalOpen && (
          <div 
            className="md:hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={closeMobileNavigation}
          />
        )}

        {/* Content Area */}
        <main 
          className={`flex-1 relative z-10 w-full min-w-0 ${
            isWorkspacePage ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto'
          } ${
            showPwaBottomNavigation ? 'hermes-pwa-bottom-nav-offset' : ''
          }`}
        >
          {showEnvironmentBanner && !workspaceModalOpen && (
            <div
              data-testid="environment-banner"
              style={{ color: "var(--ink-black)" }}
              className="sticky top-0 z-[70] border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-xs font-semibold uppercase tracking-[0.24em] shadow-[0_4px_20px_rgba(0,0,0,0.16)] backdrop-blur"
            >
              {environmentLabel} — non-production test environment
            </div>
          )}
          {nativeWorkspace && pathname === '/dashboard/settings' && <NativeAccountHeader userName={userName} />}
          {children}
        </main>

        {showPwaBottomNavigation && <PwaBottomNavigation resourceKind={activeResourceKind} />}
        
        {/* Reserve mobile navigation space so it never covers page controls. */}
        {showMobileHeader && (
          <header data-testid="dashboard-mobile-header" className={styles.mobileHeader}>
            <Link href="/dashboard" aria-label="Hivra home" className={styles.brand}>
              <span className={styles.brandMark} aria-hidden="true">H.</span>
              <span className={styles.brandName}>Hivra</span>
            </Link>
          <button
             ref={mobileToggle}
             data-testid="mobile-menu-btn"
             aria-label={isMobileOpen ? "Close navigation" : "Open navigation"}
             aria-controls="dashboard-navigation"
             aria-expanded={isMobileOpen}
             className="flex items-center justify-center transition-all"
             onClick={handleMobileToggle}
             style={{
               width: "44px",
               height: "44px",
               background: isMobileOpen ? "var(--ink-black)" : "var(--vellum-bg)",
               border: isMobileOpen ? "1px solid var(--ink-black)" : "1px solid var(--etched-border)",
               boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
               color: isMobileOpen ? "var(--vellum-bg)" : "var(--text-muted)",
               WebkitTapHighlightColor: "transparent",
               touchAction: "manipulation"
             }}
             aria-pressed={isMobileOpen}
          >
             {isMobileOpen ? (
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                 <line x1="18" y1="6" x2="6" y2="18"></line>
                 <line x1="6" y1="6" x2="18" y2="18"></line>
               </svg>
             ) : (
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                 <line x1="4" y1="12" x2="20" y2="12"></line>
                 <line x1="4" y1="6" x2="20" y2="6"></line>
                 <line x1="4" y1="18" x2="20" y2="18"></line>
               </svg>
             )}
          </button>
          </header>
        )}
      </div>
      </div>
    </WorkspaceModalLayerProvider>
    </NativeWorkspaceProvider>
  );
}
