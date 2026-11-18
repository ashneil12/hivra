import { isProtectedPath } from "@/lib/protected-routes";

// Pages where no recording or third-party analytics may run.
//
// Every signed-in page can show something that belongs to the person: agent
// names, activity, computers, chats, keys, payments. Those pages come from the
// same list the sign-in check uses (lib/protected-routes), so a page that needs
// an account can never be left off a second list. The patterns below are the
// public pages that still handle credentials, payments or tokens.
//
// Used by session replay (PostHogProvider, always) and by Google Analytics
// when NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY is on (DeferredGTM).
const PRIVATE_PUBLIC_ROUTES: RegExp[] = [
  /\/sign-in/,
  /\/sign-up/,
  /\/token(\b|\/)/,
  /\/get-started\/activate/,
  // Returning from payment, and the page shown while a person's computer wakes.
  /^\/checkout(?:\/|$)/,
  /^\/wake(?:\/|$)/,
];

export function isPrivateAnalyticsPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (isProtectedPath(pathname)) return true;
  return PRIVATE_PUBLIC_ROUTES.some((pattern) => pattern.test(pathname));
}
