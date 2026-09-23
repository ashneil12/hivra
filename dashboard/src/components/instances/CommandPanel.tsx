'use client';

// CommandPanel — a right-docked, toggleable sidebar that sits BESIDE the upstream
// webchat iframe on the instance detail page (paioclaw-style "command panel").
//
// It composes EXISTING wave-1 surfaces (no duplication) plus a few small new
// tiles into a single scrollable rail, top to bottom:
//   1. Today's brief   — a TEXT daily summary derived from the activity digest.
//   2. Activity        — the existing <AgentActivityDigest> (live work + sessions).
//   3. Workflows       — a managed, run-anytime list (<WorkflowsPanel>).
//   4. Apps            — BYO-Composio: a guided "paste your key" step, then one-tap
//                        connect tiles (Calendar, Gmail, Slack, Notion, GitHub, +
//                        1,000 more) that launch the hosted OAuth. Tools the agent USES.
//   5. Chat channels   — a COLLAPSIBLE quick-connect list over CHANNEL_SURFACE (how you
//                        MESSAGE the agent), "View all" → the full channels modal.
//
// Additive + zero-regression: the iframe is untouched; the parent gates rendering
// and owns the open/close toggle (persisted to localStorage). This component only
// reads (one GET for the activity digest, one GET for integration statuses) and
// delegates all connect flows back to surfaces that already exist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CalendarDays,
  ChevronDown,
  FileText,
  GitBranch,
  Hash,
  Inbox as InboxIcon,
  Layers,
  Loader2,
  PanelRightClose,
  Plug,
  Plus,
  ServerCog,
  Sparkles,
  X,
} from 'lucide-react';

import { AgentActivityDigest } from '@/components/dashboard/command-center/AgentActivityDigest';
import { ComposioAppPicker } from '@/components/instances/ComposioAppPicker';
import { ComposioKeyPanel } from '@/components/instances/ComposioKeyPanel';
import { GettingStarted } from '@/components/instances/GettingStarted';
import { WorkflowsPanel, isWorkflowsRunFlagOn } from '@/components/instances/WorkflowsPanel';
import { VoiceBrief } from '@/components/instances/VoiceBrief';
import { CHANNEL_SURFACE } from '@/lib/integrations/channel-surface';
import type { InstanceActivityDigest } from '@/lib/command-center/activity';
import {
  useComposioConnect,
  useComposioConnectedApps,
  useComposioKey,
} from '@/lib/composio/use-composio-connect';

export interface CommandPanelProps {
  instanceId: string;
  /** Friendly agent name, woven into copy + reused by the workflows shelf. */
  instanceName?: string | null;
  /** Lowercased-or-not status string; the brief/activity adapt to non-running. */
  instanceStatus?: string | null;
  /** Injects a workflow prompt into the chat composer (wired to the iframe sender). */
  onRunWorkflow?: (prompt: string) => boolean;
  /** Opens the full channels grid (the existing <InstanceChannelsPanel> modal). */
  onOpenChannels?: (channel?: string) => void;
  /** Collapses the panel (parent persists the toggle to localStorage). */
  onCollapse?: () => void;
  /** "dock" is the desktop right rail; "sheet" is the narrow-viewport bottom sheet. */
  variant?: 'dock' | 'sheet';
  /** Console link shown in the sheet header (the page header is hidden there). */
  consoleHref?: string;
}

// Touch sizing for the panel internals. Inline styles size the desktop rail, so
// these rules use !important and apply inside the sheet or on coarse pointers.
const TOUCH_RULES = (scope: string) => `
  ${scope} .cmdp-icon-btn { min-width: 44px !important; min-height: 44px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }
  ${scope} .cmdp-row { min-height: 44px !important; }
  ${scope} .cmdp-pad { padding-top: 8px !important; padding-bottom: 8px !important; }
  ${scope} .cmdp-small { font-size: 11px !important; }
`;
const COMMAND_PANEL_TOUCH_CSS = `${TOUCH_RULES('[data-cmdp][data-sheet]')}
@media (pointer: coarse) {${TOUCH_RULES('[data-cmdp]')}}`;

type StatusMap = Record<string, { configured?: boolean; partial?: boolean }>;

