'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { readErrorMessage } from '@/lib/http/error-parsing';

interface OpsArchiveButtonProps {
  eventIds: string[];
}

export function OpsArchiveButton({ eventIds }: OpsArchiveButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const disabled = isPending || eventIds.length === 0;

  async function handleArchive() {
    if (disabled) return;

    const confirmed = window.confirm(
      `Archive ${eventIds.length} incident${eventIds.length === 1 ? '' : 's'} across the full matching feed?`
    );
    if (!confirmed) return;

    setError(null);

    const BATCH_SIZE = 5000;
    try {
      for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
        const batch = eventIds.slice(i, i + BATCH_SIZE);
        const response = await fetch('/api/ops/events', {
          method: 'PATCH',
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
      setError(err instanceof Error ? err.message : 'Archive failed. Refresh and try again.');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button
        type="button"
        onClick={handleArchive}
        disabled={disabled}
        className="action-button"
        style={{
          padding: '10px 20px',
          fontSize: 10,
          letterSpacing: '0.1em',
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {isPending ? 'Archiving…' : `Archive All (${eventIds.length})`}
      </button>
      {error && (
        <p style={{ margin: 0, fontSize: 12, color: '#b91c1c', maxWidth: 320 }}>
          {error}
        </p>
      )}
    </div>
  );
}
