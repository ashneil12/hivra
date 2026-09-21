"use client";

import { GoogleAnalytics, GoogleTagManager } from "@next/third-parties/google";
import { useEffect, useState } from "react";

export function DeferredGTM({ gtmId, gaId }: { gtmId: string; gaId?: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
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
