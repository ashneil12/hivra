'use client';

// GDPR/UK cookie-consent banner — standard layered/granular pattern.
//
// The load-bearing invariant lives in PostHogProvider: capturing is opted OUT
// at init unless a stored "accepted" choice is present, so nothing fires before
// consent. This component RESOLVES the undecided case and lets the visitor
// manage their choice:
//   - returning visitor with a stored choice -> never auto-shown (init already
//     honored it); they can reopen the panel via the OPEN_COOKIE_PREFERENCES
//     event ("Cookie settings" link).
//   - undecided + consent-required region (EU/EEA/UK, or unknown geo) -> show a
//     first-layer prompt with equally-weighted Accept all / Reject all plus a
//     "Manage preferences" panel; analytics stays OFF until the visitor chooses.
//   - undecided + non-required region -> analytics is permitted under opt-out,
//     so grant it and show a notice whose primary action is Accept; the opt-out
//     lives one layer deeper inside "Manage preferences" (stickier than a bare
//     full-opt-out button, which is the standard opt-out-region pattern).
//
// There is a single non-essential bucket — product analytics + session replay —
// because that is exactly what PostHog's one consent gate controls. "Strictly
// necessary" cookies (auth, the consent record itself) are always on and shown
// for transparency only. Mapping is therefore: analytics on => stored
// "accepted" (grant), analytics off => stored "rejected" (revoke).
//
// Geo is resolved server-side via /api/geo (Vercel edge header); the client
// never trusts a client-derived country.

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  grantAnalyticsConsent,
  revokeAnalyticsConsent,
} from '@/app/providers/PostHogProvider';
import {
  readStoredConsent,
  writeStoredConsent,
  type GeoConsentSignal,
} from '@/lib/consent/cookie-consent';

type BannerMode = 'hidden' | 'required' | 'notice';

// Dispatch this window event from anywhere (e.g. the "Cookie settings" link on
// the privacy page) to reopen the preferences panel, even after a choice was
// already stored. Standard practice requires a persistent way to change consent.
export const OPEN_COOKIE_PREFERENCES_EVENT = 'hivra:open-cookie-preferences';

