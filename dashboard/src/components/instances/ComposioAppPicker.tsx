'use client';

// ComposioAppPicker — a full-catalog app browser modal.
//
// Opened from the ONE "Connect apps" button in the command panel's Apps section.
// Loads Composio's whole public catalog (1,400+ toolkits) via /api/account/
// composio/catalog, filters client-side (instant search + category pills), floats
// already-connected apps to the top, and connects an app with a single tap
// (hosted Composio OAuth, same launch flow as before). Connected badges for the
// visible page come from a batched connected-apps check (the catalog spans far
// beyond the surfaced set the sidebar tracks).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';

// Cap rendered tiles so a 1,400-item catalog doesn't mount thousands of nodes;
// search + category narrow it. We tell the user when results are truncated.
const RENDER_CAP = 120;
const BATCH_CAP = 50; // slugs per connected-apps check (matches the server cap)

interface CatalogApp {
  slug: string;
  name: string;
  logo: string;
  category: string;
  toolCount: number;
}

interface Catalog {
  apps: CatalogApp[];
  categories: string[];
}

/** App logo with a graceful initial-letter fallback when the SVG 404s. */
function AppLogo({ app }: { app: CatalogApp }) {
  const [failed, setFailed] = useState(false);
  if (failed || !app.logo) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--etched-border)',
          background: 'rgba(255,255,255,0.03)',
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--text-muted)',
        }}
      >
        {app.name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={app.logo}
      alt=""
      width={26}
      height={26}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: 26, height: 26, flexShrink: 0, objectFit: 'contain' }}
    />
  );
}

export interface ComposioAppPickerProps {
  open: boolean;
  onClose: () => void;
  /** Launch the hosted Composio OAuth for a toolkit. */
  onConnect: (slug: string, label: string) => void;
  /** Slug currently launching (per-tile spinner), or null. */
  launching: string | null;
  /** Slugs the user already has connected (seed for badges + the "Connected" group). */
  connectedApps: Set<string>;
}

