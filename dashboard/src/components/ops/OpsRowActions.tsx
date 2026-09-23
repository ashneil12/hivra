'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { readErrorMessage } from '@/lib/http/error-parsing';

interface OpsRowActionsProps {
  eventId: string;
  title: string;
}

export function OpsRowActions({ eventId, title }: OpsRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = isPending || busy !== null;

  async function callApi(method: 'PATCH' | 'DELETE'): Promise<void> {
    const response = await fetch('/api/ops/events', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [eventId] }),
    });
    if (!response.ok) {
      const reason = await readErrorMessage(response);
      throw new Error(reason);
    }
  }

  async function handleArchive() {
    if (disabled) return;
    setError(null);
    setBusy('archive');
    try {
      await callApi('PATCH');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (disabled) return;
    const confirmed = window.confirm(`Permanently delete this incident?\n\n"${title}"\n\nThis cannot be undone.`);
    if (!confirmed) return;
    setError(null);
    setBusy('delete');
    try {
      await callApi('DELETE');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  const buttonStyle = {
    padding: '6px 10px',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    border: '1px solid var(--etched-border)',
    background: 'var(--bg-surface)',
    color: 'var(--ink-black)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={handleArchive}
          disabled={disabled}
          className="pointer-coarse:min-h-[44px]"
          style={buttonStyle}
        >
          {busy === 'archive' ? 'Archiving…' : 'Archive'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={disabled}
          className="pointer-coarse:min-h-[44px]"
          style={{
            ...buttonStyle,
            background: '#7f1d1d',
            color: 'var(--vellum-bg)',
            borderColor: '#7f1d1d',
          }}
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
      {error && (
        <p style={{ margin: 0, fontSize: 11, color: '#b91c1c', maxWidth: 260, textAlign: 'right' }}>
          {error}
        </p>
      )}
    </div>
  );
}
