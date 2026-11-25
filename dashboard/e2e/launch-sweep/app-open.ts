/**
 * Prove a self-hosted catalog app is actually open through the same
 * authenticated iframe a customer uses. Unlike an agent, an app does not owe
 * the sweep a chat reply: first-run setup, a login form, or the app's own
 * dashboard are all valid proof that the hosted application is reachable.
 */
import type { Frame, Page } from '@playwright/test';

import { sleep } from '../first-run-audit/instances';
import { SweepFailure } from './result';

const GATEWAY_ERROR = /(bad gateway|gateway timeout|service unavailable|connection refused|box is private|couldn.t verify secure access|dashboard not reachable|ERR_CONNECTION|502 Bad Gateway|503 Service Unavailable)/i;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

export interface AppOpenProof {
  surface: string;
  /** Milliseconds from first check until meaningful app content appeared. */
  openSeconds: number;
  /** Short visible text sample recorded in the result JSON. */
  textSample: string;
}

function frameBodies(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

/** Wait for the embedded app to render real content, rejecting gateway and loopback failures. */
export async function proveAppOpen(page: Page, tile: string, timeoutMs: number): Promise<AppOpenProof> {
  const started = Date.now();
  const end = started + timeoutMs;
  let lastSeen = '';

  while (Date.now() < end) {
    const iframe = page.locator('iframe[title$="· dashboard"]').first();
    const handle = await iframe.elementHandle({ timeout: 1_000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) {
      let host = '';
      try {
        host = new URL(frame.url()).host;
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
      if (text.length >= 20) {
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
    `${tile} did not render visible app content after ${Math.round(timeoutMs / 60_000)} min.` +
      (lastSeen ? ` Last frame text: "${lastSeen.slice(0, 240)}".` : ''),
  );
}
