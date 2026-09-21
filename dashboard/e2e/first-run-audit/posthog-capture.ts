/**
 * Captures the analytics events the run actually produced, so a FAILED run tells
 * us WHERE it died rather than just "it died".
 *
 * The app proxies PostHog through a same-origin rewrite (`/p/:path*` →
 * us.i.posthog.com, see next.config.ts), and posthog-js POSTs its batch to
 * `<api_host>/e/`. PostHog Cloud can also remote-config the endpoint to
 * `/i/v0/e/`, so we match both.
 *
 * Bodies are BATCHED — one request carries an array of events — and arrive in
 * several encodings, all handled below.
 *
 * ── TWO THINGS THAT MAKE THIS LOOK BROKEN WHEN IT IS NOT ───────────────────
 *
 * 1. posthog-js drops every capture() from a browser it reads as a bot, and a
 *    stock Playwright context is one. Context creation MUST go through
 *    browser-signals.ts or this class records nothing at all — that, not a
 *    missing analytics key, is what produced `posthog_captured: false`.
 *
 * 2. Once PostHog's remote config lands, posthog compresses the batch and sends
 *    it as a `Blob` (`content-type: text/plain`). CHROME DOES NOT EXPOSE BLOB
 *    POST BODIES OVER CDP, so `request.postDataBuffer()` returns null and the
 *    batch is UNDECODABLE — even though PostHog answers `{"status":"Ok"}` and
 *    the events are ingested. Whether a batch is readable is therefore a race
 *    between the first events and the remote-config fetch.
 *
 *    So "did posthog ingest?" (sawIngest) and "which events can we read?"
 *    (all/named/funnelTimeline) are DIFFERENT questions. Never answer the first
 *    with the second: an empty funnel does not mean analytics is dead.
 */
import { gunzipSync, inflateSync } from 'node:zlib';

import type { BrowserContext, Request } from '@playwright/test';

/** Matches both the current (`/p/e/`) and remote-config-able (`/p/i/v0/e/`) ingest paths. */
const INGEST_URL = /\/p\/(?:e|i\/v0\/e)\/?(?:\?|$)/;

export interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
  at: number;
}

export class PostHogCapture {
  private readonly events: CapturedEvent[] = [];
  private ingestRequests = 0;
  private undecodableRequests = 0;

  /** Attach before the first navigation. Observe-only — never blocks the request. */
  attach(context: BrowserContext): void {
    context.on('request', (request) => {
      if (request.method() !== 'POST') return;
      if (!INGEST_URL.test(request.url())) return;
      // posthog posts to `<api_host>/e/`; with `trailingSlash: false` Next
      // 308s that to `/e`, so the browser replays the POST and Playwright emits
      // a SECOND request event for the same batch. Count (and decode) only the
      // original, or every event lands twice.
      if (request.redirectedFrom()) return;
      this.ingestRequests += 1;
      const decoded = decodeBatch(request);
      if (decoded.length === 0) this.undecodableRequests += 1;
      for (const event of decoded) this.events.push(event);
    });
  }

  /**
   * Did posthog actually ship events? True as soon as ONE ingest POST is seen,
   * whether or not its (possibly gzip-Blob) body could be read. This — not
   * `all().length > 0` — is the honest answer to "is analytics flowing", and the
   * discriminator against the bot filter, which produces zero requests.
   */
  sawIngest(): boolean {
    return this.ingestRequests > 0;
  }

  /** Ingest batches whose body Chrome would not hand us. See the header note. */
  undecodable(): number {
    return this.undecodableRequests;
  }

  all(): CapturedEvent[] {
    return [...this.events];
  }

  named(name: string): CapturedEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  /** Did this event fire for this instance? Property name varies by emitter. */
  firedFor(name: string, instanceId: string): boolean {
    return this.named(name).some(
      (e) => e.properties.instance_id === instanceId || e.properties.box_id === instanceId,
    );
  }

  /**
   * The activation-funnel failures, with the diagnostics #482/#483 added:
   * `stage`, `errorCategory`, `failureType`, `recoverable`.
   */
  activationFailures(): Array<Record<string, unknown>> {
    return this.named('activation_failed').map((e) => ({
      stage: e.properties.stage ?? null,
      failureType: e.properties.failureType ?? null,
      errorCategory: e.properties.errorCategory ?? null,
      errorMessage: e.properties.errorMessage ?? null,
      recoverable: e.properties.recoverable ?? null,
      at: e.at,
    }));
  }

  /** Compact, PR-readable timeline: every funnel-relevant event, in order. */
  funnelTimeline(): Array<{ event: string; at: number; detail?: string }> {
    const interesting = new Set([
      'signup_completed',
      'activation_started',
      'activation_page_viewed',
      'activation_dashboard_reached',
      'welcome_agent_type_selected',
      'welcome_persona_selected',
      'activation_instance_requested',
      'activation_card_required',
      'paywall_viewed',
      'activation_instance_ready',
      'activation_failed',
      'welcome_dead_click_candidate',
      'webui_handoff_mint',
      'webui_iframe_loaded',
      'webui_iframe_error',
      'webui_iframe_stopped',
      'agent_first_message_sent',
      'free_limit_hit',
    ]);
    return this.events
      .filter((e) => interesting.has(e.event))
      .map((e) => ({
        event: e.event,
        at: e.at,
        detail: describe(e),
      }));
  }
}

function describe(e: CapturedEvent): string | undefined {
  const parts: string[] = [];
  for (const key of ['stage', 'reason', 'pending_reason', 'errorCategory', 'failureType', 'outcome']) {
    const value = e.properties[key];
    if (typeof value === 'string' && value) parts.push(`${key}=${value}`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * posthog-js may send: raw JSON, gzip (gzip-js), deflate, or a urlencoded
 * `data=<base64>` form. Try each; never throw — losing telemetry must not fail
 * an audit run.
 */
function decodeBatch(request: Request): CapturedEvent[] {
  const at = Date.now();
  let raw: string | null = null;

  try {
    const buf = request.postDataBuffer();
    if (buf && buf.length > 0) {
      raw = tryDecompress(buf);
    }
    if (raw === null) raw = request.postData();
  } catch {
    return [];
  }
  if (!raw) return [];

  // urlencoded `data=<base64-or-json>`
  if (raw.startsWith('data=')) {
    const value = decodeURIComponent(raw.slice(5).replace(/\+/g, ' '));
    raw = tryBase64Json(value) ?? value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: CapturedEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { event?: unknown; properties?: unknown };
    if (typeof record.event !== 'string') continue;
    out.push({
      event: record.event,
      properties:
        record.properties && typeof record.properties === 'object'
          ? (record.properties as Record<string, unknown>)
          : {},
      at,
    });
  }
  return out;
}

function tryDecompress(buf: Buffer): string | null {
  // gzip magic
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf).toString('utf8');
    } catch {
      return null;
    }
  }
  // zlib/deflate magic
  if (buf[0] === 0x78) {
    try {
      return inflateSync(buf).toString('utf8');
    } catch {
      /* fall through */
    }
  }
  const text = buf.toString('utf8');
  return text.length > 0 ? text : null;
}

function tryBase64Json(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded[0] === 0x1f && decoded[1] === 0x8b) return gunzipSync(decoded).toString('utf8');
    const text = decoded.toString('utf8');
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}
