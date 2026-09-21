'use client';

// A persistent "Cookie settings" affordance. Dispatching the shared event
// reopens the CookieConsentBanner's preferences panel even after a choice was
// stored, which is the standard way to let a visitor change consent later.

import { OPEN_COOKIE_PREFERENCES_EVENT } from './CookieConsentBanner';

export function CookiePreferencesButton({
  className,
  children = 'Manage cookie preferences',
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        try {
          window.dispatchEvent(new Event(OPEN_COOKIE_PREFERENCES_EVENT));
        } catch {
          // Best-effort: if dispatch fails the banner simply isn't reopened.
        }
      }}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'var(--ink-black)',
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      {children}
    </button>
  );
}
