/**
 * Desktop shell presentation mode.
 *
 * A Hivra desktop app draws its own window chrome (sidebar, toolbar, tabs,
 * account menu) around the dashboard, so the page leaves its own chrome out.
 * The app announces itself in two ways, and either one is enough:
 *
 * - the macOS alpha injects `window.__HIVRA_NATIVE_WORKSPACE__` at document
 *   start, in the main frame of its trusted origin only;
 * - every desktop web view adds a user-agent product token: `HivraMac/<version>`
 *   on the macOS alpha, `HivraDesktop/<version>` on later shells.
 *
 * This is presentation only. A page script can forge both signals, so nothing
 * may use them for trust, auth or metadata. The message-handler bridge in
 * native-workspace.ts stays the only gate for data sent to the app.
 */

export const DESKTOP_SHELL_ATTRIBUTE = "data-shell" as const;
export const DESKTOP_SHELL_VALUE = "desktop" as const;

/** A whole product token, so "NotHivraMac/1.0" is not a desktop app. */
const DESKTOP_USER_AGENT = /(?:^|\s)Hivra(?:Mac|Desktop)\//;

type DesktopShellHost = {
  __HIVRA_NATIVE_WORKSPACE__?: unknown;
  navigator?: { userAgent?: unknown };
};

/** Whether this window belongs to a desktop app. Presentation only. */
export function detectDesktopShell(host: DesktopShellHost): boolean {
  // Any marker object counts: a later bridge version is still the desktop app.
  const marker = host.__HIVRA_NATIVE_WORKSPACE__;
  if (typeof marker === "object" && marker !== null) return true;
  const userAgent = host.navigator?.userAgent;
  return typeof userAgent === "string" && DESKTOP_USER_AGENT.test(userAgent);
}

/** Client helper, with the same answer as the pre-paint script below. */
export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return detectDesktopShell(window as unknown as DesktopShellHost);
  } catch {
    return false;
  }
}

/**
 * Runs from the root layout's <head>, before the body is parsed, so CSS can
 * hide web chrome on first paint instead of after hydration. It must stay
 * inline and synchronous: a deferred script paints the chrome first, and the
 * server cannot see the injected marker (a user-agent read would also have to
 * vary every cached page by user agent). Keep it in step with
 * detectDesktopShell; desktop-shell.test.ts runs both against the same cases.
 */
export const DESKTOP_SHELL_BOOTSTRAP = `(function(){try{var m=window.__HIVRA_NATIVE_WORKSPACE__;`
  + `if((typeof m==="object"&&m!==null)||${String(DESKTOP_USER_AGENT)}.test(navigator.userAgent||""))`
  + `document.documentElement.setAttribute(${JSON.stringify(DESKTOP_SHELL_ATTRIBUTE)},${JSON.stringify(DESKTOP_SHELL_VALUE)})`
  + `}catch(e){}})();`;
