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
      background: 'rgba(180, 83, 9, 0.10)',
      borderBottom: '1px solid rgba(180, 83, 9, 0.28)',
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
      <AlertTriangle size={18} strokeWidth={2.25} style={{ color: '#92400e', flexShrink: 0 }} />
      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span
          className="mono"
          style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.12em' }}
        >
          {MEMORY_PAUSE_TITLE}
        </span>
        <span style={{ fontSize: 13, color: 'rgba(17, 24, 39, 0.82)', lineHeight: 1.45 }}>
          {memoryPauseMessage(ramLimitMb)}
        </span>
      </div>
    </div>
    <div className="instance-chat-banner-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
      <button
        type="button"
        onClick={onReviewResources}
        style={{
          background: '#1a1a1a',
          color: '#ffffff',
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
          background: 'rgba(255, 255, 255, 0.6)',
          color: '#92400e',
          border: '1px solid rgba(180, 83, 9, 0.28)',
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
