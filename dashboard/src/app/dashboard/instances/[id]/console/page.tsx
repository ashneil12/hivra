'use client';

import { useEffect, useRef, useState, use, useCallback, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Terminal, Box, ShieldCheck, Loader2, RotateCcw, Wrench, Clock3, DownloadCloud, CalendarClock, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';


import ConfigurationTab from './tabs/ConfigurationTab';
import LogsTab from './tabs/LogsTab';
import BackupsTab from './tabs/BackupsTab';
import ResourcesTab from './tabs/ResourcesTab';
import { TasksPanel } from '@/components/scheduled-tasks/TasksPanel';
import { fetchPlan, type PlanInfo } from '@/lib/hivra/agent-api';
import { ConnectDesktopButton } from '@/components/instances/ConnectDesktopButton';
import { ConnectDesktopModal } from '@/components/instances/ConnectDesktopModal';
import { AutoUpdateModal } from '@/components/instances/AutoUpdateModal';
import { SafePortal } from '@/components/ui/SafePortal';
import {
  DEFAULT_AUTO_UPDATE_ENABLED,
  DEFAULT_AUTO_UPDATE_TIME,
  getAutoUpdateConfig,
  type AutoUpdateConfig,
} from '@/lib/instance-settings';
import type { InstanceFailureAlert, RecoveryAction } from '@/lib/failure-ownership';
import { clientLog } from '@/lib/client/logger';
import { normalizeSshWarmupMessage } from '@/lib/ssh-warmup';
import styles from './console.module.css';

// ------------- Main Layout ------------- //

function recoveryActionToConsoleAction(action: RecoveryAction): ConsoleAction | null {
  if (action === 'repair_runtime') return 'repair_runtime';
  if (action === 'restart_gateway') return 'restart_gateway';
  if (action === 'redeploy') return 'redeploy';
  if (action === 'open_console') return null;
  return null;
}

type ConsoleAction = 'redeploy' | 'update' | 'restart_gateway' | 'repair_runtime' | 'rebuild_runtime';

const ACTION_CONFIG: Record<
  ConsoleAction,
  {
    buttonLabel: string;
    confirmTitle: string;
    confirmDescription: string;
    expectation: string;
    successMessage: string;
    inProgressMessage: string;
    tone: 'primary' | 'warning' | 'neutral';
  }
> = {
  redeploy: {
    buttonLabel: 'REDEPLOY CONFIG',
    confirmTitle: 'Confirm Redeploy',
    confirmDescription:
      'This will redeploy the live agent stack using the latest saved configuration. It is the right action when runtime behavior looks stale or infrastructure-backed settings have changed.',
    expectation: 'Expect a short interruption while Docker Compose reapplies the agent services.',
    successMessage:
      'Redeploy requested. Hermes is rebuilding the live agent stack with your saved configuration.',
    inProgressMessage:
      'Redeploy is already in progress. Hermes is rebuilding the live agent stack with your saved configuration.',
    tone: 'primary',
  },
  update: {
    buttonLabel: 'UPDATE NOW',
    confirmTitle: 'Confirm Update',
    confirmDescription:
      'This safely pulls the latest runtime changes and recreates the live agent stack without removing mounted Docker volumes, so memories, sessions, profiles, and other persistent data stay attached.',
    expectation:
      'Expect a short interruption while Hermes refreshes the services and checks they come back healthy.',
    successMessage:
      'Update requested. Hermes is safely refreshing the live agent runtime now.',
    inProgressMessage:
      'Update is already in progress. Hermes is safely refreshing the live agent runtime now.',
    tone: 'primary',
  },
  restart_gateway: {
    buttonLabel: 'RESTART GATEWAY',
    confirmTitle: 'Confirm Gateway Restart',
    confirmDescription:
      'This restarts the live Hermes gateway process without redeploying configuration. Use it when the gateway looks stuck but your current runtime configuration is already correct.',
    expectation:
      'Expect a short interruption while Hermes restarts the live gateway and reconnects the dashboard.',
    successMessage:
      'Gateway restart requested. Hermes is restarting the live gateway now.',
    inProgressMessage:
      'Gateway restart is already in progress. Hermes is restarting the live gateway now.',
    tone: 'primary',
  },
  repair_runtime: {
    buttonLabel: 'REPAIR RUNTIME',
    confirmTitle: 'Confirm Runtime Repair',
    confirmDescription:
      'This stops the agent stack, repairs permissions, and recreates the agent stack. It preserves persistent volumes (memories, sessions, profiles) but resets the running containers.',
    expectation:
      'Expect a short interruption while Hermes repairs and restarts the agent runtime.',
    successMessage:
      'Runtime repair requested. Hermes is restoring the live agent runtime now.',
    inProgressMessage:
      'Runtime repair is already in progress. Hermes is restoring the live agent runtime now.',
    tone: 'warning',
  },
  rebuild_runtime: {
    buttonLabel: 'REBUILD RUNTIME',
    confirmTitle: 'Confirm Runtime Rebuild',
    confirmDescription:
      'This clears disposable runtime state like generated logs and rebuilds the agent stack from scratch. Persistent data (memories, sessions, profiles) is kept on the mounted volumes.',
    expectation:
      'Expect a longer interruption while Hermes tears down and rebuilds the runtime image.',
    successMessage:
      'Runtime rebuild requested. Hermes is rebuilding the live agent runtime now.',
    inProgressMessage:
      'Runtime rebuild is already in progress. Hermes is rebuilding the live agent runtime now.',
    tone: 'warning',
  },
};

const RECOVERABLE_ACTION_STATUSES = new Set(['provisioning', 'redeploying', 'updating', 'restarting']);

function hasRecoverableActionStatus(status: unknown): boolean {
  return typeof status === 'string' && RECOVERABLE_ACTION_STATUSES.has(status);
}

const CONSOLE_TABS = [
  { id: 'configuration', label: 'Settings', icon: Box },
  { id: 'resources', label: 'Resources', icon: Cpu },
  { id: 'tasks', label: 'Tasks', icon: CalendarClock },
  { id: 'backups', label: 'Backups', icon: ShieldCheck },
  { id: 'logs', label: 'Logs', icon: Terminal },
] as const;

const CONSOLE_TAB_IDS = CONSOLE_TABS.map((tab) => tab.id) as readonly string[];

// At phone width the seven ops buttons collapse into one Actions disclosure
// below the tabs, so the tabs stay on the first screen.
const PHONE_OPS_QUERY = '(max-width: 640px)';
// Below this the confirm buttons stack, primary action on top.
const STACKED_CONFIRM_QUERY = '(max-width: 480px)';

function useMediaMatch(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, read, () => false);
}

