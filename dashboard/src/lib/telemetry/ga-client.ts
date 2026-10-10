// Google Analytics 4 events from the browser.
//
// GA loads late on purpose: DeferredGTM mounts @next/third-parties'
// <GoogleAnalytics> after the page goes idle, and that component's init script
// is what defines window.gtag. @next/third-parties' sendGAEvent drops events
// fired before then, which is exactly when a fresh sign-up is detected. This
// helper sends as soon as gtag exists and otherwise retries for a short
// window, so early conversion events still reach GA.
//
// Never pass personal data (email, name, user id) in params.

type Gtag = (command: "event", eventName: string, params?: Record<string, unknown>) => void;

const RETRY_INTERVAL_MS = 250;
const RETRY_WINDOW_MS = 10_000;

function currentGtag(): Gtag | null {
  if (typeof window === "undefined") return null;
  const gtag = (window as unknown as { gtag?: unknown }).gtag;
  return typeof gtag === "function" ? (gtag as Gtag) : null;
}

export function sendGaEvent(eventName: string, params: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  const trySend = (): boolean => {
    const gtag = currentGtag();
    if (!gtag) return false;
    gtag("event", eventName, params);
    return true;
  };
  if (trySend()) return;

  const maxAttempts = Math.ceil(RETRY_WINDOW_MS / RETRY_INTERVAL_MS);
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (trySend() || attempts >= maxAttempts) window.clearInterval(timer);
  }, RETRY_INTERVAL_MS);
}
