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

import { SafePortal } from '@/components/ui/SafePortal';

// Cap rendered tiles so a 1,400-item catalog doesn't mount thousands of nodes;
// search + category narrow it. We tell the user when results are truncated.
const RENDER_CAP = 120;
const BATCH_CAP = 50; // slugs per connected-apps check (matches the server cap)
const OVERLAY_GUTTER = 'clamp(12px, 4vw, 48px)';
// Category pills grow to a full touch target on coarse pointers.
const PICKER_TOUCH_CSS = `@media (pointer: coarse) { .composio-category-pill { min-height: 44px !important; } }`;
const PICKER_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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

  // Remember what opened the picker and hand focus back to it on close.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  // Focus enters the dialog once the portal mounts: the search on a fine
  // pointer, the close button on touch so the soft keyboard stays down.
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (!node) return;
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    (coarse ? closeRef.current : searchRef.current)?.focus();
  }, []);

  // Esc closes and Tab stays inside; lock body scroll while open (restored on
  // close/unmount).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(PICKER_FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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
    <SafePortal>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect an app"
      data-testid="composio-app-picker"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        // The visible viewport, so results stay above the soft keyboard.
        height: 'var(--workspace-viewport-height, 100dvh)',
        // Above the narrow-viewport command panel sheet it can open from.
        zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        paddingTop: `max(${OVERLAY_GUTTER}, env(safe-area-inset-top, 0px))`,
        paddingRight: `max(${OVERLAY_GUTTER}, env(safe-area-inset-right, 0px))`,
        paddingBottom: `max(${OVERLAY_GUTTER}, env(safe-area-inset-bottom, 0px))`,
        paddingLeft: `max(${OVERLAY_GUTTER}, env(safe-area-inset-left, 0px))`,
      }}
    >
      <style>{PICKER_TOUCH_CSS}</style>
      <div
        ref={attachPanel}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: 'min(100%, var(--workspace-viewport-height, 100dvh))',
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
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="composio-app-picker-close"
              style={{ width: 44, height: 44, margin: '-10px -10px -10px 0', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
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
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 1,400+ apps — Gmail, Notion, Stripe…"
              aria-label="Search apps"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
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
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
    </SafePortal>
  );
}

function CategoryPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="mono composio-category-pill"
      style={{
        flexShrink: 0,
        border: active ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
        background: active ? 'var(--ink-black)' : 'transparent',
        color: active ? 'var(--bg-surface)' : 'var(--text-secondary)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontWeight: 700,
        minHeight: 36,
        padding: '0 10px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
