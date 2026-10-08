'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, DownloadCloud, Loader2 } from 'lucide-react';

import { useReleaseStatus, type ReleaseStatus } from '@/lib/hermes-releases/use-release-status';
import { resourceInventory } from '@/lib/workspace/resource-inventory';
import { normalizeSshWarmupMessage } from '@/lib/ssh-warmup';
import styles from './UpdateAvailableBanner.module.css';

interface Props {
  instanceId: string;
  /** Page-owned update, e.g. the console's confirm modal. */
  onUpdate?: () => void;
  /** Disables the button and shows "Updating..." while the page runs the update. */
  busy?: boolean;
  /** Bump to re-read the status, e.g. after the page ran an action. */
  refreshKey?: number;
  /** Confirm inline and POST the update here instead of calling onUpdate. */
  selfConfirm?: boolean;
}

const DETAIL_MAX = 160;
// An update takes a few minutes and the box reports its new version when it is
// back; until then the notice says so instead of offering the same button again.
const REQUEST_WINDOW_MS = 15 * 60 * 1000;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX - 3).trimEnd()}...` : trimmed;
}

const MONO_LABEL = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} as const;

const PRIMARY_BUTTON = {
  ...MONO_LABEL,
  border: 'none',
  background: 'var(--ink-black)',
  color: 'var(--bg-surface)',
} as const;

const SECONDARY_BUTTON = {
  ...MONO_LABEL,
  border: '1px solid var(--etched-border)',
  background: 'transparent',
  color: 'var(--ink-black)',
} as const;

function describe(status: ReleaseStatus) {
  const health = status.updateHealth;
  const canUpdate = status.updateAvailable && Boolean(status.target);
  const rollback = status.direction === 'rollback';
  const version = status.target?.version ?? '';
  const buttonLabel = rollback ? `Move to ${version}` : 'Update';
  const current = status.currentVersion ?? 'an earlier version';
  const ready = canUpdate
    ? rollback
      ? `Hermes ${version} is the safer version. This agent runs ${current}.`
      : `Hermes ${version} is ready. This agent runs ${current}.`
    : null;

  if (health === 'paused') {
    return { kind: 'warning', title: 'Automatic updates are paused on this agent.', detail: status.updateHealthDetail, canUpdate, buttonLabel, ready };
  }
  if (health === 'rolled_back') {
    return { kind: 'warning', title: 'The last update did not stick and was rolled back.', detail: status.updateHealthDetail, canUpdate, buttonLabel, ready };
  }
  if (health === 'failed') {
    return { kind: 'warning', title: 'The last update failed.', detail: status.updateHealthDetail, canUpdate, buttonLabel, ready };
  }
  if (canUpdate) {
    return { kind: 'update', title: rollback ? 'A safer version is available' : 'Update available', detail: null, canUpdate, buttonLabel, ready };
  }
  return null;
}

export function UpdateAvailableBanner({ instanceId, onUpdate, busy = false, refreshKey = 0, selfConfirm = false }: Props) {
  const { status, loading, refresh } = useReleaseStatus(instanceId);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  // When an update was last requested from here, and the digest the box ran then.
  const [requested, setRequested] = useState<{ at: number; from: string | null } | null>(null);
  const digestRef = useRef<string | null>(null);
  digestRef.current = status?.currentDigest ?? null;

  // The first run is the mount fetch the hook already does. A bump means the
  // page just ran an update (or another action) successfully.
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    setRequested({ at: Date.now(), from: digestRef.current });
    void refresh();
  }, [refreshKey, refresh]);

  const runUpdate = async () => {
    setPosting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update' }),
      });
      resourceInventory.invalidate('hermes');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setConfirming(false);
        setResult({ tone: 'success', message: 'Update requested. Hermes is refreshing the agent now.' });
        setRequested({ at: Date.now(), from: digestRef.current });
        void refresh();
      } else {
        setResult({
          tone: 'error',
          message: `Update failed: ${normalizeSshWarmupMessage(data?.error, 'A server error occurred. Please try again.')}`,
        });
      }
    } catch {
      setResult({ tone: 'error', message: 'Network error starting the update.' });
    } finally {
      setPosting(false);
    }
  };

  if (loading) return null;

  const notice = status ? describe(status) : null;

  if (!notice) {
    if (result) {
      return <ResultLine result={result} />;
    }
    if (status?.currentVersion) {
      return (
        <p
          data-testid="hermes-version-label"
          className="mono"
          style={{ margin: '0.5rem 0 1rem', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}
        >
          Hermes {status.currentVersion}
        </p>
      );
    }
    return null;
  }

  const warning = notice.kind === 'warning';
  // Pending: asked recently and the box has not reported a different image yet.
  const pending =
    requested !== null &&
    Date.now() - requested.at < REQUEST_WINDOW_MS &&
    (status?.currentDigest ?? null) === requested.from;
  const working = busy || posting;
  const accent = warning ? '#92400e' : '#1d4ed8';
  const Icon = warning ? AlertTriangle : DownloadCloud;

  const onPrimary = () => {
    if (selfConfirm) setConfirming(true);
    else onUpdate?.();
  };

  return (
    <div
      role="status"
      data-testid="update-available-banner"
      data-kind={notice.kind}
      style={{
        margin: '0.5rem 0 1rem',
        padding: '14px 16px',
        border: `1px solid ${warning ? 'rgba(217, 119, 6, 0.32)' : 'rgba(59, 130, 246, 0.28)'}`,
        background: warning ? 'rgba(217, 119, 6, 0.08)' : 'rgba(59, 130, 246, 0.07)',
        color: 'var(--ink-black)',
      }}
    >
      <div className={styles.row}>
        <div className={styles.body}>
          <p className="mono" style={{ ...MONO_LABEL, margin: 0, color: accent, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} strokeWidth={2.25} style={{ flexShrink: 0 }} aria-hidden="true" />
            <span className={styles.text}>{notice.title}</span>
          </p>
          {notice.detail?.trim() ? (
            <p className={styles.text} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {truncate(notice.detail)}
            </p>
          ) : null}
          {pending ? (
            <p data-testid="update-pending" className={styles.text} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              Update requested. This notice clears when the agent is back on the new version.
            </p>
          ) : null}
          {notice.ready && !pending ? (
            <p className={styles.text} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {notice.ready}
            </p>
          ) : null}
        </div>
        {notice.canUpdate && !confirming && !pending ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              onClick={onPrimary}
              disabled={working}
              style={{ ...PRIMARY_BUTTON, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: working ? 'not-allowed' : 'pointer', opacity: working ? 0.7 : 1 }}
            >
              {working ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {working ? 'Updating...' : notice.buttonLabel}
            </button>
          </div>
        ) : null}
      </div>
      {selfConfirm && confirming ? (
        <div data-testid="update-confirm" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>This briefly restarts the agent.</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => void runUpdate()}
              disabled={posting}
              style={{ ...PRIMARY_BUTTON, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: posting ? 'not-allowed' : 'pointer', opacity: posting ? 0.7 : 1 }}
            >
              {posting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {posting ? 'Updating...' : 'Update now'}
            </button>
            <button
              type="button"
              className={styles.button}
              onClick={() => setConfirming(false)}
              disabled={posting}
              style={{ ...SECONDARY_BUTTON, cursor: posting ? 'not-allowed' : 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {result ? <ResultLine result={result} inline /> : null}
    </div>
  );
}

function ResultLine({ result, inline = false }: { result: { tone: 'success' | 'error'; message: string }; inline?: boolean }) {
  const error = result.tone === 'error';
  return (
    <p
      role={error ? 'alert' : 'status'}
      data-testid="update-result"
      style={{
        margin: inline ? '12px 0 0' : '0.5rem 0 1rem',
        padding: inline ? 0 : '12px 16px',
        border: inline ? 'none' : `1px solid ${error ? '#b91c1c' : 'var(--ink-black)'}`,
        background: inline ? 'transparent' : error ? '#fef2f2' : 'var(--vellum-bg)',
        color: error ? '#991b1b' : 'var(--ink-black)',
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 11,
        letterSpacing: '0.03em',
        overflowWrap: 'anywhere',
      }}
    >
      {result.message}
    </p>
  );
}
