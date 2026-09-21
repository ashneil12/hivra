/**
 * Expo push sender — the mobile app's notification lane (iOS Phase 2).
 *
 * Reads the user's enabled tokens from `device_tokens` (see the
 * 20260716120000_mobile_device_tokens migration), fans the notification out via
 * expo-server-sdk with proper chunking, and handles both ticket-level and
 * receipt-level errors. `DeviceNotRegistered` prunes the token (enabled=false,
 * never deleted) so we stop paying for dead sends while a re-registration can
 * still revive the row.
 *
 * Contract for callers (instance reconcile, cron sweeps, API routes):
 *   - NEVER throws. Push is strictly additive telemetry beside existing email/
 *     status behavior; a push hiccup must never fail or change the caller's
 *     path. Errors are logged and folded into the returned summary.
 *   - No tokens registered is the COMMON case (web-only users) and returns a
 *     clean `skippedNoTokens` summary without touching Expo.
 *
 * Receipt honesty note: Expo recommends polling receipts ~15 minutes after
 * send; this module fetches them immediately after the tickets as a
 * best-effort pass (catches fast DeviceNotRegistered receipts). Receipts that
 * are still pending at that point are simply not acted on — a dead token that
 * slips through is pruned on the next send's ticket error instead. A delayed
 * receipt-sweeper cron is deliberately out of scope for v1.
 */

import "server-only";

import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "expo-push";

/** Re-exported so API routes can validate token shape without importing the SDK. */
export function isExpoPushToken(token: unknown): boolean {
  return typeof token === "string" && Expo.isExpoPushToken(token);
}

export interface MobilePushInput {
  userId: string;
  title: string;
  body?: string;
  /**
   * Deep link the app opens on tap, e.g. `hivra://chat/<instanceId>` or
   * `hivra://approval/<instanceId>`. Delivered as `data.url`.
   */
  url?: string;
  /** Extra data payload fields (merged after `url`). */
  data?: Record<string, unknown>;
}

export interface MobilePushSummary {
  /** Enabled tokens found for the user. */
  attempted: number;
  /** Tickets accepted by Expo (status 'ok'). */
  sent: number;
  /** Ticket- or transport-level failures. */
  failed: number;
  /** Tokens disabled because Expo reported DeviceNotRegistered. */
  pruned: number;
  /** True when the user has no enabled tokens (nothing was sent). */
  skippedNoTokens: boolean;
}

/**
 * Minimal Expo client surface this module uses — injectable so unit tests can
 * exercise chunking/ticket/receipt handling with a mocked transport.
 */
export interface ExpoPushTransport {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  chunkPushNotificationReceiptIds(receiptIds: string[]): string[][];
  getPushNotificationReceiptsAsync(
    receiptIds: string[]
  ): Promise<{ [id: string]: ExpoPushReceipt }>;
}

let defaultTransport: ExpoPushTransport | null = null;

function getTransport(): ExpoPushTransport {
  if (!defaultTransport) {
    defaultTransport = new Expo({
      accessToken: process.env.EXPO_PUSH_ACCESS_TOKEN?.trim() || undefined,
    });
  }
  return defaultTransport;
}

function emptySummary(skippedNoTokens: boolean): MobilePushSummary {
  return { attempted: 0, sent: 0, failed: 0, pruned: 0, skippedNoTokens };
}

function isDeviceNotRegistered(details: unknown): boolean {
  return Boolean(
    details &&
      typeof details === "object" &&
      (details as { error?: unknown }).error === "DeviceNotRegistered"
  );
}

