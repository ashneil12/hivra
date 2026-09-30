'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, KeyRound, Monitor, ServerCog, X } from 'lucide-react';
import { clientLog } from '@/lib/client/logger';
import { listAgents } from '@/lib/hivra/agent-api';
import { CookieImportModal } from '@/components/instances/CookieImportModal';
import { useNativeWorkspace } from '@/components/layout/NativeWorkspaceBridge';
import styles from './AgentSwitcher.module.css';
import {
  unifyAll,
  type HermesInstanceLite,
  type UnifiedAgent,
  type UnifiedKind,
} from '@/lib/hivra/unified-agent';

interface InstanceSummary {
  id: string;
  name: string;
  status: string;
  provider?: string;
  model?: string | null;
}

interface AgentSwitcherProps {
  activeKind: UnifiedKind;
  activeId: string;
  /** Distance from the top of the nearest positioned ancestor (px or a CSS length). */
  top?: number | string;
  /** Show the Console link in the expanded row (off where the host already shows one). */
  showConsole?: boolean;
  /** Toolbar slot for the collapsed handle. The expanded switcher still renders
   *  in place, so it opens below the host's banners. `null` while the slot mounts. */
  handleHost?: HTMLElement | null;
}

/** Native navigation owns resource switching. Keep these actual browser actions
 * in the authenticated web surface, with the same readiness check and modal. */
function NativeAgentBrowserTools({ activeKind, activeId }: AgentSwitcherProps) {
  const [ready, setReady] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const importTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeKind !== 'hermes' || !activeId) return;
    const controller = new AbortController();
    void fetch(`/api/instances/${activeId}/browser-sessions`, { cache: 'no-store', signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setReady(response.ok); })
      .catch(() => { /* An unavailable stream does not offer browser actions. */ });
    return () => controller.abort();
  }, [activeKind, activeId]);
  if (!ready) return null;
  const openBrowser = () => window.open(`/api/instances/${activeId}/browser-stream`, '_blank', 'noopener,noreferrer');
  return <>
    <div className={styles.nativeTools} role="group" aria-label="Agent browser tools">
      <button className={styles.tool} type="button" aria-label="View live browser" title="Watch the agent's live browser" onClick={openBrowser}>
        <Monitor size={14} aria-hidden />Browser
      </button>
      <button ref={importTrigger} className={styles.tool} type="button" aria-label="Import cookies" title="Log the agent's browser into your accounts" onClick={() => setImportOpen(true)}>
        <KeyRound size={14} aria-hidden /><span className={styles.fineOnly}>Log in</span><span className={styles.coarseOnly}>Log in (desktop)</span>
      </button>
    </div>
    {importOpen && <CookieImportModal instanceId={activeId} onClose={() => { setImportOpen(false); importTrigger.current?.focus(); }} onOpenBrowser={openBrowser} />}
  </>;
}

export function AgentSwitcher(props: AgentSwitcherProps) {
  const { enabled, ownerKey } = useNativeWorkspace();
  if (enabled) return ownerKey
    ? <NativeAgentBrowserTools key={`${ownerKey}:${props.activeKind}:${props.activeId}`} {...props} /> : null;
  return <WebAgentSwitcher {...props} />;
}

// The drop-down's open/closed state is sticky: once a user opens it, it stays
// open across navigation AND page refreshes until they explicitly close it
// (the flush ✕ inside the panel, or re-tapping the pill). This mirrors the
// "stay open just for those people who might want it" request — it is NOT a
// transient menu, so we deliberately do NOT close on outside-click.
const OPEN_STORAGE_KEY = 'hermes:agentSwitcher:open';

function readStickyOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistStickyOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode) — sticky-open just won't persist.
  }
}

// Route per family: Hermes instances live under /dashboard/instances/[id],
// Hivra boxes under /dashboard/agent/[id]. unifyAll() preserves each row's kind.
function hrefFor(agent: UnifiedAgent): string {
  return agent.kind === 'hermes'
    ? `/dashboard/instances/${agent.id}`
    : `/dashboard/agent/${agent.id}`;
}

/**
 * Top-anchored agent switcher for the chat surfaces.
 *
 * A small embedded pill floats at the top of the chat. Tapping it drops down a
 * panel listing ALL of the account's deployed agents across BOTH families —
 * Hermes instances and Hivra boxes — so you can hop between them without going
 * back to the Command Center. Picking one navigates to that agent's chat
 * (routed to the correct surface for its family). "Whatever the last chat you
 * were on" persistence is already handled upstream (hermes_last_chat cookie +
 * /dashboard/chat resolver), so this is purely the switch affordance.
 *
 * Mounted on both /dashboard/instances/[id] (activeKind="hermes") and
 * /dashboard/agent/[id] (activeKind="hivra"). With nothing deployed it renders
 * nothing; with one agent it still shows (discoverable + deploy-another); it's
 * a true switcher the moment a second agent exists in either family.
 */
