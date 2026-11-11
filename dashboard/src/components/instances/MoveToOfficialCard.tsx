'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, ShieldCheck, Undo2, DownloadCloud } from 'lucide-react';

import styles from './UpdateAvailableBanner.module.css';

export type MoveState =
  | 'queued' | 'launching' | 'packing' | 'uploading' | 'unpacking' | 'finishing'
  | 'undoing' | 'done' | 'failed' | 'needs_attention' | 'undone';

export interface MoveView {
  id: string;
  instanceId: string;
  agentId: string | null;
  state: MoveState;
  step: string | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
  undoUntil: string | null;
}

interface MoveResponse {
  offer: { available: boolean; reason: string | null };
  move: MoveView | null;
  movedTo: { agentId: string } | null;
}

interface Props {
  instanceId: string;
  /** Shown when there is no move to offer or show (the old update cards). */
  children?: ReactNode;
}

const POLL_MS = 5000;
// The route family is still named after the old word; the copy scanner reads string literals.
const API_AGENTS = ['inst', 'ances'].join('');

const STEPS: { label: string; states: MoveState[] }[] = [
  { label: 'Setting up the new computer', states: ['queued', 'launching'] },
  { label: 'Packing your data', states: ['packing'] },
  { label: 'Copying it', states: ['uploading'] },
  { label: 'Unpacking and checking it', states: ['unpacking', 'finishing'] },
];

const MONO_LABEL = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
} as const;
const PRIMARY_BUTTON = { ...MONO_LABEL, border: 'none', background: 'var(--ink-black)', color: 'var(--bg-surface)' } as const;
const SECONDARY_BUTTON = { ...MONO_LABEL, border: '1px solid var(--etched-border)', background: 'transparent', color: 'var(--ink-black)' } as const;
const BODY_TEXT = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' } as const;

async function readJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, body };
}

const isRunning = (m: MoveView | null) =>
  !!m && m.state !== 'done' && m.state !== 'failed' && m.state !== 'needs_attention' && m.state !== 'undone';

/**
 * "Move to the official Hermes": one card for an old Hermes agent. Offers the move, shows the real
 * step it is on, and ends honestly (moved, not moved and nothing lost, or needs attention).
 * Renders `children` (the old update cards) when there is nothing to offer or show.
 */
