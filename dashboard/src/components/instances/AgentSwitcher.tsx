'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, KeyRound, Monitor, X } from 'lucide-react';
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
  /** Distance from the top of the nearest positioned ancestor, in px. */
  top?: number;
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
        <KeyRound size={14} aria-hidden />Log in
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
  // doesn't cover the embedded chat's corner controls. Click to expand.
  if (!expanded) {
    return (
      <div
        style={{
          position: 'absolute',
          top,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          display: 'flex',
          pointerEvents: 'none',
        }}
      >
        <button
          type="button"
          aria-label="Show agent switcher"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '3px 8px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--etched-border)',
            color: 'var(--ink-black)',
            lineHeight: 1,
            cursor: 'pointer',
            opacity: 0.82,
            boxShadow: '0 4px 14px rgba(0,0,0,0.10)',
            transition: 'opacity 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.borderColor = 'var(--text-muted)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.82';
            e.currentTarget.style.borderColor = 'var(--etched-border)';
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              backgroundColor: active?.dot ?? 'var(--text-muted)',
            }}
          />
          <ChevronDown size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 'min(360px, calc(100vw - 24px))',
        pointerEvents: 'none',
      }}
    >
      {/* Collapse chevron + pill + (optional) live-browser button on one row. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      {/* Collapse back to the small handle. */}
      <button
        type="button"
        aria-label="Hide agent switcher"
        onClick={() => setExpanded(false)}
        style={{
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 26,
          height: 26,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--etched-border)',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
          transition: 'border-color 0.15s ease, color 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--text-muted)';
          e.currentTarget.style.color = 'var(--ink-black)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--etched-border)';
          e.currentTarget.style.color = 'var(--text-muted)';
        }}
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
        style={{
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: '100%',
          padding: '5px 10px 5px 11px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--etched-border)',
          color: 'var(--ink-black)',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1,
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
          transition: 'border-color 0.15s ease, background 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--text-muted)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--etched-border)';
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            flexShrink: 0,
            backgroundColor: active?.dot ?? 'var(--text-muted)',
          }}
        />
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {active?.name ?? 'Select agent'}
        </span>
        <ChevronDown
          size={13}
          style={{
            flexShrink: 0,
            opacity: 0.6,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.18s ease',
          }}
        />
      </button>

        {/* Live-browser button — only when a noVNC stream is detected (Hermes). */}
        {browserReady && (
          <>
          <button
            type="button"
            aria-label="View live browser"
            title="Watch the agent's live browser"
            onClick={() =>
              window.open(`/api/instances/${activeId}/browser-stream`, '_blank', 'noopener,noreferrer')
            }
            style={{
              pointerEvents: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              padding: '5px 10px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--etched-border)',
              color: 'var(--ink-black)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              lineHeight: 1,
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
              transition: 'border-color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--text-muted)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--etched-border)';
            }}
          >
            <Monitor size={13} />
            Browser
          </button>
          <button
            type="button"
            aria-label="Import cookies"
            title="Log the agent's browser into your accounts"
            onClick={() => setCookieImportOpen(true)}
            style={{
              pointerEvents: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              padding: '5px 10px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--etched-border)',
              color: 'var(--ink-black)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              lineHeight: 1,
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
              transition: 'border-color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--text-muted)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--etched-border)';
            }}
          >
            <KeyRound size={13} />
            Log in
          </button>
          </>
        )}
      </div>
      {cookieImportOpen && activeId && (
        <CookieImportModal
          instanceId={activeId}
          onClose={() => setCookieImportOpen(false)}
          onOpenBrowser={() =>
            window.open(`/api/instances/${activeId}/browser-stream`, '_blank', 'noopener,noreferrer')
          }
        />
      )}

      {/* The drop-down panel. Floats; never resizes the chat beneath it. */}
      {open && (
        <div
          role="menu"
          aria-label="Your agents"
          style={{
            pointerEvents: 'auto',
            marginTop: 6,
            width: '100%',
            maxHeight: 'min(60vh, 420px)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-surface)',
            border: '1px solid var(--etched-border)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 6px 8px 12px',
              borderBottom: '1px solid var(--etched-border)',
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}
            >
              Your agents
            </span>
            {/* Flush close — sits inside the panel header, doesn't protrude. */}
            <button
              type="button"
              aria-label="Close agent switcher"
              onClick={closePanel}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--ink-black)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              <X size={14} />
            </button>
          </div>

          <div style={{ overflowY: 'auto', padding: 4 }}>
            {agents.map((agent) => {
              const isActive = agent.uid === activeUid;
              return (
                <button
                  key={agent.uid}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => switchTo(agent)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    width: '100%',
                    padding: '8px 10px',
                    background: isActive ? 'var(--bg-elevated)' : 'transparent',
                    border: 'none',
                    borderLeft: isActive
                      ? '2px solid var(--ink-black)'
                      : '2px solid transparent',
                    color: isActive ? 'var(--ink-black)' : 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 12.5,
                    fontWeight: isActive ? 600 : 500,
                    textAlign: 'left',
                    cursor: isActive ? 'default' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'var(--bg-elevated)';
                      e.currentTarget.style.color = 'var(--ink-black)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--text-secondary)';
                    }
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      flexShrink: 0,
                      backgroundColor: agent.dot,
                    }}
                  />
                  <span
                    style={{
                      minWidth: 0,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {agent.name}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                    }}
                  >
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 12px',
              background: 'transparent',
              border: 'none',
              borderTop: '1px solid var(--etched-border)',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--ink-black)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted)';
            }}
          >
            + Deploy another agent
          </button>
        </div>
      )}
    </div>
  );
}
