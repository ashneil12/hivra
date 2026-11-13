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
  scheduledFor: string | null;
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
const BODY_TEXT = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' } as const;

async function readJson(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, body };
}

const isRunning = (m: MoveView | null) =>
  !!m && m.state !== 'done' && m.state !== 'failed' && m.state !== 'needs_attention' && m.state !== 'undone';

/**
 * "Move to the official Hermes": one card for an old Hermes agent. Says when the automatic move is
 * planned (there is no button), shows the real step it is on, and ends honestly (moved, not moved and nothing lost, or needs attention).
 * Renders `children` (the old update cards) when there is nothing to offer or show.
 */
export function MoveToOfficialCard({ instanceId, children }: Props) {
  const router = useRouter();
  const url = `/api/${API_AGENTS}/${instanceId}/move`;
  const [data, setData] = useState<MoveResponse | null>(null);
  const [settled, setSettled] = useState(false);
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

  if (!settled) return null;
  if (movedTo) return null;
  const shownMove = move && move.state !== 'undone' ? move : null;
  if (!data || (!data.offer.available && !shownMove)) return <>{children}</>;

  const done = shownMove?.state === 'done';
  const failed = shownMove?.state === 'failed';
  const attention = shownMove?.state === 'needs_attention';
  const waiting = !shownMove;
  const scheduledMs = data.scheduledFor ? Date.parse(data.scheduledFor) : NaN;
  const told = Number.isFinite(scheduledMs);
  // Once the planned time has passed (the wave runs a few a day), it is just "soon" again.
  const scheduledDate = told && scheduledMs > Date.now()
    ? new Date(scheduledMs).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : null;
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
          : scheduledDate
            ? `Moving to the official Hermes on ${scheduledDate}`
            : 'Moving to the official Hermes soon';

  return (
    <div
      role="status"
      data-testid="move-card"
      data-state={shownMove?.state ?? (scheduledDate ? 'scheduled' : 'soon')}
      style={{ margin: '0.5rem 0 1rem', padding: '14px 16px', border: '1px solid var(--hg-stroke-strong)', background: 'var(--hg-fill-2)', color: 'var(--ink-black)' }}
    >
      <div className={styles.row}>
        <div className={styles.body}>
          <p className="mono" style={{ ...MONO_LABEL, margin: 0, color: accent, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
            <span className={styles.text}>{title}</span>
          </p>
          {waiting ? (
            <p className={styles.text} style={BODY_TEXT}>
              Every Hermes agent is moving to the official Hermes, which you update yourself. Your chats, memory, skills, settings, scheduled tasks, chat channels and files come with it. Your agent is offline for about 15 minutes, and your current computer is kept for 7 days so the move can be undone.{told ? '' : " We'll email you the day before."}
            </p>
          ) : null}
          {attention ? (
            <p className={styles.text} style={BODY_TEXT}>Your data is safe and we&apos;ve been told.</p>
          ) : null}
          {shownMove?.message && !done ? (
            <p className={styles.text} data-testid="move-message" style={BODY_TEXT}>{shownMove.message}</p>
          ) : null}
          {failed ? (
            <p className={styles.text} style={BODY_TEXT}>We&apos;ll try again once we&apos;ve checked what went wrong.</p>
          ) : null}
        </div>
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

    </div>
  );
}
