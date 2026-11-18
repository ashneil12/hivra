"use client";

import { GoogleAnalytics, GoogleTagManager } from "@next/third-parties/google";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isPrivateAnalyticsPath } from "@/lib/telemetry/analytics-private-routes";
import {
  ANALYTICS_CONSENT_EVENT,
  hasAnalyticsConsent,
  type ConsentChoice,
} from "@/lib/consent/cookie-consent";

type GoogleTagWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  gtag?: (...args: unknown[]) => void;
} & Record<string, unknown>;

// Google Tag Manager and Google Analytics set analytics cookies, so they follow
// the same consent rule as PostHog: they load only once the visitor has a
// stored "accepted" choice (the banner stores one automatically in regions
// that do not require opt-in, and on Accept elsewhere). They still wait for the
// page to go idle so they never compete with first paint.
//
// With `publicPagesOnly` (NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY, see
// lib/telemetry/ga-config) they also never load on a signed-in page or on the
// pages that handle sign-in, payment or tokens. Scripts cannot be unloaded, so
// when a visitor moves from a public page into the app without a full page
// load, GA is told to stop sending until they are back on a public page.
export function DeferredGTM({
  gtmId,
  gaId,
  publicPagesOnly = false,
}: {
  gtmId: string;
  gaId?: string;
  publicPagesOnly?: boolean;
}) {
  const pathname = usePathname();
  const privatePage = publicPagesOnly && isPrivateAnalyticsPath(pathname);
  const [loaded, setLoaded] = useState(false);
  const [idle, setIdle] = useState(false);
  // Read the stored choice when state is created. Nothing renders until the
  // page is idle, so server and first client render match either way.
  const [consented, setConsented] = useState(() => typeof window !== "undefined" && hasAnalyticsConsent());

  useEffect(() => {
    const w = window as GoogleTagWindow;
    const cb = () => setIdle(true);
    if (typeof w.requestIdleCallback === "function") {
      const handle = w.requestIdleCallback(cb, { timeout: 3000 });
      return () => w.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(cb, 2000);
    return () => clearTimeout(timer);
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

  const show = idle && consented && (!privatePage || loaded);
  // Remember that the tags were rendered once, so they stay rendered (and are
  // switched off with ga-disable instead) on a later move into the app. Set
  // during render, React's pattern for state derived from earlier renders.
  if (show && !loaded) setLoaded(true);

  // Runs after the consent handler above, so it has the last word on a
  // private page: GA stays disabled there even if consent is given there.
  useEffect(() => {
    if (!publicPagesOnly || !gaId) return;
    const w = window as GoogleTagWindow;
    if (privatePage) {
      w[`ga-disable-${gaId}`] = true;
    } else if (consented) {
      delete w[`ga-disable-${gaId}`];
    }
  }, [publicPagesOnly, gaId, privatePage, consented]);

  if (!show) return null;
  return (
    <>
      <GoogleTagManager gtmId={gtmId} />
      {gaId ? <GoogleAnalytics gaId={gaId} /> : null}
    </>
  );
}