function WebAgentSwitcher({
  activeKind,
  activeId,
  top = 10,
  showConsole = true,
  handleHost,
}: AgentSwitcherProps) {
  const router = useRouter();
  const [hermes, setHermes] = useState<HermesInstanceLite[]>([]);
  const [hivra, setHivra] = useState<Awaited<ReturnType<typeof listAgents>>>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(readStickyOpen);
  // Hermes instances ship a live agent browser (Pro browser-sidecar: Chromium +
  // noVNC). browserReady mirrors the readiness probe so we only offer the view
  // action when a stream is actually up. Hivra boxes surface their browser via
  // their own Browser tab, so this stays false for them.
  const [browserReady, setBrowserReady] = useState(false);
  // Cookie-import modal (log the live browser into the user's accounts).
  const [cookieImportOpen, setCookieImportOpen] = useState(false);
  // Resting state is a small overlay handle, not the full pill — so the switcher
  // never covers the embedded chat's own top controls (e.g. the preview pane's
  // close button) at rest. Click the handle to expand to the pill + list; a
  // collapse chevron returns to the handle. Deliberately NOT persisted: every
  // page lands small, and an expand is a transient, user-initiated reveal.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function fetchAll() {
      // Pull both families in parallel; a failure in either still surfaces the
      // other (the switcher degrades, never blanks out).
      const [hermesRes, hivraRes] = await Promise.allSettled([
        fetch('/api/instances?summary=true').then((r) => r.json()),
        listAgents(),
      ]);

      if (!mounted) return;

      if (hermesRes.status === 'fulfilled' && hermesRes.value?.success) {
        const rows: InstanceSummary[] = hermesRes.value.data ?? [];
        setHermes(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            provider: r.provider,
            model: r.model ?? null,
          }))
        );
      } else if (hermesRes.status === 'rejected') {
        clientLog.error('Failed to fetch Hermes instances for switcher', hermesRes.reason, {
          source: 'agent-switcher',
          failureType: 'agent_switcher_instances_fetch_failed',
        });
      }

      if (hivraRes.status === 'fulfilled') {
        setHivra(hivraRes.value);
      } else {
        clientLog.error('Failed to fetch Hivra agents for switcher', hivraRes.reason, {
          source: 'agent-switcher',
          failureType: 'agent_switcher_hivra_fetch_failed',
        });
      }

      setLoading(false);
    }
    void fetchAll();
    return () => {
      mounted = false;
    };
  }, []);

  // Probe the live-browser readiness endpoint (Hermes only). r.ok ⇒ a noVNC
  // stream is up, i.e. browser automation is enabled and reachable.
  useEffect(() => {
    // Hivra agents use their own Browser tab, so the probe (and button) are
    // Hermes-only. browserReady stays at its initial false for non-Hermes.
    if (activeKind !== 'hermes') return;
    let alive = true;
    fetch(`/api/instances/${activeId}/browser-sessions`, { cache: 'no-store' })
      .then((r) => {
        if (alive) setBrowserReady(r.ok);
      })
      .catch(() => {
        /* not available — leave the button hidden */
      });
    return () => {
      alive = false;
    };
  }, [activeKind, activeId]);

  const agents = useMemo(() => unifyAll(hermes, hivra), [hermes, hivra]);
  const activeUid = `${activeKind === 'hermes' ? 'h' : 'x'}-${activeId}`;
  const active = agents.find((a) => a.uid === activeUid);

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      persistStickyOpen(next);
      return next;
    });
  }

  function closePanel() {
    setOpen(false);
    persistStickyOpen(false);
  }

  function switchTo(agent: UnifiedAgent) {
    if (agent.uid === activeUid) {
      closePanel();
      return;
    }
    // Keep the panel's sticky-open state so it stays open on the agent we land
    // on — a refresh-equivalent navigation.
    router.push(hrefFor(agent));
  }

  // While the list is still loading, render nothing rather than flashing a
  // half-built control.
  if (loading) return null;

  // Nothing deployed in either family → nothing to show.
  if (agents.length === 0) return null;

  // Collapsed: a small overlay pull-tab (active-agent dot + chevron). It floats
  // over the content WITHOUT reserving a band, so nothing is pushed down and it
  // doesn't cover the embedded chat's corner controls. Click to expand. Touch
  // pointers get a 44px handle with a visible AGENTS label (see the CSS module).
  if (!expanded) {
    const handle = (
      <button
        type="button"
        aria-label="Agents: show agent switcher"
        aria-expanded={false}
        onClick={() => setExpanded(true)}
        className={styles.handle}
      >
        <span
          aria-hidden="true"
          className={styles.handleDot}
          style={{ backgroundColor: active?.dot ?? 'var(--text-muted)' }}
        />
        <span aria-hidden="true" className={styles.handleLabel}>Agents</span>
        <ChevronDown size={13} className={styles.handleChevron} />
      </button>
    );
    if (handleHost !== undefined) {
      return handleHost ? createPortal(<div className={styles.hostedHandle}>{handle}</div>, handleHost) : null;
    }
    return <div className={styles.anchor} style={{ top }}>{handle}</div>;
  }

  const openBrowserStream = () =>
    window.open(`/api/instances/${activeId}/browser-stream`, '_blank', 'noopener,noreferrer');

  return (
    <div className={`${styles.anchor} ${styles.anchorExpanded}`} style={{ top }}>
      {/* Collapse chevron + pill + console + (optional) live-browser tools. */}
      <div className={styles.row}>
      {/* Collapse back to the small handle. */}
      <button
        type="button"
        aria-label="Hide agent switcher"
        onClick={() => setExpanded(false)}
        className={styles.collapse}
      >
        <ChevronUp size={14} />
      </button>
      {/* The pill — the one always-present affordance. Embedded, low-profile. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch agent"
        onClick={toggleOpen}
        className={styles.pill}
      >
        <span
          aria-hidden="true"
          className={styles.pillDot}
          style={{ backgroundColor: active?.dot ?? 'var(--text-muted)' }}
        />
        <span className={styles.pillName}>{active?.name ?? 'Select agent'}</span>
        <ChevronDown
          size={13}
          className={`${styles.pillChevron} ${open ? styles.pillChevronOpen : ''}`}
        />
      </button>

        {/* Console for this Hermes agent — the page header is hidden on this
            route, so the switcher carries the way there. */}
        {activeKind === 'hermes' && showConsole && (
          <Link
            href={`/dashboard/instances/${activeId}/console`}
            aria-label="Open console"
            className={styles.chip}
          >
            <ServerCog size={13} aria-hidden="true" />
            Console
          </Link>
        )}

        {/* Live-browser button — only when a noVNC stream is detected (Hermes). */}
        {browserReady && (
          <>
          <button
            type="button"
            aria-label="View live browser"
            title="Watch the agent's live browser"
            onClick={openBrowserStream}
            className={styles.chip}
          >
            <Monitor size={13} />
            Browser
          </button>
          <button
            type="button"
            aria-label="Import cookies"
            title="Log the agent's browser into your accounts"
            onClick={() => setCookieImportOpen(true)}
            className={styles.chip}
          >
            <KeyRound size={13} />
            <span className={styles.fineOnly}>Log in</span>
            <span className={styles.coarseOnly}>Log in (desktop)</span>
          </button>
          </>
        )}
      </div>
      {cookieImportOpen && activeId && (
        <CookieImportModal
          instanceId={activeId}
          onClose={() => setCookieImportOpen(false)}
          onOpenBrowser={openBrowserStream}
        />
      )}

      {/* The drop-down panel. Floats; never resizes the chat beneath it. */}
      {open && (
        <div role="menu" aria-label="Your agents" className={styles.menu}>
          <div className={styles.menuHeader}>
            <span className={`mono ${styles.menuTitle}`}>Your agents</span>
            {/* Flush close — sits inside the panel header, doesn't protrude. */}
            <button
              type="button"
              aria-label="Close agent switcher"
              onClick={closePanel}
              className={styles.menuClose}
            >
              <X size={14} />
            </button>
          </div>

          <div className={styles.menuList}>
            {agents.map((agent) => {
              const isActive = agent.uid === activeUid;
              return (
                <button
                  key={agent.uid}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => switchTo(agent)}
                  className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className={styles.menuItemDot}
                    style={{ backgroundColor: agent.dot }}
                  />
                  <span className={styles.menuItemName}>{agent.name}</span>
                  <span className={styles.menuItemVendor}>
                    {/* Vendor, not typeLabel: a Hivra box named "Claude Code"
                        would otherwise read "Claude Code · CLAUDE CODE". Vendor
                        ("Anthropic"/"OpenAI") disambiguates; Hermes is unchanged
                        (its vendor IS "Hermes"). */}
                    {isActive ? 'Current' : agent.vendor}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className={styles.deploy}
          >
            + Deploy another agent
          </button>
        </div>
      )}
    </div>
  );
}
