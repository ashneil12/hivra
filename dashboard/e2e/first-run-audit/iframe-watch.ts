/**
 * Observes whether the workspace iframe ACTUALLY LOADED, using the browser's own
 * network events rather than the dashboard's analytics.
 *
 * WHY THIS EXISTS. The first cut of this harness proved `workspace_interactive`
 * by waiting for the app's `webui_iframe_loaded` PostHog event. That looked
 * elegant — assert with the product's own telemetry — but it made the audit
 * un-runnable against its only legal target: two full 10-minute runs recorded
 * `posthog_captured: false, funnel: []` and failed at `workspace_interactive`
 * with `category: "product"`, on boxes that were provably healthy.
 *
 * The cause was originally recorded here as "canary sets no
 * NEXT_PUBLIC_POSTHOG_KEY". THAT WAS WRONG, and the correction matters because
 * the two failures look identical from the network: posthog-js silently DROPS
 * every capture() from a browser it reads as a bot, while remote config and
 * `/p/flags/` keep succeeding. Stock Playwright is a bot on three independent
 * signals. Proven on canary 2026-07-08 by driving the real welcome flow twice
 * with only those signals differing: 0 ingest POSTs vs 5 (13 events). See
 * browser-signals.ts. The key was never the problem.
 *
 * The product's own definition of "loaded" is the iframe element's DOM `load`
 * event (WebuiIframe.tsx `onLoad={handleLoad}` → trackIframeLoaded). The event
 * that CAUSES that callback is the iframe document's navigation completing. We
 * observe exactly that, one layer lower, where no analytics is involved at all:
 * a document-type response in a child frame, with its HTTP status.
 *
 * That is strictly MORE information than the telemetry gave us — `onLoad` fires
 * even when the box serves an error page, so a 502 would have counted as
 * "loaded". Here we can require a non-error status.
 *
 * Telemetry is still captured (PostHogCapture) and still recorded in the
 * verdict. It corroborates; it no longer gates.
 */
import type { BrowserContext, Frame, Response } from '@playwright/test';

export interface FrameDocument {
  url: string;
  status: number;
  at: number;
}

export class IframeLoadWatcher {
  private readonly documents: FrameDocument[] = [];

  /** Attach before navigating to the workspace. Observe-only. */
  attach(context: BrowserContext): void {
    context.on('response', (response: Response) => {
      void this.record(response);
    });
  }

  private record(response: Response): void {
    let frame: Frame | null = null;
    try {
      frame = response.frame();
    } catch {
      // A response whose frame has already been detached — nothing to attribute.
      return;
    }
    // Only child frames. The dashboard page itself is the main frame.
    if (!frame || frame.parentFrame() === null) return;
    if (response.request().resourceType() !== 'document') return;

    this.documents.push({ url: response.url(), status: response.status(), at: Date.now() });
  }

  /** Every child-frame document response seen so far. */
  all(): FrameDocument[] {
    return [...this.documents];
  }

  /** Every child-frame document response from the box, oldest first. */
  chain(origin: string): FrameDocument[] {
    return this.documents.filter((doc) => doc.url.startsWith(origin));
  }

  /**
   * The workspace iframe's SETTLED document response — the one that actually
   * finished the navigation and would have fired the product's `onLoad`.
   *
   * Redirects are skipped, not accepted. The minted handoff URL is a signed
   * login endpoint on the box's gateway that 302s onward once it establishes the
   * session, and Playwright surfaces each hop as its own response. Taking the
   * first response would report `302` as the outcome and would green-light a box
   * that redirected straight into a 403 — which is exactly the hardened-auth
   * failure mode this audit exists to catch. Returns null while only redirects
   * have been seen.
   *
   * `origin` is the origin of the handoff URL, which keeps a stray third-party
   * iframe (Stripe, Clerk) from being mistaken for the workspace.
   */
  workspaceDocument(origin: string): FrameDocument | null {
    const settled = this.chain(origin).filter((doc) => doc.status < 300 || doc.status >= 400);
    return settled.length > 0 ? settled[settled.length - 1] : null;
  }
}
