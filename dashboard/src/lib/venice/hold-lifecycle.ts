// How long a managed-Venice wallet hold may stay active, and the markers the
// request path and the stale-hold sweep (reservation-sweep.ts) leave on what
// they settle.
//
// A hold is created right before Hivra forwards a request to Venice and is
// captured or released when Venice answers. When Venice answered but the exact
// usage never arrived (the client closed the stream before the usage frame,
// the stream hit its deadline, Venice left the frame out), the request path
// charges what it saw: the input estimate plus the output it streamed
// (stream-output-meter.ts), never more than the hold. Only when that charge
// cannot be written does the hold wait for the sweep, which charges the same
// number from the reconciliation item. A hold nothing settled at all (the
// function was killed mid-request, the Worker never called back) expires, and
// the sweep then captures an estimate: nothing proves Venice did not run the
// request, and Venice bills Hivra when it does.
//
// Kept separate from reservation-sweep.ts so the chat reconciliation cron can
// read these markers without loading the sweep.

import { calculateVeniceTokenCostMicroUsd } from "./pricing";

/** Media requests finish within one function run (at most a few minutes). */
export const MANAGED_VENICE_MEDIA_HOLD_TTL_MS = 60 * 60 * 1000;

/**
 * A chat or Responses request on Vercel settles within one function run
 * (MANAGED_VENICE_STREAM_DEADLINE_MS), but a stream the Cloudflare Worker
 * holds has no platform limit and can run for hours on a slow model, so a
 * chat hold whose settlement never arrives is only presumed orphaned after a
 * day.
 */
export const MANAGED_VENICE_CHAT_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The Vercel chat, Anthropic and Responses routes run for at most 300 s
 * (their maxDuration). They stop reading Venice at this deadline and settle
 * what was streamed, so the platform never kills a request whose hold it
 * has not settled.
 */
export const MANAGED_VENICE_STREAM_DEADLINE_MS = 270_000;

/**
 * A chat hold covers the most output its request allows, which with a large
 * or absent output cap can be the model's whole output limit. A hold that
 * nothing settled (no item, no observed output on record) is charged its
 * input estimate plus at most this many output tokens per choice, never more
 * than the pre-request estimate. 4,096 is the output a chat hold has long
 * covered by default.
 */
export const MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE = 4_096;

export function managedVeniceHoldExpiresAt(ttlMs: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + ttlMs).toISOString();
}

// Reconciliation reasons the media spend gate files (media-spend-gate.ts).
export const MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON = "managed_venice_media_capture_failed";
export const MEDIA_RELEASE_FAILED_RECONCILIATION_REASON = "managed_venice_media_release_failed";

/**
 * Venice refused a chat, Anthropic or Responses request (or it never reached
 * Venice), and releasing its hold failed. The sweep releases the hold: the
 * user is never charged for a request Venice did not run.
 */
export const CHAT_RELEASE_FAILED_RECONCILIATION_REASON = "managed_venice_chat_release_failed";

/**
 * `pricingPolicy` on a usage row the sweep wrote when it captured a hold, and
 * on one the request path wrote when it charged the output it observed
 * because Venice's usage never arrived. Neither has Venice's token counts, so
 * the chat reconciliation cron must not re-cost them (re-costing zero tokens
 * would refund the whole charge).
 */
export const MANAGED_VENICE_SWEEP_CAPTURE_POLICY = "managed_venice_hold_sweep_capture";
export const MANAGED_VENICE_OBSERVED_OUTPUT_CAPTURE_POLICY = "managed_venice_observed_output_capture";

export function isManagedVeniceEstimatedCapture(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const policy = (metadata as Record<string, unknown>).pricingPolicy;
  return policy === MANAGED_VENICE_SWEEP_CAPTURE_POLICY || policy === MANAGED_VENICE_OBSERVED_OUTPUT_CAPTURE_POLICY;
}

function readMicroUsd(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function readObservedOutputTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * What a chat hold is charged when Venice answered but its usage never
 * arrived: the input estimate recorded on the hold plus the output that was
 * observed, at the output price recorded on the hold, never more than the
 * hold. Null for a hold that predates those records.
 */
export function observedOutputChargeMicroUsd(
  hold: { reserved_micro_usd: number | string; metadata?: Record<string, unknown> | null },
  observedOutputTokens: number
): number | null {
  const meta = hold.metadata ?? {};
  const input = readMicroUsd(meta.inputEstimateMicroUsd);
  const perMillion = readMicroUsd(meta.outputMicroUsdPerMillion);
  const reserved = readMicroUsd(hold.reserved_micro_usd);
  if (input === null || perMillion === null || reserved === null) return null;
  const output = calculateVeniceTokenCostMicroUsd(observedOutputTokens, perMillion);
  return Math.min(reserved, input + output);
}

/**
 * What a chat hold is charged when nothing recorded the output its request
 * delivered (the function died mid-request, or the hold predates observed
 * output): the sweep estimate recorded on the hold (input plus at most
 * MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE output tokens per choice),
 * else the pre-request estimate, never more than the hold.
 */
export function holdEstimateMicroUsd(hold: {
  reserved_micro_usd: number | string;
  estimated_cost_micro_usd?: number | string | null;
  metadata?: Record<string, unknown> | null;
}): number {
  const reserved = readMicroUsd(hold.reserved_micro_usd) ?? 0;
  const estimate =
    readMicroUsd(hold.metadata?.sweepEstimateMicroUsd) ?? readMicroUsd(hold.estimated_cost_micro_usd) ?? reserved;
  return Math.min(reserved, estimate);
}
