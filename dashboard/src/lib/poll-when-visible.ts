/**
 * Wraps a polling callback so it no-ops while the browser tab is
 * backgrounded (document.hidden). Every skipped tick is one fewer
 * Vercel function invocation per idle-but-open tab — backgrounded
 * dashboards were the dominant source of wasted Function Invocations
 * and Fluid compute on the infra bill.
 *
 * The initial (non-interval) call should be left unwrapped so first
 * paint always fetches; only the repeating `setInterval` callback needs
 * the guard. On refocus the next scheduled tick fetches again, so the
 * UI is at most one interval stale when the tab comes back to the
 * foreground. SSR-safe: when `document` is undefined the call proceeds
 * unchanged.
 */
export function pollWhenVisible<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R | undefined {
  return (...args: A) => {
    if (typeof document !== "undefined" && document.hidden) return undefined;
    return fn(...args);
  };
}
