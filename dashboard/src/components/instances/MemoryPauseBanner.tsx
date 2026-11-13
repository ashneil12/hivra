'use client';

import { AlertTriangle } from "lucide-react";
import { MEMORY_PAUSE_TITLE, memoryPauseMessage } from "@/lib/memory-pause-message";

interface Props {
  status: string;
  pausedReason?: string | null;
  ramLimitMb?: number | null;
  actionLoading: boolean;
  onReviewResources: () => void;
  onRestart: () => void;
}

export function MemoryPauseBanner({ status, pausedReason, ramLimitMb, actionLoading, onReviewResources, onRestart }: Props) {
  if (status !== "stopped" || pausedReason !== "ram_cap_hit") return null;
  return (
  <div
    data-testid="instance-ram-cap-banner"
    className="instance-chat-banner"
    style={{
      background: 'color-mix(in srgb, var(--hg-warn) 10%, transparent)',
      borderBottom: '1px solid color-mix(in srgb, var(--hg-warn) 28%, transparent)',
      padding: '14px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap',
      zIndex: 49,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 460px' }}>
      <AlertTriangle size={18} strokeWidth={2.25} style={{ color: 'var(--hg-warn)', flexShrink: 0 }} />
      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span
          className="mono"
          style={{ fontSize: 11, fontWeight: 700, color: 'var(--hg-warn)', textTransform: 'uppercase', letterSpacing: '0.12em' }}
        >
          {MEMORY_PAUSE_TITLE}
        </span>
        <span style={{ fontSize: 13, color: 'var(--hg-text-2)', lineHeight: 1.45 }}>
          {memoryPauseMessage(ramLimitMb)}
        </span>
      </div>
    </div>
    <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
      <button
        type="button"
        onClick={onReviewResources}
        style={{
          background: 'var(--hg-accent)',
          color: 'var(--hg-on-accent)',
          border: 'none',
          padding: '8px 14px',
          fontSize: 11,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        Review resources
      </button>
      <button
        type="button"
        onClick={onRestart}
        disabled={actionLoading}
        style={{
          background: 'var(--hg-glass-strong)',
          color: 'var(--hg-warn)',
          border: '1px solid color-mix(in srgb, var(--hg-warn) 28%, transparent)',
          padding: '8px 14px',
          fontSize: 11,
          fontWeight: 700,
          cursor: actionLoading ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          opacity: actionLoading ? 0.7 : 1,
        }}
      >
        {actionLoading ? 'Restarting…' : 'Restart anyway'}
      </button>
    </div>
  </div>
  );
}
