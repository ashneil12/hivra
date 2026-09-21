'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { readErrorMessage } from '@/lib/http/error-parsing';

interface OpsDeleteAllButtonProps {
  eventIds: string[];
}

export function OpsDeleteAllButton({ eventIds }: OpsDeleteAllButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const disabled = isPending || eventIds.length === 0;

  async function handleDelete() {
    if (disabled) return;

    const confirmed = window.confirm(
      `Permanently DELETE ${eventIds.length} incident${eventIds.length === 1 ? '' : 's'} from the database? This cannot be undone.`
    );
    if (!confirmed) return;

    setError(null);

    const BATCH_SIZE = 5000;
    try {
      for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
        const batch = eventIds.slice(i, i + BATCH_SIZE);
        const response = await fetch('/api/ops/events', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: batch }),
        });

        if (!response.ok) {
          const reason = await readErrorMessage(response);
          throw new Error(reason);
        }
      }

      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed. Refresh and try again.');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button
        type="button"
        onClick={handleDelete}
        disabled={disabled}
        className="action-button"
        style={{
          padding: '10px 20px',
          fontSize: 10,
          letterSpacing: '0.1em',
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: '#7f1d1d',
          color: 'var(--vellum-bg)',
          borderColor: '#7f1d1d',
        }}
      >
        {isPending ? 'Deleting…' : `Delete All (${eventIds.length})`}
      </button>
      {error && (
        <p style={{ margin: 0, fontSize: 12, color: '#b91c1c', maxWidth: 320 }}>
          {error}
        </p>
      )}
    </div>
  );
}