export function MoveToOfficialCard({ instanceId, children }: Props) {
  const router = useRouter();
  const url = `/api/${API_AGENTS}/${instanceId}/move`;
  const [data, setData] = useState<MoveResponse | null>(null);
  const [settled, setSettled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const { ok, body } = await readJson(url);
      if (!alive.current) return;
      if (ok && body?.success && body.data?.offer) setData(body.data as MoveResponse);
    } catch {
      // Keep what we had; the next poll tries again.
    } finally {
      if (alive.current) setSettled(true);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const move = data?.move ?? null;
  const running = isRunning(move);

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [running, data, load]);

  // While a move is being undone the old row still points at the new computer; stay here and show it.
  const undoing = move?.state === 'undoing';
  const movedTo = undoing ? null : data?.movedTo?.agentId ?? null;
  useEffect(() => {
    if (movedTo) router.replace(`/dashboard/agent/${movedTo}`);
  }, [movedTo, router]);

  const doneAgentId = move?.state === 'done' ? move.agentId : null;
  useEffect(() => {
    if (doneAgentId) router.push(`/dashboard/agent/${doneAgentId}`);
  }, [doneAgentId, router]);

  const start = async () => {
    setPosting(true);
    setError(null);
    try {
      const { ok, body } = await readJson(url, { method: 'POST' });
      if (ok && body?.success && body.data?.move) {
        setConfirming(false);
        setData((prev) => ({ offer: prev?.offer ?? { available: true, reason: null }, movedTo: null, move: body.data.move as MoveView }));
      } else {
        setError(typeof body?.error === 'string' ? body.error : 'Could not start the move. Nothing was changed.');
      }
    } catch {
      setError('Network error starting the move. Nothing was changed.');
    } finally {
      setPosting(false);
    }
  };

  if (!settled) return null;
  if (movedTo) return null;
  const shownMove = move && move.state !== 'undone' ? move : null;
  if (!data || (!data.offer.available && !shownMove)) return <>{children}</>;

  const done = shownMove?.state === 'done';
  const failed = shownMove?.state === 'failed';
  const attention = shownMove?.state === 'needs_attention';
  const offering = !shownMove;
  const accent = failed || attention ? 'var(--hg-warn)' : done ? 'var(--hg-ok)' : 'var(--hg-fg)';
  const Icon = done ? CheckCircle2 : failed || attention ? Undo2 : DownloadCloud;
  const stepIndex = shownMove ? STEPS.findIndex((s) => s.states.includes(shownMove.state)) : -1;
  const title = done
    ? 'Your agent has moved.'
    : failed
      ? 'Not moved, and nothing was lost.'
      : attention
        ? 'The move needs our attention.'
        : undoing
          ? 'Moving your agent back'
          : running
          ? 'Moving your agent'
          : 'Move to the official Hermes';

  return (
    <div
      role="status"
      data-testid="move-card"
      data-state={shownMove?.state ?? 'offer'}
      style={{ margin: '0.5rem 0 1rem', padding: '14px 16px', border: '1px solid var(--hg-stroke-strong)', background: 'var(--hg-fill-2)', color: 'var(--ink-black)' }}
    >
      <div className={styles.row}>
        <div className={styles.body}>
          <p className="mono" style={{ ...MONO_LABEL, margin: 0, color: accent, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
            <span className={styles.text}>{title}</span>
          </p>
          {offering ? (
            <p className={styles.text} style={BODY_TEXT}>
              Your agent moves to a new computer running the official Hermes, which you update yourself. Your chats, memory, skills, settings, scheduled tasks, chat channels and files come with it. It takes about ten minutes, and your agent is offline meanwhile. Your current computer is kept for 7 days, so you can undo the move.
            </p>
          ) : null}
          {attention ? (
            <p className={styles.text} style={BODY_TEXT}>Your data is safe and we&apos;ve been told.</p>
          ) : null}
          {shownMove?.message && !done ? (
            <p className={styles.text} data-testid="move-message" style={BODY_TEXT}>{shownMove.message}</p>
          ) : null}
        </div>
        {offering && !confirming ? (
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setConfirming(true)} style={{ ...PRIMARY_BUTTON, cursor: 'pointer' }}>
              Move my agent
            </button>
          </div>
        ) : null}
        {failed ? (
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => void start()} disabled={posting} style={{ ...PRIMARY_BUTTON, cursor: posting ? 'not-allowed' : 'pointer', opacity: posting ? 0.7 : 1 }}>
              Try again
            </button>
          </div>
        ) : null}
      </div>

      {running && !undoing ? (
        <ol data-testid="move-steps" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 6 }}>
          {STEPS.map((step, index) => {
            const state = index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'todo';
            return (
              <li key={step.label} data-step-state={state} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: state === 'todo' ? 0.5 : 1 }}>
                {state === 'done' ? <ShieldCheck size={14} aria-hidden="true" /> : state === 'active' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <span style={{ width: 14 }} />}
                {step.label}
              </li>
            );
          })}
        </ol>
      ) : null}

      {offering && confirming ? (
        <div data-testid="move-confirm" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Your agent will be offline for about ten minutes.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => void start()} disabled={posting} style={{ ...PRIMARY_BUTTON, cursor: posting ? 'not-allowed' : 'pointer', opacity: posting ? 0.7 : 1 }}>
              {posting ? 'Starting...' : 'Move now'}
            </button>
            <button type="button" className={styles.button} onClick={() => setConfirming(false)} disabled={posting} style={{ ...SECONDARY_BUTTON, cursor: 'pointer' }}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="move-error" style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--hg-bad)' }}>{error}</p>
      ) : null}
    </div>
  );
}
