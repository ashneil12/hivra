"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Counts clicks on the homepage's calls to action (every link carrying a
 * data-cta name), so the revamp's effect on starts can be measured. It goes
 * through the site's PostHog client, which sends nothing until the visitor
 * has given analytics consent.
 */
export default function HomeAnalytics() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cta]") : null;
      if (!target || !(posthog as unknown as { __loaded?: boolean }).__loaded) return;
      try {
        posthog.capture("home_cta_clicked", { cta: target.dataset.cta, href: target.getAttribute("href") });
      } catch {
        /* analytics must never break a click */
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
