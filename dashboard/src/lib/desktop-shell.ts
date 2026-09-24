/**
 * Desktop app signals.
 *
 * A Hivra desktop app loads the dashboard in its own web views, and two
 * signals answer two different questions about the page:
 *
 * - Is this page in one of the app's web views? Each one adds a user-agent
 *   product token: `HivraMac/<version>` on the macOS alpha,
 *   `HivraDesktop/<version>` on later shells. That includes windows with no
 *   native navigation around them, such as the macOS alpha's detached
 *   surfaces and pop-ups. What holds for the whole app (analytics consent is
 *   never assumed, Home never resumes on its own) follows this: isDesktopApp.
 * - Does the app draw its own navigation around this view? Only then does the
 *   app inject `window.__HIVRA_NATIVE_WORKSPACE__` at document start, in the
 *   main frame of its trusted origin, and only then does the page leave its
 *   own chrome out: isDesktopShell and html[data-shell="desktop"]. A window
 *   without native navigation keeps the web sidebar, or it could not reach
 *   another page, Settings or sign-out. A user agent alone never hides it.
 *
 * Both are presentation only. A page script can forge either, so nothing may
 * use them for trust, auth or metadata. The message-handler bridge in
 * native-workspace.ts stays the only gate for data sent to the app.
 */

export const DESKTOP_SHELL_ATTRIBUTE = "data-shell" as const;
export const DESKTOP_SHELL_VALUE = "desktop" as const;

/** A whole product token, so "NotHivraMac/1.0" is not a desktop app. */
const DESKTOP_USER_AGENT = /(?:^|\s)Hivra(?:Mac|Desktop)\//;

type DesktopHost = {
  __HIVRA_NATIVE_WORKSPACE__?: unknown;
  navigator?: { userAgent?: unknown };
};

/** Whether the app wraps this view in its own navigation. Presentation only. */
export function detectDesktopShell(host: DesktopHost): boolean {
  // Any marker object counts: a later bridge version still wraps the view.
  const marker = host.__HIVRA_NATIVE_WORKSPACE__;
  return typeof marker === "object" && marker !== null;
}

/** Whether this page is in any of a desktop app's web views. Presentation only. */
export function detectDesktopApp(host: DesktopHost): boolean {
  if (detectDesktopShell(host)) return true;
  const userAgent = host.navigator?.userAgent;
  return typeof userAgent === "string" && DESKTOP_USER_AGENT.test(userAgent);
}

function detectInWindow(detect: (host: DesktopHost) => boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    return detect(window as unknown as DesktopHost);
  } catch {
    return false;
  }
}

/** Client helper, with the same answer as the pre-paint script below. */
export function isDesktopShell(): boolean {
  return detectInWindow(detectDesktopShell);
}

/** Client helper: any window of a desktop app, with or without native navigation. */
export function isDesktopApp(): boolean {
  return detectInWindow(detectDesktopApp);
}

/**
 * Runs from the root layout's <head>, before the body is parsed, so CSS can
 * hide web chrome on first paint instead of after hydration. It must stay
 * inline and synchronous: a deferred script paints the chrome first, and the
 * server cannot see the injected marker. Keep it in step with
 * detectDesktopShell; desktop-shell.test.ts runs both against the same cases.
 */
export const DESKTOP_SHELL_BOOTSTRAP = `(function(){try{var m=window.__HIVRA_NATIVE_WORKSPACE__;`
  + `if(typeof m==="object"&&m!==null)`
  + `document.documentElement.setAttribute(${JSON.stringify(DESKTOP_SHELL_ATTRIBUTE)},${JSON.stringify(DESKTOP_SHELL_VALUE)})`
  + `}catch(e){}})();`;
