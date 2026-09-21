'use client';

import { useEffect, useRef, useState } from 'react';

import { copyTextToClipboard } from '@/lib/client/clipboard';

interface OpsCopyAllButtonProps {
  incidentCount: number;
  text: string;
}

export function OpsCopyAllButton({ incidentCount, text }: OpsCopyAllButtonProps) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  const disabled = incidentCount === 0 || text.trim().length === 0;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;

      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  async function handleCopy() {
    if (disabled) return;

    const didCopy = await copyTextToClipboard(text);
    if (!isMountedRef.current) return;

    if (!didCopy) {
      setCopied(false);
      setError('Copy failed. Try again.');
      return;
    }

    setError(null);
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1500);
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button
        type="button"
        onClick={handleCopy}
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
        {copied ? 'Copied' : 'Copy All'}
      </button>
      {error && (
        <p style={{ margin: 0, fontSize: 12, color: '#b91c1c' }}>
          {error}
        </p>
      )}
    </div>
  );
}