async function pruneTokens(tokens: string[], userId: string): Promise<void> {
  if (tokens.length === 0 || !supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from("device_tokens")
    .update({ enabled: false })
    .in("expo_push_token", tokens);
  if (error) {
    log.warn("failed to prune dead expo push tokens", {
      source: LOG_SOURCE,
      failureType: "device_token_prune_failed",
      userId,
      tokenCount: tokens.length,
      errorMessage: error.message,
    });
  } else {
    log.info("pruned DeviceNotRegistered expo push tokens", {
      source: LOG_SOURCE,
      userId,
      tokenCount: tokens.length,
    });
  }
}

/**
 * Send one notification to every enabled device the user has registered.
 * Never throws; see the module docstring for the caller contract.
 */
export async function sendMobilePushToUser(
  input: MobilePushInput,
  opts?: { transport?: ExpoPushTransport }
): Promise<MobilePushSummary> {
  try {
    if (!supabaseAdmin) return emptySummary(true);

    const { data: rows, error } = await supabaseAdmin
      .from("device_tokens")
      .select("expo_push_token")
      .eq("user_id", input.userId)
      .eq("enabled", true);

    if (error) {
      log.warn("device token lookup failed; skipping push", {
        source: LOG_SOURCE,
        failureType: "device_token_lookup_failed",
        userId: input.userId,
        errorMessage: error.message,
      });
      return emptySummary(true);
    }

    const tokens = (rows ?? [])
      .map((row) => (row as { expo_push_token?: unknown }).expo_push_token)
      .filter((token): token is string => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) return emptySummary(true);

    const transport = opts?.transport ?? getTransport();
    const summary: MobilePushSummary = {
      attempted: tokens.length,
      sent: 0,
      failed: 0,
      pruned: 0,
      skippedNoTokens: false,
    };

    // One message per token (never the `to: string[]` form) so tickets map
    // back to tokens by index and DeviceNotRegistered can prune precisely.
    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      sound: "default" as const,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      data: {
        ...(input.url ? { url: input.url } : {}),
        ...(input.data ?? {}),
      },
    }));

    const deadTokens = new Set<string>();
    // Receipt id → token, so receipt-level DeviceNotRegistered can prune too.
    const tokenByReceiptId = new Map<string, string>();

    const chunks = transport.chunkPushNotifications(messages);
    let cursor = 0;
    for (const chunk of chunks) {
      const chunkTokens = tokens.slice(cursor, cursor + chunk.length);
      cursor += chunk.length;
      try {
        const tickets = await transport.sendPushNotificationsAsync(chunk);
        tickets.forEach((ticket, index) => {
          const token = chunkTokens[index];
          if (ticket.status === "ok") {
            summary.sent += 1;
            if (ticket.id && token) tokenByReceiptId.set(ticket.id, token);
            return;
          }
          summary.failed += 1;
          if (isDeviceNotRegistered(ticket.details) && token) deadTokens.add(token);
        });
      } catch (err) {
        summary.failed += chunk.length;
        log.warn("expo push chunk send failed", {
          source: LOG_SOURCE,
          failureType: "expo_push_chunk_failed",
          userId: input.userId,
          chunkSize: chunk.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Best-effort immediate receipt pass (see module docstring).
    const receiptIds = [...tokenByReceiptId.keys()];
    if (receiptIds.length > 0) {
      for (const idChunk of transport.chunkPushNotificationReceiptIds(receiptIds)) {
        try {
          const receipts = await transport.getPushNotificationReceiptsAsync(idChunk);
          for (const [receiptId, receipt] of Object.entries(receipts)) {
            if (receipt.status !== "error") continue;
            const token = tokenByReceiptId.get(receiptId);
            if (isDeviceNotRegistered(receipt.details) && token) deadTokens.add(token);
          }
        } catch (err) {
          // Receipts are advisory here — never fold into failed counts.
          log.warn("expo push receipt fetch failed (advisory only)", {
            source: LOG_SOURCE,
            failureType: "expo_push_receipts_failed",
            userId: input.userId,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (deadTokens.size > 0) {
      summary.pruned = deadTokens.size;
      await pruneTokens([...deadTokens], input.userId);
    }

    return summary;
  } catch (err) {
    log.warn("expo push send failed", {
      source: LOG_SOURCE,
      failureType: "expo_push_send_failed",
      userId: input.userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return emptySummary(false);
  }
}
