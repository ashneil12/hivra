"use client";

import { GoogleAnalytics, GoogleTagManager } from "@next/third-parties/google";
import { useEffect, useState } from "react";

import { readStoredConsent } from "@/lib/consent/cookie-consent";
import { isDesktopApp } from "@/lib/desktop-shell";

export function DeferredGTM({ gtmId, gaId }: { gtmId: string; gaId?: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // A desktop app never assumes analytics consent: its web views load the
    // tags only after the person accepted analytics (a stored choice).
    if (isDesktopApp() && readStoredConsent()?.choice !== "accepted") return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    const cb = () => setMounted(true);
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(cb, { timeout: 3000 });
    } else {
      setTimeout(cb, 2000);
    }
  }, []);

  if (!mounted) return null;
  return (
    <>
      <GoogleTagManager gtmId={gtmId} />
      {gaId ? <GoogleAnalytics gaId={gaId} /> : null}
    </>
  );
}
