/**
 * Prove a self-hosted catalog app is actually open through the same
 * authenticated iframe a customer uses. Unlike an agent, an app does not owe
 * the sweep a chat reply: first-run setup, a login form, or the app's own
 * dashboard are all valid proof that the hosted application is reachable.
 */
import type { Frame, Page } from '@playwright/test';

import { sleep } from '../first-run-audit/instances';
import { SweepFailure } from './result';
import type { SweepTarget } from './targets';

const GATEWAY_ERROR = /(bad gateway|gateway timeout|service unavailable|connection refused|box is private|couldn.t verify secure access|dashboard not reachable|ERR_CONNECTION|502 Bad Gateway|503 Service Unavailable)/i;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

export interface AppOpenProof {
  surface: string;
  /** Seconds from first check until meaningful app content appeared. */
  openSeconds: number;
  /** Short visible text sample recorded in the result JSON. */
  textSample: string;
}

function frameBodies(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

function probeOllamaVersion(frame: Frame, origin: string): Promise<boolean> {
  return frame.evaluate(async (appOrigin) => {
    const response = await fetch(new URL('/api/version', appOrigin), {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return false;
    const payload = await response.json() as { version?: unknown } | null;
    return typeof payload?.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(payload.version);
  }, origin).catch(() => false);
}

/** Wait for the embedded app to render real content, rejecting gateway and loopback failures. */
export async function proveAppOpen(page: Page, { profileId, tile }: SweepTarget, timeoutMs: number): Promise<AppOpenProof> {
  const started = Date.now();
  const end = started + timeoutMs;
  let lastSeen = '';
  let ollamaVersionFailed = false;

  while (Date.now() < end) {
    const iframe = page.locator('iframe[title$="· dashboard"]').first();
    const handle = await iframe.elementHandle({ timeout: 1_000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) {
      let host = '';
      let pathname = '';
      let origin = '';
      try {
        ({ host, pathname, origin } = new URL(frame.url()));
      } catch {
        host = frame.url();
      }
      if (LOOPBACK_HOST.test(host)) {
        throw new SweepFailure('chat', 'product', `${tile} redirected its embedded surface to loopback host ${host}.`);
      }
      const text = (await frameBodies(frame)).replace(/\s+/g, ' ').trim();
      if (text) lastSeen = text.slice(0, 500);
      if (GATEWAY_ERROR.test(text)) {
        throw new SweepFailure('chat', 'product', `${tile} showed a gateway/runtime error: "${text.slice(0, 240)}"`);
      }
      let visibleApp = text.length >= 20 || (profileId === 'dufs' && text === 'Empty folder');
      if (profileId === 'chroma') {
        visibleApp = pathname === '/docs/' && text.includes('chroma-frontend') && text.includes('/api/v2/heartbeat');
      } else if (profileId === 'ollama') {
        visibleApp = false;
        if (pathname === '/' && text === 'Ollama is running') {
          visibleApp = await probeOllamaVersion(frame, origin);
          ollamaVersionFailed = !visibleApp;
        }
      }
      if (visibleApp) {
        return {
          surface: `${tile} web app`,
          openSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
          textSample: text.slice(0, 240),
        };
      }
    }
    await sleep(3_000);
  }

  throw new SweepFailure(
    'open',
    'product',
    (ollamaVersionFailed
      ? `${tile} opened, but its authenticated /api/version did not return an Ollama version.`
      : `${tile} did not render visible app content after ${Math.round(timeoutMs / 60_000)} min.`) +
      (lastSeen ? ` Last frame text: "${lastSeen.slice(0, 240)}".` : ''),
  );
}
