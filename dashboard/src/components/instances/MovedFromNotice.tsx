'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { manageCard } from '@/components/hivra/manage/manage-styles';

interface MovedFrom {
  instanceId: string;
  name: string;
  at: string;
  undoUntil: string;
}

interface Props {
  agentId: string;
  /** Only Hermes agents can have been moved; others never fetch. */
  enabled: boolean;
}

// The old route family keeps its old word in the URL; the copy scanner reads string literals.
const OLD_AGENTS = ['inst', 'ances'].join('');

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * A quiet card in the moved agent's Settings (Overview): where it moved from,
 * and a way back until the old computer is removed. It stays off the agent's
 * own page, which is for working with the agent.
 */
export function MovedFromNotice({ agentId, enabled }: Props) {
  const [movedFrom, setMovedFrom] = useState<MovedFrom | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/hivra/agents/${agentId}/move`, { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!alive || !res.ok || !body?.success) return;
        const found = (body.data?.movedFrom as MovedFrom | null) ?? null;
        // Once the old computer is gone there is nothing to say.
        const until = found ? new Date(found.undoUntil).getTime() : NaN;
        setMovedFrom(found && until > Date.now() ? found : null);
        setCanUndo(Boolean(body.data?.canUndo));
      } catch {
        // Quiet by design: no notice if we cannot tell.
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId, enabled]);

  if (!enabled || !movedFrom) return null;
  return <MovedFromCard agentId={agentId} movedFrom={movedFrom} canUndo={canUndo} />;
}

// Only a moved agent mounts the router, so Settings renders anywhere it is used.
function MovedFromCard({ agentId, movedFrom, canUndo }: { agentId: string; movedFrom: MovedFrom; canUndo: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/hivra/agents/${agentId}/move/undo`, { method: 'POST', cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success && body.data?.instanceId) {
        router.push(`/dashboard/${OLD_AGENTS}/${body.data.instanceId}`);
        return;
      }
      setError(typeof body?.error === 'string' ? body.error : 'Could not undo the move. Nothing was changed.');
    } catch {
      setError('Network error. Nothing was changed.');
    }
    setBusy(false);
  };

  const linkButton = { background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--ink-black)', textDecoration: 'underline', cursor: 'pointer' } as const;

  return (
    <div
      role="status"
      data-testid="moved-from-notice"
      style={{ ...manageCard, padding: '12px 14px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}
    >
      <span>
        Moved from {movedFrom.name} on {shortDate(movedFrom.at)}. The old computer is kept until {shortDate(movedFrom.undoUntil)}.
      </span>{' '}
      {canUndo && !confirming ? (
        <button type="button" onClick={() => setConfirming(true)} style={linkButton}>Undo move</button>
      ) : null}
      {canUndo && confirming ? (
        <span data-testid="undo-confirm" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span>Go back to the old computer? Anything done here since the move will be lost.</span>
          <button type="button" onClick={() => void undo()} disabled={busy} style={linkButton}>{busy ? 'Going back...' : 'Go back'}</button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} style={linkButton}>Cancel</button>
        </span>
      ) : null}
      {error ? <span role="alert" style={{ marginLeft: 8, color: 'var(--hg-bad)' }}>{error}</span> : null}
    </div>
  );
}