// A short, honest section header used across the rail.
const KICKER: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
  fontWeight: 700,
  color: 'var(--text-secondary)',
  opacity: 0.8,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div className="mono cmdp-small" style={KICKER}>
        {title}
      </div>
      {children}
    </section>
  );
}

/**
 * Compose a one-paragraph "today's brief" from the same activity digest the
 * Activity section renders — no extra endpoint. Reads as a human summary rather
 * than a status badge.
 */
function briefText(
  digest: InstanceActivityDigest | null,
  loading: boolean,
  agentName: string,
  // Whether the Workflows shelf is actually rendered below. When it isn't, the
  // brief must not point the user at "a ready-to-run workflow below" / "kick off
  // a new workflow" — that would advertise UI that isn't there.
  workflowsVisible: boolean,
): string {
  if (loading) return `Catching up on what ${agentName} has been doing…`;
  if (!digest) return `${agentName}'s daily brief will appear here once there's activity to summarize.`;

  const sessionCount = digest.recentSessions.length;
  const attention = digest.attentionItems.length;

  if (digest.state === 'not_running') {
    return `${agentName} is stopped right now. Start the agent to pick up where you left off — your brief resumes as soon as it's running.`;
  }
  if (digest.state === 'unreachable') {
    // Calm neutral fallback (the builder no longer emits this state, but guard
    // anyway): never surface a "couldn't be read"/error tone to the user.
    return `${agentName} is ready for your next task. Send a message in the chat to get started.`;
  }
  if (attention > 0) {
    return `${agentName} needs you: ${digest.headline.toLowerCase()}. Clear that and it keeps moving.`;
  }
  if (digest.state === 'responding') {
    return `${agentName} is working right now${
      sessionCount ? ` across ${sessionCount} recent ${sessionCount === 1 ? 'session' : 'sessions'}` : ''
    }. Check back in a moment for the result.`;
  }
  if (sessionCount > 0) {
    const tail = workflowsVisible
      ? 'Pick one up below or kick off a new workflow.'
      : 'Send a message in the chat to pick up where you left off.';
    return `${agentName} has ${sessionCount} recent ${
      sessionCount === 1 ? 'session' : 'sessions'
    } and is waiting on your next message. ${tail}`;
  }
  return workflowsVisible
    ? `${agentName} is ready and waiting for your first task. Try a ready-to-run workflow below to see it in action.`
    : `${agentName} is ready and waiting for your first task. Send a message in the chat to get started.`;
}

/** A quick-connect channel row (compact reuse of the channels surface). */
function QuickConnectRow({
  label,
  Icon,
  connected,
  partial,
  loading,
  onClick,
}: {
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
  connected: boolean;
  partial: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`command-panel-connect-${label}`}
      className="cmdp-row"
      style={{
        textAlign: 'left',
        border: '1px solid var(--etched-border)',
        background: connected ? 'rgba(34,197,94,0.05)' : 'rgba(255,255,255,0.02)',
        padding: '9px 11px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          border: '1px solid var(--etched-border)',
          color: 'var(--ink-black)',
          flexShrink: 0,
        }}
      >
        <Icon size={13} />
      </span>
      <span
        className="serif"
        style={{
          fontSize: 14,
          color: 'var(--ink-black)',
          flex: '1 1 auto',
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      {loading ? (
        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', opacity: 0.4, flexShrink: 0 }} />
      ) : connected ? (
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
      ) : (
        <span
          className="mono cmdp-small"
          style={{
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            color: partial ? 'var(--amber, #d97706)' : 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          {partial ? 'Finish' : 'Connect'}
        </span>
      )}
    </button>
  );
}

/** A compact connected-app chip (logo square) for the Apps section's "Connected"
 *  row. Tapping opens the full picker to manage/add more. */
function ConnectedAppChip({ slug, onClick }: { slug: string; onClick: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${slug} — connected`}
      aria-label={`${slug} connected — manage apps`}
      data-testid={`connected-app:${slug}`}
      className="cmdp-icon-btn"
      style={{
        position: 'relative',
        width: 32,
        height: 32,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid rgba(22,163,74,0.4)',
        background: 'rgba(22,163,74,0.06)',
        cursor: 'pointer',
      }}
    >
      {failed ? (
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
          {slug.charAt(0).toUpperCase()}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://logos.composio.dev/api/${slug}`}
          alt={slug}
          width={16}
          height={16}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: 16, height: 16, objectFit: 'contain' }}
        />
      )}
    </button>
  );
}

