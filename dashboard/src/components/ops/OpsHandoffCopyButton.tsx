'use client';

import { useEffect, useRef, useState } from 'react';

interface OpsHandoffCopyButtonProps {
  text: string;
}

export function OpsHandoffCopyButton({ text }: OpsHandoffCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const isMountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

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
    try {
      await navigator.clipboard.writeText(text);

      if (!isMountedRef.current) {
        return;
      }

      setCopied(true);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1500);
    } catch {
      if (!isMountedRef.current) {
        return;
      }

      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        border: '1px solid var(--etched-border)',
        background: copied ? 'var(--ink-black)' : 'var(--bg-surface)',
        color: copied ? 'var(--vellum-bg)' : 'var(--ink-black)',
        padding: '8px 12px',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      {copied ? 'Copied' : 'Copy For Agent'}
    </button>
  );
}
