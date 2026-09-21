import { test, expect, type Browser, type Request } from '@playwright/test';
import { gunzipSync, inflateSync } from 'node:zlib';

import {
  applyHumanBrowserSignals,
  humanBrowserContextOptions,
  humanizeUserAgent,
} from './first-run-audit/browser-signals';
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from '../src/lib/consent/cookie-consent';

/**
 * Proves the activation funnel is OBSERVABLE on the deployed target: a real page
 * load must produce a real PostHog ingest POST.
 *
 * This is the regression guard for two bugs that presented identically —
 * "PostHog inits, pulls flags, ingests nothing":
 *
 *   1. posthog-js silently drops every capture() from a browser it reads as a
 *      bot. Stock Playwright is a bot on three independent signals (see
 *      browser-signals.ts). This was the actual cause on canary; the funnel
 *      instrumentation was fine all along.
 *
 *   2. No NEXT_PUBLIC_POSTHOG_KEY => analytics is OFF by design (there is no
 *      fallback token any more). Then `analytics_disabled` is the correct
 *      verdict, not a bug — but it must be VISIBLE, not silent.
 *
 * OPT-IN. Every run ingests a real `$pageview` into whatever project the target
 * is configured with, so this must not fire on every CI job. Enable with
 * `E2E_POSTHOG_INGEST=1` and point E2E_BASE_URL at a NON-PRODUCTION target.
 *
 *     E2E_POSTHOG_INGEST=1 npx playwright test --project=public posthog-ingest
 */

const ENABLED = process.env.E2E_POSTHOG_INGEST === '1';

/** Both the current (`/p/e/`) and the remote-config-able (`/p/i/v0/e/`) paths. */
const INGEST_PATH = /\/p\/(?:e|i\/v0\/e)\/?$/;
const FLAGS_PATH = /\/p\/flags\/?$/;

function decodeEvents(request: Request): string[] {
  let raw: string | null = null;
  try {
    const buf = request.postDataBuffer();
    if (buf?.length) {
      if (buf[0] === 0x1f && buf[1] === 0x8b) raw = gunzipSync(buf).toString('utf8');
      else if (buf[0] === 0x78) {
        try {
          raw = inflateSync(buf).toString('utf8');
        } catch {
          /* not zlib after all */
        }
      }
      raw ??= buf.toString('utf8');
    }
    raw ??= request.postData();
  } catch {
    return [];
  }
  if (!raw) return [];

  if (raw.startsWith('data=')) {
    const value = decodeURIComponent(raw.slice(5).replace(/\+/g, ' '));
    try {
      const decoded = Buffer.from(value, 'base64');
      raw =
        decoded[0] === 0x1f && decoded[1] === 0x8b
          ? gunzipSync(decoded).toString('utf8')
          : decoded.toString('utf8');
      JSON.parse(raw);
    } catch {
      raw = value;
    }
  }

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((e) => typeof e?.event === 'string').map((e) => e.event as string);
  } catch {
    return [];
  }
}

async function openConsentedPage(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    ...(await humanBrowserContextOptions(browser)),
  });
  await applyHumanBrowserSignals(context);
  await context.addInitScript(
    ([key, version]) => {
      try {
        window.localStorage.setItem(
          key as string,
          JSON.stringify({ choice: 'accepted', version, timestamp: Date.now() }),
        );
      } catch {
        /* private mode */
      }
    },
    [CONSENT_STORAGE_KEY, CONSENT_VERSION] as const,
  );
  return context;
}

test.describe('posthog ingest', () => {
  test.skip(!ENABLED, 'opt-in: set E2E_POSTHOG_INGEST=1 (ingests real events)');

  test('a consented page load produces a real ingest POST', async ({ browser, baseURL }) => {
    const context = await openConsentedPage(browser, baseURL!);
    let ingestRequests = 0;
    let flagsRequests = 0;
    const decodedEvents: string[] = [];

    context.on('request', (request) => {
      if (request.method() !== 'POST') return;
      // `trailingSlash: false` 308s `/p/e/` -> `/p/e`, so the browser replays the
      // POST and we see the same batch twice. Only the original carries a body.
      if (request.redirectedFrom()) return;
      const path = new URL(request.url()).pathname;
      if (FLAGS_PATH.test(path)) flagsRequests += 1;
      if (INGEST_PATH.test(path)) {
        ingestRequests += 1;
        decodedEvents.push(...decodeEvents(request));
      }
    });

    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // init is deferred via requestIdleCallback (<=2s) and posthog batches its
    // request queue on a ~3s timer, so poll rather than sleeping a fixed amount.
    //
    // The assertion is on the REQUEST, not on decoded event names: once PostHog's
    // remote config lands, batches are gzip Blobs and Chrome will not expose the
    // body over CDP (postDataBuffer() === null) even though PostHog answers
    // {"status":"Ok"}. Whether a given batch is readable is a race. The request
    // itself is the thing the bot filter suppresses, so it is the honest signal.
    await expect
      .poll(() => ingestRequests, {
        message:
          'no PostHog ingest POST. Either the browser is being read as a bot ' +
          '(see browser-signals.ts) or the target sets no NEXT_PUBLIC_POSTHOG_KEY ' +
          '(analytics off by design — there is no fallback token).',
        timeout: 30_000,
        intervals: [1000],
      })
      .toBeGreaterThan(0);

    // Flags succeeding while ingest stays at zero is the exact signature of the
    // bot filter — assert posthog really did initialize, so a zero above can only
    // mean the ingest gate, never "posthog never loaded".
    expect(
      flagsRequests,
      'remote flags never loaded; posthog did not initialize at all',
    ).toBeGreaterThan(0);

    // Best effort: when a batch WAS readable, it must be the manual $pageview
    // (capture_pageview is false; PostHogPageView captures it by hand).
    if (decodedEvents.length > 0) {
      expect(decodedEvents).toContain('$pageview');
    }

    await context.close();
  });

  test('stock (bot-signalled) browsers capture nothing — the trap this guards', async ({
    browser,
    baseURL,
  }) => {
    // Deliberately does NOT neutralize the bot signals. Documents, in executable
    // form, why every telemetry assertion in e2e/ must go through
    // browser-signals.ts. If this ever starts capturing, posthog changed its bot
    // filter and the harness comments need revisiting.
    const context = await browser.newContext({ baseURL });
    const ingested: string[] = [];
    context.on('request', (request) => {
      if (request.method() !== 'POST') return;
      if (INGEST_PATH.test(new URL(request.url()).pathname)) {
        ingested.push(...decodeEvents(request));
      }
    });

    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(15_000);

    expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
    expect(ingested, 'posthog captured from a bot-signalled browser').toHaveLength(0);

    await context.close();
  });
});

test('humanizeUserAgent strips the headless marker', () => {
  expect(
    humanizeUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/203.0.113.0 Safari/537.36',
    ),
  ).toBe(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.0 Safari/537.36',
  );
});
