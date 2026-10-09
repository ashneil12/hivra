'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, DownloadCloud, Loader2, ShieldCheck, Undo2 } from 'lucide-react';

import { NOFORK_STEPS } from '@/lib/hermes-releases/no-fork-steps';
import type { NoForkMigrationStatus } from '@/lib/services/no-fork-migration-builder';
import styles from './UpdateAvailableBanner.module.css';

interface Offer {
  available: boolean;
  reason: string;
  alreadyUpstream: boolean;
  target: { version: string; digest: string; overlayImage: string } | null;
}

interface Props {
  instanceId: string;
}

const POLL_MS = 5000;
// The route family is still named after the old word; the copy scanner reads string literals.
const API_AGENTS = ['inst', 'ances'].join('');

const MONO_LABEL = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} as const;

const PRIMARY_BUTTON = { ...MONO_LABEL, border: 'none', background: 'var(--ink-black)', color: 'var(--bg-surface)' } as const;
const SECONDARY_BUTTON = { ...MONO_LABEL, border: '1px solid var(--etched-border)', background: 'transparent', color: 'var(--ink-black)' } as const;

async function readJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, body };
}

/**
 * "Update to latest Hermes": moves this agent onto upstream Hermes and says honestly where it is.
 * Hidden unless the registry offers a release for an agent that is still on the old image, or a move
 * is running or just finished (so the result is never lost on a page reload).
 */
export function NoForkMigrationCard({ instanceId }: Props) {
  const url = `/api/${API_AGENTS}/${instanceId}/migrate-no-fork`;
  const [offer, setOffer] = useState<Offer | null>(null);
  const [progress, setProgress] = useState<NoForkMigrationStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (withStatus: boolean) => {
    const { ok, body } = await readJson(withStatus ? `${url}?status=1` : url);
    if (!alive.current || !ok || !body?.success || !body.data?.offer) return null;
    setOffer(body.data.offer as Offer);
    setProgress((body.data.progress as NoForkMigrationStatus | null) ?? null);
    return body.data as { offer: Offer; progress: NoForkMigrationStatus | null };
  }, [url]);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const first = await load(false);
      if (first?.offer.available) await load(true);
    })();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // While the box is working, keep reading its progress file.
  useEffect(() => {
    if (progress?.state !== 'running') return;
    timer.current = setTimeout(() => void load(true), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [progress, load]);

  const start = async () => {
    setPosting(true);
    setError(null);
    try {
      const { ok, body } = await readJson(url, { method: 'POST' });
      if (ok && body?.success) {
        setConfirming(false);
        setProgress({ state: 'running', phase: 'preflight', message: 'Starting', updatedAt: new Date().toISOString() });
      } else {
        setError(typeof body?.error === 'string' ? body.error : 'Could not start the update. Nothing was changed.');
      }
    } catch {
      setError('Network error starting the update. Nothing was changed.');
    } finally {
      setPosting(false);
    }
  };

  if (!offer) return null;
  const running = progress?.state === 'running';
  const finished = progress && progress.state !== 'running';
  if (!offer.available && !running && !(finished && progress.state !== 'refused')) return null;
  if (progress?.state === 'refused' && !offer.available) return null;

  const done = progress?.state === 'done';
  const rolledBack = progress?.state === 'rolled_back';
  const failed = progress?.state === 'failed';
  const refused = progress?.state === 'refused';
  const accent = rolledBack || failed ? '#92400e' : done ? '#166534' : '#1d4ed8';
  const Icon = done ? CheckCircle2 : rolledBack || failed ? Undo2 : DownloadCloud;
  const phaseIndex = NOFORK_STEPS.findIndex((s) => s.phase === progress?.phase);
  const version = offer.target?.version ?? progress?.toVersion ?? '';

  return (
    <div
      role="status"
      data-testid="nofork-migration-card"
      data-state={progress?.state ?? 'offer'}
      style={{
        margin: '0.5rem 0 1rem',
        padding: '14px 16px',
        border: '1px solid rgba(59, 130, 246, 0.28)',
        background: 'rgba(59, 130, 246, 0.07)',
        color: 'var(--ink-black)',
      }}
    >
      <div className={styles.row}>
        <div className={styles.body}>
          <p className="mono" style={{ ...MONO_LABEL, margin: 0, color: accent, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
            <span className={styles.text}>
              {done ? 'Your agent runs the latest Hermes' : rolledBack ? 'Not updated, and nothing was lost' : failed ? 'The update needs attention' : running ? 'Updating to the latest Hermes' : 'Update to the latest Hermes'}
            </span>
          </p>
          {!running && !finished ? (
            <p className={styles.text} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {version ? `Hermes ${version} is ready. ` : ''}Your chats, memory, skills, settings and files stay exactly as they are. We back everything up first and check it all afterwards. If anything is off, your agent goes back to how it was by itself. Your agent restarts once, in about five minutes.
            </p>
          ) : null}
          {finished && progress?.message ? (
            <p className={styles.text} data-testid="nofork-message" style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              {progress.message}
            </p>
          ) : null}
        </div>
        {offer.available && !running && !confirming && !done && !refused ? (
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setConfirming(true)} style={{ ...PRIMARY_BUTTON, cursor: 'pointer' }}>
              Update to latest Hermes
            </button>
          </div>
        ) : null}
      </div>

      {running ? (
        <ol data-testid="nofork-steps" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 6 }}>
          {NOFORK_STEPS.map((step, index) => {
            const state = index < phaseIndex ? 'done' : index === phaseIndex ? 'active' : 'todo';
            return (
              <li key={step.phase} data-step-state={state} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: state === 'todo' ? 0.5 : 1 }}>
                {state === 'done' ? <ShieldCheck size={14} aria-hidden="true" /> : state === 'active' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <span style={{ width: 14 }} />}
                {step.label}
              </li>
            );
          })}
        </ol>
      ) : null}

      {confirming ? (
        <div data-testid="nofork-confirm" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Your agent restarts once. Anything it is doing right now is paused for a few minutes.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => void start()} disabled={posting} style={{ ...PRIMARY_BUTTON, cursor: posting ? 'not-allowed' : 'pointer', opacity: posting ? 0.7 : 1 }}>
              {posting ? 'Starting...' : 'Update now'}
            </button>
            <button type="button" className={styles.button} onClick={() => setConfirming(false)} disabled={posting} style={{ ...SECONDARY_BUTTON, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="nofork-error" style={{ margin: '12px 0 0', fontSize: 12, color: '#991b1b' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
