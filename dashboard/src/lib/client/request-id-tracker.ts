/**
 * Client-side request id correlation.
 *
 * Tracks the most recent `x-request-id` returned by an API response so that
 * client-side error logs (clientLog.error / unhandled rejection / error
 * boundary) can reference the same id the server logged. This lets a
 * "chat failed" report from the browser line up with the exact
 * dashboard/sidecar log line that handled the request.
 *
 * Usage:
 *   import { trackedFetch, getLastRequestId } from "@/lib/client/request-id-tracker";
 *   const res = await trackedFetch("/api/...", { ... });
 *   // …on error
 *   clientLog.error("...", err, { source: "chat", requestId: getLastRequestId() });
 *
 * `trackedFetch` is a drop-in replacement for `fetch` — same signature,
 * same return — but it reads `x-request-id` off the response and stashes
 * it. Failures during the actual fetch (network, abort) leave the tracker
 * untouched.
 */
const REQUEST_ID_HEADER = "x-request-id";

let lastRequestId: string | null = null;

export function recordRequestId(id: string | null | undefined): void {
  if (typeof id !== "string") return;
  const trimmed = id.trim();
  if (!trimmed) return;
  lastRequestId = trimmed;
}

export function getLastRequestId(): string | null {
  return lastRequestId;
}

/**
 * Returns the last seen request id and clears it. Use when reporting an
 * error so the same id isn't silently re-attached to subsequent unrelated
 * client events. Most call sites should prefer `getLastRequestId` instead.
 */
export function consumeLastRequestId(): string | null {
  const value = lastRequestId;
  lastRequestId = null;
  return value;
}

export async function trackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  recordRequestId(response.headers.get(REQUEST_ID_HEADER));
  return response;
}

declare global {
  interface Window {
    __hermesFetchPatched?: boolean;
  }
}

/**
 * Install a one-shot interceptor on window.fetch so that *every* fetch a
 * client component makes contributes to the request-id tracker — without
 * needing each component to swap to `trackedFetch`. Idempotent. Safe to
 * call from a top-level provider's mount effect.
 *
 * Returns an uninstall function that restores the original fetch.
 */
export function installFetchRequestIdInterceptor(): () => void {
  if (typeof window === "undefined") return () => {};
  if (window.__hermesFetchPatched) return () => {};

  const original = window.fetch.bind(window);
  window.__hermesFetchPatched = true;

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await original(input, init);
    try {
      recordRequestId(response.headers.get(REQUEST_ID_HEADER));
    } catch {
      // headers.get can throw on some opaque-response edge cases; ignore.
    }
    return response;
  };

  return () => {
    if (window.__hermesFetchPatched) {
      window.fetch = original;
      delete window.__hermesFetchPatched;
    }
  };
}
