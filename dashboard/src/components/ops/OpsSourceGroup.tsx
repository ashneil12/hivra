'use client';

import { useState, type ReactNode } from 'react';

interface OpsSourceGroupProps {
  source: string;
  incidentCount: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function OpsSourceGroup({ source, incidentCount, defaultOpen = false, children }: OpsSourceGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      style={{
        border: '1px solid var(--etched-border)',
        background: 'rgba(255,255,255,0.55)',
        padding: '1rem',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          width: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          marginBottom: open ? '1rem' : 0,
        }}
        aria-expanded={open}
      >
        <div style={{ minWidth: 0 }}>
          <p
            className="mono"
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Source Group
          </p>
          <h2
            className="serif"
            style={{
              fontSize: 'clamp(1.2rem, 5vw, 1.7rem)',
              margin: '0.35rem 0 0',
              color: 'var(--ink-black)',
              overflowWrap: 'anywhere',
            }}
          >
            {source}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <p
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            {incidentCount} incident{incidentCount === 1 ? '' : 's'} in current view
          </p>
          <span
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '6px 10px',
              border: '1px solid var(--etched-border)',
              background: 'var(--bg-surface)',
              color: 'var(--ink-black)',
            }}
          >
            {open ? 'Collapse' : 'Expand'}
          </span>
        </div>
      </button>

      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}