type OpsKey = 'redeploy' | 'auto_update' | 'restart_gateway' | 'update' | 'repair_runtime' | 'rebuild_runtime';

const OPS_BUTTON_BASE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 18px',
  fontSize: 11,
  fontWeight: 700,
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

// Deep-link target: /console?tab=tasks selects the Tasks tab on first paint.
// Validated against the known tab ids; anything else falls back to settings.
function resolveInitialTab(requested: string | null | undefined): string {
  return requested && CONSOLE_TAB_IDS.includes(requested) ? requested : 'configuration';
}

export default function AdvancedConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { id } = use(params);

  // Honor a ?tab= deep link (e.g. the main-page "Standing tasks" entry routes
  // to ?tab=tasks); fall back to Settings for any unknown value.
  const [activeTab, setActiveTab] = useState<string>(() =>
    resolveInitialTab(searchParams?.get('tab'))
  );
  // The user's real plan, so the Tasks tab can mirror the server gate (Free
  // keeps one standing task). Defaults to Free until /api/billing/usage answers.
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [pendingAction, setPendingAction] = useState<ConsoleAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [autoUpdateModalOpen, setAutoUpdateModalOpen] = useState(false);
  const [autoUpdateLoading, setAutoUpdateLoading] = useState(false);
  const [autoUpdateConfig, setAutoUpdateConfig] = useState<AutoUpdateConfig>({
    enabled: DEFAULT_AUTO_UPDATE_ENABLED,
    time: DEFAULT_AUTO_UPDATE_TIME,
  });
  const [hostIp, setHostIp] = useState<string | null>(null);
  const [failureAlert, setFailureAlert] = useState<InstanceFailureAlert | null>(null);
  const phoneOps = useMediaMatch(PHONE_OPS_QUERY);
  const stackedConfirm = useMediaMatch(STACKED_CONFIRM_QUERY);
  // Owned here, not by the trigger: the trigger moves between the ops row and
  // the phone Actions list, and rotating across 640px must not close the guide.
  const [desktopGuideOpen, setDesktopGuideOpen] = useState(false);
  const openDesktopGuide = useCallback(() => setDesktopGuideOpen(true), []);
  const closeDesktopGuide = useCallback(() => setDesktopGuideOpen(false), []);
  // A backdrop press closes the confirm modal only when it also started on the
  // backdrop, so a text selection dragged out of the card does not.
  const confirmBackdropPressRef = useRef(false);
  const tabStripRef = useRef<HTMLDivElement>(null);

  // Keep the selected tab visible in the horizontally scrolling strip.
  useEffect(() => {
    const strip = tabStripRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`);
    if (!strip || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft || right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo?.({ left: Math.max(0, left - 16), behavior: 'smooth' });
    }
  }, [activeTab]);

  const applySnapshotState = useCallback((snapshotData: unknown) => {
    if (!snapshotData || typeof snapshotData !== 'object') return;

    const snapshot = snapshotData as {
      config?: unknown;
      public_ipv4?: unknown;
      failureAlert?: unknown;
    };

    if (snapshot.config && typeof snapshot.config === 'object' && !Array.isArray(snapshot.config)) {
      setAutoUpdateConfig(getAutoUpdateConfig(snapshot.config as Record<string, unknown>));
    }

    setHostIp(
      typeof snapshot.public_ipv4 === 'string' && snapshot.public_ipv4.trim().length > 0
        ? snapshot.public_ipv4
        : null
    );

    setFailureAlert(
      snapshot.failureAlert && typeof snapshot.failureAlert === 'object'
        ? (snapshot.failureAlert as InstanceFailureAlert)
        : null
    );
  }, []);

  const fetchConsoleSnapshot = useCallback(async () => {
    const snapshotRes = await fetch(`/api/instances/${id}?no_sync=true`);
    // Non-JSON bodies (e.g. proxy/gateway error pages) reject res.json() —
    // Safari with a DOMException — so treat them as an unreadable snapshot.
    const snapshot = await snapshotRes.json().catch(() => null);

    if (snapshotRes.ok && snapshot?.success && snapshot.data) {
      applySnapshotState(snapshot.data);
    } else if (snapshotRes.ok && snapshot === null) {
      // A 200 with a non-JSON body means a proxy/CDN is answering in the API
      // route's place — keep that visible to ops; it reads as "healthy page,
      // missing failure banner" to the user otherwise.
      clientLog.warn('Console snapshot returned unreadable body', {
        source: 'instance-console',
        failureType: 'console_snapshot_unreadable_body',
        instanceId: id,
        status: snapshotRes.status,
      });
    }

    return { snapshotRes, snapshot };
  }, [applySnapshotState, id]);

  const recoverActionFromSnapshot = useCallback(async () => {
    try {
      const { snapshotRes, snapshot } = await fetchConsoleSnapshot();
      if (
        snapshotRes.ok &&
        snapshot?.success &&
        snapshot.data &&
        hasRecoverableActionStatus(snapshot.data.status)
      ) {
        const actionConfig = pendingAction ? ACTION_CONFIG[pendingAction] : ACTION_CONFIG.redeploy;
        setActionFeedback({
          tone: 'success',
          message: actionConfig.inProgressMessage,
        });
        setPendingAction(null);
        return true;
      }
    } catch {
      // Fall through to the visible error state below if the snapshot cannot be read either.
    }

    return false;
  }, [fetchConsoleSnapshot, pendingAction]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      // Best-effort: a failed initial snapshot (network drop — Safari's "Load
      // failed") leaves the defaults in place instead of throwing unhandled.
      // Transient failures (Safari cancels in-flight fetches on navigation/
      // backgrounding) get one quiet retry; only a repeat failure emits an
      // ops breadcrumb, so a persistently broken snapshot endpoint stays
      // visible without re-creating the unhandled-rejection noise this
      // guard exists to remove.
      void fetchConsoleSnapshot().catch(() => {
        if (cancelled) return;
        retryTimer = setTimeout(() => {
          void fetchConsoleSnapshot().catch((error) => {
            if (cancelled) return;
            clientLog.warn('Console snapshot fetch failed after retry', {
              source: 'instance-console',
              failureType: 'console_snapshot_fetch_failed',
              instanceId: id,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          });
        }, 5000);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [fetchConsoleSnapshot, id]);

  // Resolve the plan once so the Tasks tab knows whether the user is Free
  // (one standing task) or Pro (unlimited). Best-effort; fetchPlan falls back
  // to the Free plan on any error.
  useEffect(() => {
    let alive = true;
    void fetchPlan()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(() => {
        /* fetchPlan already defaults to Free on failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Mirror the agent lane's derivation: the auto-created free row is
  // subscribed:true at the API but its key is "free", so treat both as Free.
  const isFreePlan = !plan?.subscribed || plan.key === 'free';

  const handleAction = (action: ConsoleAction) => {
    setActionFeedback(null);
    setPendingAction(action);
  };

  const handleOpenAutoUpdate = useCallback(async () => {
    setAutoUpdateLoading(true);

    try {
      await fetchConsoleSnapshot();
    } catch {
      // If the snapshot cannot be read, fall back to the latest local/default view.
    } finally {
      setAutoUpdateLoading(false);
      setAutoUpdateModalOpen(true);
    }
  }, [fetchConsoleSnapshot]);

  const handleSaveAutoUpdate = useCallback(
    async (nextAutoUpdate: AutoUpdateConfig) => {
      const res = await fetch(`/api/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpdate: nextAutoUpdate }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(
          normalizeSshWarmupMessage(
            data.error,
            'Unable to save auto-update settings.'
          )
        );
      }

      const nextConfig = data.data?.instance?.config
        ? getAutoUpdateConfig(data.data.instance.config)
        : nextAutoUpdate;
      setAutoUpdateConfig(nextConfig);

      return {
        autoUpdateApplied: Boolean(data.data?.autoUpdateApplied),
        autoUpdateError: data.data?.autoUpdateError ?? null,
      };
    },
    [id]
  );

  const confirmAction = async () => {
    if (!pendingAction) return;
    const actionConfig = ACTION_CONFIG[pendingAction];
    setActionLoading(true);
    try {
      const res = await fetch(`/api/instances/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: pendingAction })
      });
      const data = await res.json();
      if (data.success) {
        setActionFeedback({
          tone: 'success',
          message: actionConfig.successMessage,
        });
        setPendingAction(null);
        if (pendingAction === 'restart_gateway') {
          router.push(`/dashboard/instances/${id}?surface=chat`);
        }
      } else {
        setActionFeedback({
          tone: 'error',
          message: `Action failed: ${normalizeSshWarmupMessage(
            data.error,
            "A server error occurred. Please try again."
          )}`,
        });
      }
    } catch {
      const recovered = await recoverActionFromSnapshot();
      if (recovered) return;

      setActionFeedback({
        tone: 'error',
        message: 'Network error executing command.',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const failureConsoleAction = failureAlert ? recoveryActionToConsoleAction(failureAlert.recoveryAction) : null;

  const opsButtons: Record<OpsKey, { label: string; icon: React.ReactNode; onClick: () => void; tone: React.CSSProperties; disabled?: boolean }> = {
    redeploy: {
      label: ACTION_CONFIG.redeploy.buttonLabel,
      icon: <RotateCcw size={14} />,
      onClick: () => handleAction('redeploy'),
      tone: { background: 'var(--ink-black)', color: 'var(--bg-surface)', border: 'none' },
    },
    auto_update: {
      label: 'Auto-Update',
      icon: autoUpdateLoading ? <Loader2 size={14} className="animate-spin" /> : <Clock3 size={14} />,
      onClick: () => void handleOpenAutoUpdate(),
      disabled: autoUpdateLoading,
      tone: {
        background: autoUpdateConfig.enabled ? 'rgba(22, 163, 74, 0.08)' : 'rgba(59, 130, 246, 0.08)',
        color: autoUpdateConfig.enabled ? '#166534' : '#1d4ed8',
        border: autoUpdateConfig.enabled ? '1px solid rgba(22, 163, 74, 0.24)' : '1px solid rgba(59, 130, 246, 0.24)',
        cursor: autoUpdateLoading ? 'not-allowed' : 'pointer',
        opacity: autoUpdateLoading ? 0.7 : 1,
      },
    },
    restart_gateway: {
      label: ACTION_CONFIG.restart_gateway.buttonLabel,
      icon: <RotateCcw size={14} />,
      onClick: () => handleAction('restart_gateway'),
      tone: { background: 'rgba(125, 106, 247, 0.08)', color: '#5b4bc4', border: '1px solid rgba(125, 106, 247, 0.24)' },
    },
    update: {
      label: ACTION_CONFIG.update.buttonLabel,
      icon: <DownloadCloud size={14} />,
      onClick: () => handleAction('update'),
      tone: { background: 'rgba(59, 130, 246, 0.08)', color: '#1d4ed8', border: '1px solid rgba(59, 130, 246, 0.24)' },
    },
    repair_runtime: {
      label: ACTION_CONFIG.repair_runtime.buttonLabel,
      icon: <Wrench size={14} />,
      onClick: () => handleAction('repair_runtime'),
      tone: { background: 'rgba(217, 119, 6, 0.08)', color: '#92400e', border: '1px solid rgba(217, 119, 6, 0.24)' },
    },
    rebuild_runtime: {
      label: ACTION_CONFIG.rebuild_runtime.buttonLabel,
      icon: <RotateCcw size={14} />,
      onClick: () => handleAction('rebuild_runtime'),
      tone: { background: 'transparent', color: 'var(--ink-black)', border: '1px solid var(--ink-black)' },
    },
  };

  const renderOpsButton = (key: OpsKey, stacked = false) => {
    const op = opsButtons[key];
    return (
      <button
        key={key}
        type="button"
        onClick={op.onClick}
        disabled={op.disabled}
        style={{ ...OPS_BUTTON_BASE, ...op.tone, ...(stacked ? { width: '100%', minHeight: 44 } : null) }}
      >
        {op.icon}
        {op.label}
      </button>
    );
  };

  // Stacked on phones the primary action leads, in DOM order as well as
  // visually, so reading and focus order match what is shown.
  const cancelButton = pendingAction ? (
    <button
      key="cancel"
      type="button"
      onClick={() => setPendingAction(null)}
      disabled={actionLoading}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'transparent',
        color: 'var(--ink-black)',
        padding: '10px 18px',
        fontSize: 11,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        cursor: actionLoading ? 'not-allowed' : 'pointer',
      }}
    >
      Cancel
    </button>
  ) : null;
  const confirmButton = pendingAction ? (
    <button
      key="confirm"
      type="button"
      onClick={confirmAction}
      disabled={actionLoading}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: 'none',
        background: 'var(--ink-black)',
        color: 'var(--bg-surface)',
        padding: '10px 18px',
        fontSize: 11,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        cursor: actionLoading ? 'not-allowed' : 'pointer',
      }}
    >
      {actionLoading ? <Loader2 size={14} className="animate-spin" /> : null}
      {actionLoading ? 'Sending...' : ACTION_CONFIG[pendingAction].confirmTitle}
    </button>
  ) : null;

  return (
    <div style={{ maxWidth: 1100, margin: '2rem auto 8rem', padding: '0 clamp(16px, 5vw, 32px)', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}>

      {/* Header */}
      <div className={styles.header}>
        <button
          type="button"
          onClick={() => router.push(`/dashboard/instances/${id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono), monospace', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 12px 10px 0', marginBottom: '1.125rem' }}
        >
          <ArrowLeft size={14} /> Back to chat
        </button>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '2rem', flexWrap: 'wrap' }}>
            <div>
              <h1 className="serif" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 400, lineHeight: 1, margin: 0, color: 'var(--ink-black)', wordBreak: 'break-word' }}>Console.</h1>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
                <p className="mono" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5, margin: 0, color: 'var(--ink-black)' }}>
                  Instance Settings & Operations
                </p>
                {hostIp && (
                  <p
                    className="mono"
                    style={{
                      margin: 0,
                      padding: '6px 10px',
                      fontSize: 11,
                      letterSpacing: '0.08em',
                      border: '1px solid var(--etched-border)',
                      background: 'rgba(0,0,0,0.03)',
                      color: 'var(--ink-black)',
                    }}
                  >
                    Host IP: {hostIp}
                  </p>
                )}
              </div>
            </div>

            {phoneOps ? null : (
              <div className={styles.opsRow} data-testid="console-ops-row">
                <ConnectDesktopButton instanceId={id} onOpen={openDesktopGuide} />
                {renderOpsButton('redeploy')}
                {renderOpsButton('auto_update')}
                {renderOpsButton('restart_gateway')}
                {renderOpsButton('update')}
                {renderOpsButton('repair_runtime')}
                {renderOpsButton('rebuild_runtime')}
              </div>
            )}
          </div>
        </div>
      </div>

      {actionFeedback && (
        <div
          style={{
            marginBottom: '1.5rem',
            padding: '12px 16px',
            border: `1px solid ${actionFeedback.tone === 'success' ? 'var(--ink-black)' : '#b91c1c'}`,
            background: actionFeedback.tone === 'success' ? 'var(--vellum-bg)' : '#fef2f2',
            color: actionFeedback.tone === 'success' ? 'var(--ink-black)' : '#991b1b',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 11,
            letterSpacing: '0.03em',
          }}
        >
          {actionFeedback.message}
        </div>
      )}

      {failureAlert && (
        <div
          data-testid="console-failure-alert"
          style={{
            marginBottom: '1.5rem',
            padding: '16px 18px',
            border: '1px solid rgba(185, 28, 28, 0.24)',
            background: 'rgba(254, 242, 242, 0.78)',
            color: 'var(--ink-black)',
            display: 'grid',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
              <p className="mono" style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b91c1c', fontWeight: 700 }}>
                Active failure ownership
              </p>
              <h2 className="serif" style={{ margin: 0, fontSize: '1.45rem', color: 'var(--ink-black)' }}>
                {failureAlert.title}
              </h2>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                {failureAlert.message}
              </p>
            </div>
            {failureConsoleAction && (
              <button
                type="button"
                onClick={() => handleAction(failureConsoleAction)}
                style={{
                  border: '1px solid rgba(185, 28, 28, 0.24)',
                  background: 'rgba(255,255,255,0.78)',
                  color: '#b91c1c',
                  padding: '8px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  whiteSpace: 'nowrap',
                }}
                className={styles.touchTarget}
              >
                {failureAlert.recoveryLabel}
              </button>
            )}
          </div>
          <div className={`mono ${styles.failureMeta}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>
            <span><strong style={{ color: 'var(--ink-black)' }}>Owner:</strong> {failureAlert.ownerLabel}</span>
            <span><strong style={{ color: 'var(--ink-black)' }}>Phase:</strong> {failureAlert.phaseLabel}</span>
            <span><strong style={{ color: 'var(--ink-black)' }}>Recovery:</strong> {failureAlert.recoveryLabel}</span>
            {failureAlert.failureType && <span><strong style={{ color: 'var(--ink-black)' }}>Type:</strong> {failureAlert.failureType}</span>}
            {failureAlert.requestId && <span><strong style={{ color: 'var(--ink-black)' }}>Request:</strong> {failureAlert.requestId}</span>}
          </div>
        </div>
      )}

      {/* Top Tab Bar */}
      <div ref={tabStripRef} className={styles.tabs}>
        {CONSOLE_TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              data-tab-id={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={styles.tab}
              style={{
                display: 'flex', alignItems: 'center',
                flexShrink: 0,
                background: isActive ? 'var(--ink-black)' : 'transparent',
                color: isActive ? 'var(--bg-surface)' : 'var(--text-secondary)',
                border: isActive ? '1px solid var(--ink-black)' : '1px solid transparent',
                fontFamily: 'var(--font-mono), monospace',
                fontWeight: isActive ? 700 : 400,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap'
              }}
            >
              <Icon size={12} /> {tab.label}
            </button>
          );
        })}
      </div>

      {phoneOps ? (
        <details className={styles.actions} data-testid="console-actions">
          <summary className={styles.actionsSummary}>Actions</summary>
          <div className={styles.actionsList}>
            {renderOpsButton('redeploy', true)}
            {renderOpsButton('update', true)}
            {renderOpsButton('restart_gateway', true)}
            {renderOpsButton('auto_update', true)}
            <ConnectDesktopButton instanceId={id} fullWidth onOpen={openDesktopGuide} />
            <p className={styles.actionsGroupLabel}>Recovery</p>
            {renderOpsButton('repair_runtime', true)}
            {renderOpsButton('rebuild_runtime', true)}
          </div>
        </details>
      ) : null}

      <div style={{ minHeight: 600 }}>
        {activeTab === 'configuration' && <ConfigurationTab instanceId={id} />}
        {activeTab === 'resources' && <ResourcesTab instanceId={id} />}
        {activeTab === 'tasks' && (
          <TasksPanel
            instanceId={id}
            isFreePlan={isFreePlan}
            currentPlan={plan?.key ?? null}
          />
        )}
        {activeTab === 'backups' && <BackupsTab instanceId={id} />}
        {activeTab === 'logs' && <LogsTab instanceId={id} />}
      </div>

      {desktopGuideOpen ? <ConnectDesktopModal instanceId={id} onClose={closeDesktopGuide} /> : null}

      <AutoUpdateModal
        open={autoUpdateModalOpen}
        onClose={() => setAutoUpdateModalOpen(false)}
        initialConfig={autoUpdateConfig}
        onSave={handleSaveAutoUpdate}
      />

      <SafePortal>
      <AnimatePresence>
        {pendingAction && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="console-action-confirm-title"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(7, 10, 20, 0.58)',
              display: 'flex',
              overflowY: 'auto',
              padding: 'max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))',
              zIndex: 1000,
            }}
            onPointerDown={(event) => {
              confirmBackdropPressRef.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
              const pressedBackdrop = confirmBackdropPressRef.current;
              confirmBackdropPressRef.current = false;
              if (pressedBackdrop && event.target === event.currentTarget && !actionLoading) setPendingAction(null);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              style={{
                width: 'min(100%, 520px)',
                maxHeight: 'calc(var(--workspace-viewport-height, 100dvh) - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                margin: 'auto',
                background: 'var(--vellum-bg)',
                border: '1px solid var(--ink-black)',
                padding: 'clamp(16px, 4.2vw, 24px)',
                boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <h2
                    id="console-action-confirm-title"
                    className="serif"
                    style={{ margin: 0, fontSize: 'clamp(1.5rem, 7vw, 2rem)', fontWeight: 400, color: 'var(--ink-black)' }}
                  >
                    {ACTION_CONFIG[pendingAction].confirmTitle}
                  </h2>
                  <p
                    style={{
                      margin: '0.75rem 0 0',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    {ACTION_CONFIG[pendingAction].confirmDescription}
                  </p>
                </div>

                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--text-muted)',
                    padding: '10px 12px',
                    border: '1px solid var(--etched-border)',
                    background: 'rgba(255,255,255,0.45)',
                  }}
                >
                  {ACTION_CONFIG[pendingAction].expectation}
                </div>

                <div className={styles.confirmActions}>
                  {stackedConfirm ? [confirmButton, cancelButton] : [cancelButton, confirmButton]}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </SafePortal>
    </div>
  );
}