export function CookieConsentBanner() {
  const [mode, setMode] = useState<BannerMode>('hidden');
  const [showPrefs, setShowPrefs] = useState(false);
  // The single non-essential category toggle (product analytics + session
  // replay). Strictly-necessary cookies are always on and not represented here.
  const [analyticsOn, setAnalyticsOn] = useState(false);

  useEffect(() => {
    // A stored choice was already applied by PostHogProvider at init; do not
    // re-prompt. The toggle is pre-filled from storage on demand by the reopen
    // handler below, so there is nothing to set here.
    if (readStoredConsent()) return;

    let cancelled = false;
    (async () => {
      // Fail safe: any failure to resolve geo is treated as consent-required.
      let consentRequired = true;
      try {
        const res = await fetch('/api/geo', { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as GeoConsentSignal;
          consentRequired = data.consentRequired !== false;
        }
      } catch {
        consentRequired = true;
      }
      if (cancelled) return;

      if (consentRequired) {
        // Stay opted out (init default) and ask. Toggle defaults OFF — the
        // visitor must affirmatively opt in.
        setAnalyticsOn(false);
        setMode('required');
      } else {
        // Non-required region: analytics is permitted under an opt-out model.
        // Turn it on and PERSIST the implied accept immediately so the notice is
        // shown ONCE and never nags again — the previous version only stored a
        // choice on an explicit button click, so a visitor who simply reloaded
        // without clicking saw it on every page load. The opt-out stays fully
        // reachable (Manage preferences here, and "Cookie settings" on the
        // privacy page) so this is informational, not a consent trap.
        grantAnalyticsConsent();
        writeStoredConsent('accepted');
        setAnalyticsOn(true);
        setMode('notice');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Re-entry: lets a "Cookie settings" control anywhere reopen the preferences
  // panel after a choice was stored. Pre-fills the toggle from the stored choice.
  useEffect(() => {
    const open = () => {
      const stored = readStoredConsent();
      setAnalyticsOn(stored ? stored.choice === 'accepted' : true);
      setShowPrefs(true);
      // If the banner had already self-hidden, bring it back as a notice so the
      // panel is visible; required-region semantics are preserved if still set.
      setMode((m) => (m === 'hidden' ? 'notice' : m));
    };
    window.addEventListener(OPEN_COOKIE_PREFERENCES_EVENT, open);
    return () => window.removeEventListener(OPEN_COOKIE_PREFERENCES_EVENT, open);
  }, []);

  if (mode === 'hidden') return null;

  // Persist + apply a decision, then close. analytics === false means the
  // visitor declined the one non-essential bucket.
  const persist = (analytics: boolean) => {
    if (analytics) {
      writeStoredConsent('accepted');
      grantAnalyticsConsent();
    } else {
      writeStoredConsent('rejected');
      revokeAnalyticsConsent();
    }
    setShowPrefs(false);
    setMode('hidden');
  };

  const acceptAll = () => persist(true);
  const rejectAll = () => persist(false);
  const savePreferences = () => persist(analyticsOn);

  const isRequired = mode === 'required';

  const secondaryButtonStyle: React.CSSProperties = {
    minHeight: 44,
    padding: '8px 14px',
    fontSize: 12,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--etched-border)',
    borderRadius: 0,
    whiteSpace: 'nowrap',
  };
  const primaryButtonStyle: React.CSSProperties = {
    minHeight: 44,
    padding: '8px 16px',
    fontSize: 12,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    borderRadius: 0,
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className="hivra-cookie-consent"
      style={{
        position: 'fixed',
        left: '1rem',
        right: '1rem',
        // --hivra-bottom-chrome is the phone bottom bar's height when it is shown.
        bottom: 'calc(var(--hivra-bottom-chrome, 0px) + 1rem + env(safe-area-inset-bottom, 0px))',
        zIndex: 1000,
        maxWidth: 720,
        maxHeight: 'calc(100dvh - var(--hivra-bottom-chrome, 0px) - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        margin: '0 auto',
        background: 'var(--overlay-bg)',
        border: '1px solid var(--etched-border)',
        backdropFilter: 'blur(12px)',
        borderRadius: 0,
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: '0.85rem',
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
        }}
      >
        {isRequired
          ? 'We use cookies for product analytics and session replay to understand how Hivra is used and to fix bugs. These stay off until you accept. '
          : 'We use cookies for product analytics and session replay to improve Hivra. You can change this any time. '}
        <Link
          href="/privacy"
          style={{ color: 'var(--ink-black)', textDecoration: 'underline' }}
        >
          Privacy Policy
        </Link>
        .
      </p>

      {showPrefs ? (
        <div
          style={{
            display: 'grid',
            gap: '0.6rem',
            borderTop: '1px solid var(--etched-border)',
            borderBottom: '1px solid var(--etched-border)',
            padding: '0.85rem 0',
          }}
        >
          <ConsentCategory
            title="Strictly necessary"
            description="Required for sign-in, security, and remembering this cookie choice. Always on."
            locked
          />
          <ConsentCategory
            title="Product analytics & session replay"
            description="Helps us understand usage and fix bugs. Replay masks inputs and is off on sensitive pages."
            checked={analyticsOn}
            onToggle={() => setAnalyticsOn((v) => !v)}
          />
        </div>
      ) : null}

      <div
        className="hivra-cookie-consent__actions"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          justifyContent: 'flex-end',
          alignItems: 'center',
        }}
      >
        <style>{`
          @media (max-width: 480px) {
            .hivra-cookie-consent__actions > button { flex: 1 1 auto; }
          }
        `}</style>
        {showPrefs ? (
          <>
            <button
              type="button"
              onClick={rejectAll}
              aria-label="Reject non-essential cookies"
              style={secondaryButtonStyle}
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={acceptAll}
              aria-label="Accept all cookies"
              style={secondaryButtonStyle}
            >
              Accept all
            </button>
            <button
              type="button"
              onClick={savePreferences}
              aria-label="Save cookie preferences"
              className="action-button"
              style={primaryButtonStyle}
            >
              Save preferences
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowPrefs(true)}
              aria-label="Manage cookie preferences"
              aria-expanded={false}
              style={secondaryButtonStyle}
            >
              Manage preferences
            </button>
            {isRequired ? (
              <button
                type="button"
                onClick={rejectAll}
                aria-label="Reject non-essential cookies"
                style={secondaryButtonStyle}
              >
                Reject all
              </button>
            ) : null}
            <button
              type="button"
              onClick={acceptAll}
              aria-label={isRequired ? 'Accept all cookies' : 'Accept cookies'}
              className="action-button"
              style={primaryButtonStyle}
            >
              {isRequired ? 'Accept all' : 'Accept'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// A single category row in the preferences panel. `locked` renders an
// always-on, non-interactive indicator; otherwise a toggle switch.
function ConsentCategory({
  title,
  description,
  checked,
  locked,
  onToggle,
}: {
  title: string;
  description: string;
  checked?: boolean;
  locked?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.85rem',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--ink-black)',
            marginBottom: 2,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: '0.75rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {description}
        </div>
      </div>

      {locked ? (
        <span
          aria-hidden="true"
          style={{
            flex: '0 0 auto',
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            border: '1px solid var(--etched-border)',
            borderRadius: 0,
            padding: '3px 8px',
            whiteSpace: 'nowrap',
          }}
        >
          Always on
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={`${title}: ${checked ? 'on' : 'off'}`}
          onClick={onToggle}
          style={{
            // 44x44 hit area around the 40x22 track.
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            minWidth: 44,
            minHeight: 44,
            margin: '-11px -2px',
            padding: 0,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'relative',
              width: 40,
              height: 22,
              borderRadius: 0,
              border: '1px solid var(--etched-border)',
              background: checked ? 'var(--ink-black)' : 'var(--bg-surface)',
              transition: 'background 0.15s ease',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: checked ? 20 : 2,
                width: 16,
                height: 16,
                borderRadius: 0,
                background: checked ? 'var(--bg-surface)' : 'var(--text-muted)',
                transition: 'left 0.15s ease',
              }}
            />
          </span>
        </button>
      )}
    </div>
  );
}