// The handful of channels we surface as one-tap quick-connects in the rail. The
// full grid (all ~20) lives behind "View all" → the existing channels modal.
const QUICK_CONNECT_IDS = ['Telegram', 'Slack', 'Discord', 'GitHub'];

/**
 * Non-interactive teaser of what a Composio key unlocks, shown under the guided
 * key panel BEFORE a key is set — the payoff is visible without dead buttons. The
 * real connect surface (the full 1,400-app picker) appears once a key is stored.
 */
function AppPreviewStrip() {
  const PREVIEW_ICONS = [CalendarDays, InboxIcon, GitBranch, Hash, FileText, Layers];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: 0.72 }}>
      {PREVIEW_ICONS.map((Icon, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            border: '1px solid var(--etched-border)',
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          <Icon size={15} />
        </span>
      ))}
      <span className="mono cmdp-small" style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
        + 1,400 apps
      </span>
    </div>
  );
}

// A calm, never-alarming connection-status pill for the panel header (paioclaw
// shows "Active"/"Reconnecting"; we never red-alarm). idle/unreachable are normal
// states here, not errors — mirrors AgentActivityDigest's tone.
//
// There is no "Needs you" pill: approvals never reach the dashboard. The agent
// pushes `approval.request` down the workspace iframe's /api/ws socket and the
// iframe owns that UX; no HTTP surface exposes a pending approval, so this pill
// could never have shown it. See the note on InstanceActivityState.
function StatusPill({ state }: { state: InstanceActivityDigest['state'] | null }) {
  let label: string;
  let color: string;
  if (state === null) {
    label = 'Connecting';
    color = 'var(--text-muted)';
  } else if (state === 'responding') {
    label = 'Active';
    color = '#16a34a';
  } else if (state === 'not_running') {
    label = 'Asleep';
    color = '#71717a';
  } else {
    // idle | unreachable → calm "Ready", never an error tone.
    label = 'Ready';
    color = 'var(--ink-black)';
  }
  return (
    <span
      data-testid="command-panel-status-pill"
      className="mono cmdp-small"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        border: '1px solid var(--etched-border)',
        padding: '3px 8px',
        fontSize: 9,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

export function CommandPanel({
  instanceId,
  instanceName,
  instanceStatus,
  onRunWorkflow,
  onOpenChannels,
  onCollapse,
  variant = 'dock',
  consoleHref,
}: CommandPanelProps) {
  const agentName = instanceName?.trim() || 'Your agent';
  const isSheet = variant === 'sheet';

  // The Workflows section renders only when the parent supplied a working prompt
  // sender AND the run flag is on. The brief copy keys off the SAME condition so
  // it never promises a shelf that isn't there.
  const workflowsVisible = Boolean(onRunWorkflow) && isWorkflowsRunFlagOn();

  // Workflows now live PERMANENTLY in the panel as a managed list (create / run /
  // remove) — no more dismissible "of the week" banner. Shown whenever the run
  // flag is on AND a working sender is available.
  const workflowsSectionVisible = workflowsVisible && Boolean(onRunWorkflow);

  // "Send your first task" / "Run your first workflow" checklist step. When the
  // Workflows list is live, scroll to it; otherwise inject a starter prompt via
  // the same iframe sender, kicking off the first session.
  const workflowsSectionRef = useRef<HTMLDivElement | null>(null);
  // Optimistically mark the first-task step done the moment a task/workflow is
  // dispatched — so Getting-started retires live (the digest won't refetch to show
  // the new session) regardless of whether the agent finishes the run, and a
  // second tap can't re-inject.
  const [firstTaskSent, setFirstTaskSent] = useState(false);
  const handleSendFirstTask = useCallback(() => {
    if (workflowsSectionVisible) {
      workflowsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const sent = onRunWorkflow?.(
      'What can you do for me? Give me three concrete tasks I could hand you right now, then start on whichever is most useful.',
    );
    if (sent) setFirstTaskSent(true);
  }, [workflowsSectionVisible, onRunWorkflow]);

  // Running any workflow injects its prompt AND completes the first-task step, so
  // running a workflow retires Getting-started even if the agent's run doesn't
  // finish (Ash: "once you run it, whether it's completed or not, it just goes").
  const runWorkflow = useCallback(
    (prompt: string): boolean => {
      const sent = onRunWorkflow?.(prompt) ?? false;
      if (sent) setFirstTaskSent(true);
      return sent;
    },
    [onRunWorkflow],
  );

  // "Connect your first app" onboarding step → scroll to the Apps section (the
  // Composio key panel + connect tiles). Becomes "open the app picker" in Phase 1.
  const appsSectionRef = useRef<HTMLDivElement | null>(null);
  const handleConnectApp = useCallback(() => {
    appsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // ── Activity digest: one GET feeds both the Brief and Activity sections. ──
  const [digest, setDigest] = useState<InstanceActivityDigest | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [digestError, setDigestError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDigestLoading(true);
    setDigestError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/activity`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: InstanceActivityDigest }
          | null;
        if (!alive) return;
        if (!res.ok || !json?.success || !json.data) {
          setDigestError('Activity unavailable');
          setDigest(null);
        } else {
          setDigest(json.data);
        }
      } catch {
        if (alive) {
          setDigestError('Activity unavailable');
          setDigest(null);
        }
      } finally {
        if (alive) setDigestLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [instanceId, instanceStatus]);

  // ── Integration statuses for the compact quick-connect list. ──
  const [statuses, setStatuses] = useState<StatusMap | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/instances/${instanceId}/integrations`, { cache: 'no-store' });
        const j = (await r.json().catch(() => null)) as { data?: { statuses?: StatusMap } } | null;
        if (alive) setStatuses(j?.data?.statuses ?? {});
      } catch {
        if (alive) setStatuses({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [instanceId]);

  // ── Today's brief: prefer the agent-written brief (the latest run of the box's
  // seeded "Daily brief" job) over the static heuristic. Null until/unless the box
  // returns one, so the panel degrades gracefully to the heuristic copy. ──
  const [agentBrief, setAgentBrief] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/instances/${instanceId}/daily-brief`, { cache: 'no-store' });
        const j = (await r.json().catch(() => null)) as { data?: { text?: string | null } } | null;
        const text = j?.data?.text;
        if (alive && typeof text === 'string' && text.trim()) setAgentBrief(text.trim());
      } catch {
        /* keep the heuristic */
      }
    })();
    return () => {
      alive = false;
    };
  }, [instanceId]);

  const quickConnects = useMemo(
    () =>
      QUICK_CONNECT_IDS.map((id) => CHANNEL_SURFACE.find((c) => c.id === id)).filter(
        (c): c is NonNullable<typeof c> => Boolean(c),
      ),
    [],
  );

  const openChannels = useCallback(
    (channel?: string) => {
      onOpenChannels?.(channel);
    },
    [onOpenChannels],
  );

  // BYO-Composio Connect (feature-flagged). When on + a key is stored, the
  // Calendar / Inbox / Apps tiles launch the hosted Composio OAuth for an app
  // `composio.enabled` mirrors NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED. Connecting a
  // `composio.launch(slug)` opens the hosted Composio OAuth popup for an app
  // DIRECTLY (the server turns the slug into a login link via the Tool Router).
  const composio = useComposioConnect();
  const composioKey = useComposioKey();
  const connectedApps = useComposioConnectedApps();
  const composioReady = composio.enabled && composioKey.hasKey;

  const [connectError, setConnectError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const onConnect = useCallback(
    async (slug: string, label: string) => {
      setConnectError(null);
      const res = await composio.launch(slug);
      if (!res.ok) {
        setConnectError(res.message ? `${label}: ${res.message}` : `Couldn't connect ${label}.`);
      }
      // Re-check connected state shortly after (the OAuth finishes in the popup;
      // the focus listener catches the common case, this covers same-tab flows).
      setTimeout(() => connectedApps.refresh(), 2500);
    },
    [composio, connectedApps],
  );

  // Result of pushing the composio entry to the box (shown under the key panel).
  // Awaited (not fire-and-forget) so a failed write is visible, not swallowed.
  const [syncStatus, setSyncStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const pushComposioToBox = useCallback(() => {
    const guardKey = `hivra_connectors_synced:${instanceId}`;
    // Claim the guard synchronously so the composioReady effect doesn't also sync.
    try {
      sessionStorage.setItem(guardKey, '1');
    } catch {
      /* ignore */
    }
    setSyncStatus({ ok: true, msg: 'Connecting Composio to your agent…' });
    void (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/connectors-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
          cache: 'no-store',
        });
        const j = (await res.json().catch(() => null)) as
          | { data?: { applied?: boolean; reason?: string; restarted?: boolean }; error?: string }
          | null;
        if (res.ok && j?.data?.applied) {
          setSyncStatus({
            ok: true,
            msg: j.data.restarted
              ? 'Connected — your agent is reloading to pick up Composio.'
              : 'Connected to your agent.',
          });
        } else {
          try {
            sessionStorage.removeItem(guardKey);
          } catch {
            /* ignore */
          }
          const why = j?.error || j?.data?.reason || `sync failed (${res.status})`;
          setSyncStatus({
            ok: false,
            msg: `Key saved, but couldn't reach your agent to enable it: ${why}. It'll retry — or reload the page.`,
          });
        }
      } catch {
        try {
          sessionStorage.removeItem(guardKey);
        } catch {
          /* ignore */
        }
        setSyncStatus({ ok: false, msg: "Key saved, but couldn't reach your agent to enable it. It'll retry automatically." });
      }
    })();
  }, [instanceId]);

  // Ensure the box carries the single `composio` MCP entry once the user has a
  // key. Composio's Tool Router serves ALL connected apps dynamically, so this is
  // a one-time (idempotent) registration; a sessionStorage guard keeps it to one
  // write per box per session.
  useEffect(() => {
    if (!composioReady) return;
    const key = `hivra_connectors_synced:${instanceId}`;
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {
      /* sessionStorage unavailable — fall through and sync anyway */
    }
    void fetch(`/api/instances/${instanceId}/connectors-sync`, {
      method: 'POST',
      cache: 'no-store',
    })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as
          | { data?: { applied?: boolean; reason?: string }; error?: string }
          | null;
        if (res.ok && j?.data?.applied) {
          try {
            sessionStorage.setItem(key, '1');
          } catch {
            /* ignore */
          }
        } else {
          // Surface a persistent sync failure so a returning user whose box never
          // got the composio entry isn't left silently broken.
          const why = j?.error || j?.data?.reason || `sync failed (${res.status})`;
          setSyncStatus({
            ok: false,
            msg: `Composio isn't reaching your agent yet: ${why}. Re-save your key to retry.`,
          });
        }
      })
      .catch(() => {});
  }, [composioReady, instanceId]);

  const connectedChannelCount = useMemo(
    () => quickConnects.filter((m) => statuses?.[m.id]?.configured).length,
    [quickConnects, statuses],
  );

  // Chat channels: EXPANDED by default until the user connects one — messaging
  // the agent is the first onboarding move — then it auto-collapses to the "N
  // connected" row. An explicit user toggle wins and stays sticky per browser.
  const [channelsOpen, setChannelsOpen] = useState(false);
  const channelsPrefSetRef = useRef(false);
  useEffect(() => {
    // Adopt an explicit stored preference on mount, if the user ever set one.
    try {
      const stored = localStorage.getItem('hivra_cmdpanel_channels_open');
      if (stored === '1' || stored === '0') {
        channelsPrefSetRef.current = true;
        setChannelsOpen(stored === '1');
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    // No explicit preference → auto-expand while nothing is connected, collapse
    // once ≥1 is. Waits for the integration-status read to resolve first.
    if (channelsPrefSetRef.current) return;
    if (statuses === null) return;
    setChannelsOpen(connectedChannelCount === 0);
  }, [statuses, connectedChannelCount]);
  const toggleChannels = useCallback(() => {
    setChannelsOpen((prev) => {
      const next = !prev;
      channelsPrefSetRef.current = true; // user chose — stop auto-managing.
      try {
        localStorage.setItem('hivra_cmdpanel_channels_open', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const brief = agentBrief ?? briefText(digest, digestLoading, agentName, workflowsVisible);

  return (
    <div
      data-testid="instance-command-panel"
      data-cmdp=""
      data-sheet={isSheet ? '' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--bg-surface)',
        borderLeft: isSheet ? 'none' : '1px solid var(--etched-border)',
      }}
    >
      <style>{COMMAND_PANEL_TOUCH_CSS}</style>
      {/* Sticky header with the collapse control. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: isSheet ? '4px 4px 4px 14px' : '12px 14px',
          borderBottom: '1px solid var(--etched-border)',
          flexShrink: 0,
        }}
      >
        <Sparkles size={16} strokeWidth={2.25} style={{ color: 'var(--gold-leaf)', flexShrink: 0 }} />
        <span
          className="mono"
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: 'var(--ink-black)',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            flex: '1 1 auto',
            minWidth: 0,
          }}
        >
          Command panel
        </span>
        <StatusPill state={digestLoading ? null : digest?.state ?? 'idle'} />
        {isSheet ? (
          <>
            {consoleHref ? (
              <Link
                href={consoleHref}
                className="mono"
                data-testid="command-panel-console-link"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  minHeight: 44,
                  padding: '0 10px',
                  boxSizing: 'border-box',
                  border: '1px solid var(--etched-border)',
                  color: 'var(--ink-black)',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  textDecoration: 'none',
                }}
              >
                <ServerCog size={14} aria-hidden="true" /> Console
              </Link>
            ) : null}
            <button
              type="button"
              autoFocus
              onClick={onCollapse}
              aria-label="Close command panel"
              data-testid="command-panel-sheet-close"
              style={{
                width: 44,
                height: 44,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <X size={18} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide command panel"
            data-testid="command-panel-collapse"
            className="cmdp-icon-btn"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 4,
              display: 'inline-flex',
              flexShrink: 0,
            }}
          >
            <PanelRightClose size={16} />
          </button>
        )}
      </div>

      {/* Scrollable rail of sections. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 14px',
          display: 'grid',
          gap: 22,
          alignContent: 'start',
        }}
      >
        {/* 1 ── Getting started — the onboarding spine. A self-retiring checklist
            (agent awake → connect a channel → connect an app → send a task) that
            sits ABOVE everything and disappears for good once every step is done. */}
        <GettingStarted
          instanceId={instanceId}
          digest={digest}
          loading={digestLoading}
          integrationStatuses={statuses}
          appStepEnabled={composio.enabled}
          appConnected={connectedApps.apps.size > 0}
          taskSent={firstTaskSent}
          onConnectChannel={() => openChannels()}
          onConnectApp={handleConnectApp}
          onSendFirstTask={onRunWorkflow ? handleSendFirstTask : undefined}
          workflowsAvailable={workflowsSectionVisible}
        />

        {/* 2 ── Today's brief (text summary, derived from the activity digest).
            paioclaw leads with an audio brief; VoiceBrief adds a zero-cost,
            key-free Play + speed control (browser speechSynthesis) above the text. */}
        <Section title="Today's brief">
          <VoiceBrief text={brief} />
          <p
            style={{
              margin: 0,
              fontSize: 13.5,
              lineHeight: 1.6,
              color: 'var(--ink-black)',
              border: '1px solid var(--etched-border)',
              background: 'rgba(212, 175, 55, 0.06)',
              padding: '12px 13px',
            }}
          >
            {brief}
          </p>
        </Section>

        {/* 3 ── Chat channels — how you MESSAGE the agent (Telegram, Slack, …).
            Moved ABOVE Apps: talking to the agent is the first onboarding move.
            Expanded by default until ≥1 channel is connected, then auto-collapses
            to the "N connected" row. "View all" → the full channels modal. */}
        <section style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <button
            type="button"
            onClick={toggleChannels}
            aria-expanded={channelsOpen}
            className="mono cmdp-row cmdp-small"
            data-testid="command-panel-channels-toggle"
            style={{
              ...KICKER,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <ChevronDown
              size={13}
              style={{
                transition: 'transform 120ms ease',
                transform: channelsOpen ? 'none' : 'rotate(-90deg)',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: '1 1 auto' }}>Chat channels</span>
            <span style={{ opacity: 0.7 }}>
              {connectedChannelCount > 0 ? `${connectedChannelCount} connected` : 'Connect'}
            </span>
          </button>
          {channelsOpen ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {quickConnects.map((meta) => {
                const st = statuses?.[meta.id];
                return (
                  <QuickConnectRow
                    key={meta.id}
                    label={meta.label ?? meta.id}
                    Icon={meta.icon}
                    connected={Boolean(st?.configured)}
                    partial={Boolean(st?.partial)}
                    loading={statuses === null}
                    onClick={() => openChannels(meta.id)}
                  />
                );
              })}
              <button
                type="button"
                onClick={() => openChannels()}
                className="mono cmdp-row cmdp-small"
                data-testid="command-panel-connect-viewall"
                style={{
                  border: '1px solid var(--etched-border)',
                  background: 'transparent',
                  color: 'var(--ink-black)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  fontWeight: 800,
                  padding: '9px 11px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                }}
              >
                <Plug size={12} /> View all channels
              </button>
            </div>
          ) : null}
        </section>

        {/* 4 ── Apps (BYO-Composio) — the tools your agent USES. Step 1: paste your
            Composio key (guided). Step 2: tap an app and the agent connects it for
            you via the Tool Router. ComposioKeyPanel adapts: paste form → ✓ connected. */}
        {composio.enabled ? (
          <div ref={appsSectionRef}>
          <Section title="Apps">
            <ComposioKeyPanel composioKey={composioKey} onSaved={pushComposioToBox} />
            {syncStatus ? (
              <span
                style={{
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: syncStatus.ok ? 'var(--text-secondary)' : '#dc2626',
                }}
              >
                {syncStatus.msg}
              </span>
            ) : null}
            {composioKey.hasKey ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {connectError ? (
                  <span style={{ fontSize: 12, color: '#dc2626', lineHeight: 1.4 }}>{connectError}</span>
                ) : null}
                {connectedApps.apps.size > 0 ? (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <span className="mono cmdp-small" style={KICKER}>
                      Connected
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {[...connectedApps.apps].map((slug) => (
                        <ConnectedAppChip key={slug} slug={slug} onClick={() => setPickerOpen(true)} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Give {agentName} tools it can use — connect Gmail, Notion, Stripe, or any of 1,400+ apps.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  data-testid="command-panel-connect-apps"
                  className="mono cmdp-row cmdp-small"
                  style={{
                    border: '1px solid var(--ink-black)',
                    background: 'var(--ink-black)',
                    color: 'var(--bg-surface)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    fontWeight: 800,
                    padding: '9px 12px',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    justifySelf: 'start',
                  }}
                >
                  <Plus size={13} /> Connect apps
                </button>
                <a
                  href="https://dashboard.composio.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono cmdp-row cmdp-small"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    letterSpacing: '0.02em',
                    textDecoration: 'underline',
                    justifySelf: 'start',
                  }}
                >
                  Manage or remove connections in Composio ↗
                </a>
              </div>
            ) : (
              <AppPreviewStrip />
            )}
          </Section>
          </div>
        ) : null}

        {/* 5 ── Workflows — a managed, run-anytime list (create / run / remove).
            Gated on the run flag + a working sender. Running one also completes
            the Getting-started first-task step (see runWorkflow). */}
        {workflowsSectionVisible && onRunWorkflow ? (
          <div ref={workflowsSectionRef}>
            <Section title="Workflows">
              <WorkflowsPanel onRunWorkflow={runWorkflow} />
            </Section>
          </div>
        ) : null}

        {/* 6 ── Activity (live work + recent sessions). The onboarding checklist
            lives in its own top section now; Activity always shows live work. */}
        <Section title="Activity">
          <AgentActivityDigest digest={digest} loading={digestLoading} error={digestError} />
        </Section>
      </div>

      {/* Mount only while open so each open is a fresh fetch — a transient
          catalog-fetch failure can't trap the picker on an error screen for the
          rest of the session; closing + reopening retries cleanly. */}
      {pickerOpen ? (
        <ComposioAppPicker
          open
          onClose={() => setPickerOpen(false)}
          onConnect={(slug, label) => void onConnect(slug, label)}
          launching={composio.launching}
          connectedApps={connectedApps.apps}
        />
      ) : null}
    </div>
  );
}
