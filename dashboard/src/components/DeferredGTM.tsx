"use client";

import { GoogleAnalytics, GoogleTagManager } from "@next/third-parties/google";
import { useEffect, useState } from "react";
import {
  ANALYTICS_CONSENT_EVENT,
  hasAnalyticsConsent,
  type ConsentChoice,
} from "@/lib/consent/cookie-consent";

type GoogleTagWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  gtag?: (...args: unknown[]) => void;
} & Record<string, unknown>;

// Google Tag Manager and Google Analytics set analytics cookies, so they follow
// the same consent rule as PostHog: they load only once the visitor has a
// stored "accepted" choice (the banner stores one automatically in regions
// that do not require opt-in, and on Accept elsewhere). They still wait for the
// page to go idle so they never compete with first paint.
export function DeferredGTM({ gtmId, gaId }: { gtmId: string; gaId?: string }) {
  const [idle, setIdle] = useState(false);
  // Read the stored choice when state is created. Nothing renders until the
  // page is idle, so server and first client render match either way.
  const [consented, setConsented] = useState(() => typeof window !== "undefined" && hasAnalyticsConsent());

  useEffect(() => {
    const w = window as GoogleTagWindow;
    const cb = () => setIdle(true);
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(cb, { timeout: 3000 });
    } else {
      setTimeout(cb, 2000);
    }
  }, []);

  useEffect(() => {
    const onConsent = (event: Event) => {
      const choice = (event as CustomEvent<ConsentChoice>).detail;
      if (choice === "accepted") {
        const w = window as GoogleTagWindow;
        if (gaId) delete w[`ga-disable-${gaId}`];
        // Accepted again after a withdrawal in this page's life: GA's init
        // script does not run twice, so grant analytics storage explicitly or
        // GA stays in the denied state set below until a reload. Ad storage
        // stays denied; the site uses no ads.
        if (typeof w.gtag === "function") w.gtag("consent", "update", { analytics_storage: "granted" });
        setConsented(true);
        return;
      }
      // Withdrawn after the scripts loaded: they cannot be unloaded, so tell GA
      // to stop collecting and deny storage for the rest of the page's life.
      const w = window as GoogleTagWindow;
      if (gaId) w[`ga-disable-${gaId}`] = true;
      if (typeof w.gtag === "function") {
        w.gtag("consent", "update", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
        });
      }
      setConsented(false);
    };
    window.addEventListener(ANALYTICS_CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(ANALYTICS_CONSENT_EVENT, onConsent);
  }, [gaId]);

  if (!idle || !consented) return null;
  return (
    <>
      <GoogleTagManager gtmId={gtmId} />
      {gaId ? <GoogleAnalytics gaId={gaId} /> : null}
    </>
  );
}