export function ComposioAppPicker({
  open,
  onClose,
  onConnect,
  launching,
  connectedApps,
}: ComposioAppPickerProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // Connected slugs confirmed by the batch checks. Unioned with the parent's set
  // (which already tracks the surfaced apps) at read time — kept separate so we
  // never write state synchronously from an effect.
  const [batchConnected, setBatchConnected] = useState<Set<string>>(() => new Set());
  const startedRef = useRef(false);

  const loading = open && !catalog && !error;
  const isConnectedSlug = useCallback(
    (slug: string) => connectedApps.has(slug) || batchConnected.has(slug),
    [connectedApps, batchConnected],
  );

  // Load the catalog once, the first time the modal opens. setState only ever
  // runs inside the async .then/.catch, never synchronously in the effect body.
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    fetch('/api/account/composio/catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        const data = j?.data as Catalog | undefined;
        if (data && Array.isArray(data.apps)) setCatalog(data);
        else setError('Could not load the app catalog.');
      })
      .catch(() => setError('Could not load the app catalog.'));
  }, [open]);

  // Esc closes; lock body scroll while open (restored on close/unmount).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    let list = catalog.apps;
    if (activeCategory) list = list.filter((a) => a.category === activeCategory);
    if (q) list = list.filter((a) => a.slug.includes(q) || a.name.toLowerCase().includes(q));
    // Float connected apps to the top (order otherwise preserved: popularity → A–Z).
    const conn: CatalogApp[] = [];
    const rest: CatalogApp[] = [];
    for (const a of list) (isConnectedSlug(a.slug) ? conn : rest).push(a);
    return [...conn, ...rest];
  }, [catalog, query, activeCategory, isConnectedSlug]);

  const shown = filtered.slice(0, RENDER_CAP);

  // Batch-check the visible page's connected state (covers non-surfaced apps),
  // debounced so typing doesn't spam the endpoint.
  const shownSlugsKey = shown.map((a) => a.slug).join(',');
  const checkConnected = useCallback((slugs: string[]) => {
    if (!slugs.length) return;
    fetch('/api/account/composio/connected-apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: slugs.slice(0, BATCH_CAP) }),
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j) => {
        const active = j?.data?.apps;
        if (!Array.isArray(active) || !active.length) return;
        setBatchConnected((prev) => {
          const next = new Set(prev);
          for (const s of active) if (typeof s === 'string') next.add(s.toLowerCase());
          return next;
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || !shownSlugsKey) return;
    const slugs = shownSlugsKey.split(',');
    const t = setTimeout(() => checkConnected(slugs), 350);
    return () => clearTimeout(t);
  }, [open, shownSlugsKey, checkConnected]);

  // Re-check the visible page when the user returns from the OAuth popup.
  useEffect(() => {
    if (!open) return;
    const onFocus = () => checkConnected(shownSlugsKey ? shownSlugsKey.split(',') : []);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, shownSlugsKey, checkConnected]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect an app"
      data-testid="composio-app-picker"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(12px, 4vw, 48px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          border: '1px solid var(--etched-border)',
          background: 'var(--bg-surface)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header + search */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--etched-border)', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <strong style={{ fontSize: 15, flex: '1 1 auto', minWidth: 0 }}>Connect an app</strong>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="composio-app-picker-close"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex' }}
            >
              <X size={17} />
            </button>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--etched-border)',
              background: 'rgba(255,255,255,0.02)',
              padding: '8px 10px',
            }}
          >
            <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 1,400+ apps — Gmail, Notion, Stripe…"
              autoComplete="off"
              data-testid="composio-app-picker-search"
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--ink-black)',
                fontSize: 13.5,
                outline: 'none',
              }}
            />
          </div>
          {/* Category pills */}
          {catalog && catalog.categories.length ? (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              <CategoryPill label="All" active={activeCategory === null} onClick={() => setActiveCategory(null)} />
              {catalog.categories.map((c) => (
                <CategoryPill key={c} label={c} active={activeCategory === c} onClick={() => setActiveCategory(c)} />
              ))}
            </div>
          ) : null}
        </div>

        {/* Body */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 18px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>
              <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Loading the app catalog…
            </div>
          ) : error ? (
            <div style={{ fontSize: 13, color: '#dc2626', padding: '24px 0' }}>{error}</div>
          ) : shown.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '24px 0' }}>
              No apps match “{query}”.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {shown.map((app) => {
                const isConnected = isConnectedSlug(app.slug);
                const isLaunching = launching === app.slug;
                return (
                  <button
                    key={app.slug}
                    type="button"
                    onClick={() => onConnect(app.slug, app.name)}
                    disabled={isLaunching}
                    data-testid={`composio-app-tile:${app.slug}`}
                    data-connected={isConnected}
                    title={isConnected ? `${app.name} connected — tap to add another account` : `Connect ${app.name}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      textAlign: 'left',
                      padding: '10px 11px',
                      minWidth: 0,
                      cursor: isLaunching ? 'default' : 'pointer',
                      border: isConnected ? '1px solid rgba(22,163,74,0.4)' : '1px solid var(--etched-border)',
                      background: isConnected ? 'rgba(22,163,74,0.06)' : 'rgba(255,255,255,0.02)',
                      opacity: isLaunching ? 0.6 : 1,
                    }}
                  >
                    <AppLogo app={app} />
                    <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 auto' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-black)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {app.name}
                      </span>
                      <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {app.category}
                        {app.toolCount ? ` · ${app.toolCount} tools` : ''}
                      </span>
                    </span>
                    {isLaunching ? (
                      <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    ) : isConnected ? (
                      <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>
                        <Check size={11} /> On
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
          {!loading && !error && filtered.length > shown.length ? (
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '12px 2px 2px', letterSpacing: '0.03em' }}>
              Showing {shown.length} of {filtered.length} — search to narrow.
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--etched-border)' }}>
          <a
            href="https://dashboard.composio.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 10.5, color: 'var(--text-muted)', letterSpacing: '0.02em', textDecoration: 'underline' }}
          >
            Manage or remove connections in Composio ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function CategoryPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        flexShrink: 0,
        border: active ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
        background: active ? 'var(--ink-black)' : 'transparent',
        color: active ? 'var(--bg-surface)' : 'var(--text-secondary)',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontWeight: 700,
        padding: '5px 9px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
