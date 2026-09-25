// Settles one streamed chat completion that Venice answered 200, for the
// chat completions and Anthropic routes: once, however the stream ends.
//
//   * Venice's usage frame arrived: capture the exact cost (an overage past
//     the hold is debited on top).
//   * It never arrived (the stream hit the route's deadline or broke, or
//     Venice left the frame out): capture the input estimate plus the output
//     read from Venice, with anything past the hold debited as an overage
//     (captureManagedVeniceObservedOutput). The rest of the hold goes back to
//     the user at once.
//   * Writing the charge failed: file a reconciliation item carrying the
//     number, and the hourly stale-hold sweep captures it.
// A 200 stream is never released: Venice generated, and billed Hivra, for it.
//
// When the client disconnects, the routes stop forwarding but keep reading
// Venice until its usage frame (or the deadline), so the request is charged
// what Venice billed, hidden reasoning included (security review 2026-09, #167
// second review). settleAfterResponse keeps the function alive for that.

import { after } from "next/server";

import type { ManagedVeniceWalletType } from "@/lib/billing/managed-venice-wallets";
import { log } from "@/lib/logger";
import type { VenicePricingMap } from "./cost-estimator";
import {
  captureManagedVeniceChatUsage,
  captureManagedVeniceObservedOutput,
  managedVeniceUsageCostMicroUsd,
  markManagedVeniceReconciliationRequired,
} from "./proxy-settlement";
import { createManagedVeniceOutputMeter, type ManagedVeniceOutputMeter } from "./stream-output-meter";

export type ManagedVeniceStreamOutcome = "completed" | "upstream_failed" | "client_cancelled" | "deadline";

export interface ManagedVeniceStreamSettlement {
  /** Feed every frame forwarded to the client through this. */
  meter: ManagedVeniceOutputMeter;
  /** Keep the latest usage block a frame carried. */
  observeUsage(usage: unknown): void;
  /** Whether Venice's usage block has arrived. */
  hasUsage(): boolean;
  /**
   * Settle exactly once. Resolves to the error of a failed exact capture (so a
   * completed stream can still fail), otherwise null. Never rejects.
   */
  settle(outcome: ManagedVeniceStreamOutcome): Promise<unknown>;
}

export function createManagedVeniceStreamSettlement(params: {
  userId: string;
  proxyKeyId: string;
  referenceId: string;
  walletType: ManagedVeniceWalletType;
  model: string;
  upstreamStatus: number;
  pricingMap?: VenicePricingMap;
  source: string;
  route: string;
  reasons: {
    /** Filed when charging the observed output fails. */
    usageMissing: (outcome: ManagedVeniceStreamOutcome) => string;
    /** Filed when capturing Venice's reported usage fails. */
    captureFailed: (outcome: ManagedVeniceStreamOutcome) => string;
  };
}): ManagedVeniceStreamSettlement {
  const meter = createManagedVeniceOutputMeter();
  const identity = { userId: params.userId, proxyKeyId: params.proxyKeyId, referenceId: params.referenceId };
  let usage: unknown = null;
  let settlement: Promise<unknown> | null = null;

  async function fileCaptureFailure(outcome: ManagedVeniceStreamOutcome) {
    const reason = params.reasons.captureFailed(outcome);
    try {
      await markManagedVeniceReconciliationRequired({
        ...identity,
        reason,
        // Venice answered 200 and the hold still covers the spend: keep the
        // key usable while the sweep captures the reported usage.
        pauseKey: false,
        metadata: {
          model: params.model,
          upstreamStatus: params.upstreamStatus,
          cause: "settlement_failed",
          streamOutcome: outcome,
          usageCostMicroUsd: managedVeniceUsageCostMicroUsd({
            model: params.model,
            usage,
            pricingMap: params.pricingMap,
          }),
          observedOutputTokens: meter.outputTokens(),
        },
      });
    } catch (error) {
      log.error("Managed Venice stream could not file its reconciliation item", error, {
        source: params.source,
        route: params.route,
        failureType: "managed_venice_stream_reconciliation_write_failed",
        ...identity,
        reason,
      });
    }
  }

  return {
    meter,
    observeUsage(next) {
      if (next) usage = next;
    },
    hasUsage() {
      return Boolean(usage);
    },
    settle(outcome) {
      settlement ??= (async () => {
        try {
          if (usage) {
            try {
              await captureManagedVeniceChatUsage({
                ...identity,
                walletType: params.walletType,
                model: params.model,
                upstreamStatus: params.upstreamStatus,
                usage,
                pricingMap: params.pricingMap,
              });
              return null;
            } catch (error) {
              // Our settlement code threw on an otherwise-successful stream.
              // That is ours to reconcile, not the user's to be denied over.
              await fileCaptureFailure(outcome);
              return error;
            }
          }
          await captureManagedVeniceObservedOutput({
            ...identity,
            model: params.model,
            upstreamStatus: params.upstreamStatus,
            observedOutputTokens: meter.outputTokens(),
            cause: outcome,
            reconciliationReason: params.reasons.usageMissing(outcome),
            source: params.source,
          });
          return null;
        } catch (error) {
          // Neither path above throws by design; never let settlement break
          // the stream the client is reading.
          log.error("Managed Venice stream settlement failed unexpectedly", error, {
            source: params.source,
            route: params.route,
            failureType: "managed_venice_stream_settlement_crashed",
            ...identity,
          });
          return null;
        }
      })();
      return settlement;
    },
  };
}

/**
 * The route deadline: aborts the upstream fetch and the stream reader at
 * `ms`, so the route settles what was streamed before the platform kills it.
 */
export function managedVeniceStreamDeadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Keep the function running until `settled` resolves, even after the client
 * has gone (next/server `after`, which Vercel runs with waitUntil, bounded by
 * the route's maxDuration). A route whose client disconnects keeps reading
 * Venice to the usage frame; without this the platform may stop the function
 * before that read, and the settlement, finish.
 */
export function settleAfterResponse(
  settled: Promise<unknown>,
  context: { source: string; route: string; referenceId: string }
): void {
  try {
    after(settled);
  } catch (error) {
    // Only outside a request scope (a unit test calling the handler). The
    // settlement still runs; nothing keeps the function alive for it.
    log.warn("Managed Venice settlement could not be kept alive past the response", {
      ...context,
      failureType: "managed_venice_settlement_after_unavailable",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
