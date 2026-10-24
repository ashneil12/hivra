/**
 * Home resumes your last working surface only when the app is opened there:
 * the installed app's start page, or the first visit to Home in a browser
 * tab. Reaching Home from inside the app (the Home link, the logo, Back)
 * shows the list, with a "Continue" link, instead of bouncing you back into
 * what you just left.
 *
 * "Opened there" means this document was loaded by a fresh navigation to
 * /dashboard (not a reload, not back/forward), and Home has not been shown
 * since in this tab. Client-side moves never create a new document, so they
 * never count as opening the app.
 *
 * Inside a Hivra desktop app, the app itself reopens what you were in: its
 * web views load /dashboard freshly whenever it needs one (each with empty
 * session storage), so the web page must never resume on its own in any of
 * the app's windows. A window opened on Home shows Home.
 */

import { isDesktopApp } from "@/lib/desktop-shell";

export const HOME_OPENED_STORAGE_KEY = "hivra.home.opened" as const;

const HOME_PATHS = new Set(["/dashboard", "/dashboard/"]);

function openingNavigation(): PerformanceNavigationTiming | null {
  try {
    const [entry] = performance.getEntriesByType?.("navigation") ?? [];
    return (entry as PerformanceNavigationTiming | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Whether this is the app being opened at Home. Reads only; see markHomeOpened. */
export function isAppOpenAtHome(): boolean {
  if (typeof window === "undefined" || isDesktopApp()) return false;
  const entry = openingNavigation();
  if (!entry || entry.type !== "navigate") return false;
  let pathname: string;
  try {
    pathname = new URL(entry.name, window.location.origin).pathname;
  } catch {
    return false;
  }
  if (!HOME_PATHS.has(pathname)) return false;
  try {
    return window.sessionStorage.getItem(HOME_OPENED_STORAGE_KEY) === null;
  } catch {
    // Without session storage there's no way to tell a Home link from the
    // app opening, so Home shows the list.
    return false;
  }
}

/** Records that Home has been shown in this tab, so it opens as a list from now on. */
export function markHomeOpened(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(HOME_OPENED_STORAGE_KEY, "1");
  } catch {
    // Storage denied: isAppOpenAtHome already answers false without it.
  }
}
