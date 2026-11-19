import "server-only";

import {
  disarmTelegramForWake,
  markTelegramPendingArm,
  readTelegramSleepContext,
  rearmTelegramAfterFailedWake,
  releaseTelegramWakeOnDelete,
  settleTelegramAfterWake,
  telegramCoverageFor,
  telegramWebhookIsClear,
  type TelegramDisarm,
  type TelegramSleepContext,
} from "../../telegram-wake/lifecycle";
import { telegramCoverageBlockers, type TelegramProbeFacts } from "../../telegram-wake/coverage";
import { TELEGRAM_CHANNEL_SPEC } from "../registry";

/**
 * Telegram as a channel wake adapter. A thin wrapper over the telegram-wake
 * module, which keeps its own table, switches and sweep: nothing here changes
 * what Telegram wake does. The framework calls these instead of the module
 * directly, so a sleep or wake that sees only Telegram behaves exactly as
 * before.
 *
 * Arming happens later, from the Telegram sweep, once the nap is 20 s old:
 * Telegram queues updates for a newly set webhook, so the gap loses nothing.
 * That is the only channel where arming late is safe.
 */
export const TELEGRAM_ADAPTER = {
  ...TELEGRAM_CHANNEL_SPEC,
  readSleepContext: readTelegramSleepContext,
  /** The legacy rule: every live channel, when Telegram covers all of them, else none. */
  coverageFor: telegramCoverageFor,
  /**
   * The union rule: whether Telegram itself is covered, leaving the other live
   * channels to their own adapters.
   */
  coversItself(
    context: TelegramSleepContext | null,
    probe: { liveChannels: readonly string[]; telegram?: TelegramProbeFacts | null } | null,
    nowMs: number,
  ): boolean {
    if (!context || !probe || !probe.liveChannels.includes(context.tag ?? TELEGRAM_CHANNEL_SPEC.probeTag)) return false;
    const blockers = telegramCoverageBlockers({
      configured: true,
      hostAllowed: context.hostAllowed,
      row: {
        enabled: context.row.enabled,
        tokenFp: context.row.token_fp,
        hasToken: Boolean(context.row.token_enc),
        blockedUntil: context.row.blocked_until,
      },
      probe,
      nowMs,
      ...(context.tag === undefined ? {} : { tag: context.tag }),
    });
    return blockers.every((reason) => reason === "other_channel");
  },
  verifyClear: telegramWebhookIsClear,
  /** After a covered sleep: the Telegram sweep arms it later. */
  armLater: markTelegramPendingArm,
  disarmForWake: disarmTelegramForWake,
  rearmAfterFailedWake: rearmTelegramAfterFailedWake,
  settleAfterWake: settleTelegramAfterWake,
  release: releaseTelegramWakeOnDelete,
} as const;

export type { TelegramDisarm, TelegramSleepContext };
