"use client";

// HivraTelegram — the Hivra-box binding of the shared <TelegramConnect> flow.
// A Hivra box runs the user's bot as the upstream `browser-use/bux` `bux-tg`
// systemd service. This wrapper maps the unified adapter onto the box's
// token-gated /api/telegram/* endpoints:
//
//   `beginConnect` → POST /api/telegram/connect with the token only → the box
//                    generates a TG_SETUP_TOKEN, writes /etc/bux/tg.env via the
//                    scoped sudoers helper, and returns the setupToken + bot
//                    @username. The UI renders a `t.me/<bot>?start=<token>`
//                    deeplink; whoever taps it first binds (single-use, the
//                    token burns on the box after bind).
//   `connectManual` → POST /api/telegram/connect with `ownerId` → bypasses
//                     pairing and pre-binds the owner's TG user_id (advanced
//                     fallback for old bux images that lack setup-token).
//   `disconnect`   → POST /api/telegram/disconnect → stops bux-tg, wipes
//                    tg.env.
//
// No `approveCode` capability: bux's native auth is the deeplink, not codes.

import { useMemo } from "react";

import { TelegramConnect, type TelegramConnectAdapter } from "@/components/channels/TelegramConnect";
import { telegramStatus, telegramConnect, telegramDisconnect } from "@/lib/hivra/agent-api";
import { telegramStartLink } from "@/lib/channels/telegram-api";

export function HivraTelegram({
  boxUrl,
  token,
  agentName,
  boxId,
}: {
  boxUrl: string;
  token?: string | null;
  agentName?: string | null;
  /** Stable agent/box id for analytics + the funnel signal (falls back to boxUrl). */
  boxId?: string | null;
}) {
  const adapter: TelegramConnectAdapter = useMemo(
    () => ({
      target: { kind: "hivra", id: boxId ?? boxUrl },
      getStatus: () => telegramStatus(boxUrl, token),
      beginConnect: async (botToken) => {
        const res = await telegramConnect(boxUrl, botToken, null, token);
        if (!res.ok) {
          return { ok: false, error: res.error || "Couldn't connect Telegram. Try again." };
        }
        if (!res.botUsername || !res.setupToken) {
          // The box didn't supply a setupToken — it's running a pre-pairing
          // bux image. Surface a clear error so the user falls back to the
          // advanced manual-id path.
          return {
            ok: false,
            botUsername: res.botUsername ?? null,
            error: "This box doesn't support the pairing deeplink yet. Use the advanced manual id option below.",
          };
        }
        return {
          ok: true,
          botUsername: res.botUsername,
          pairing: { kind: "deeplink", url: telegramStartLink(res.botUsername, res.setupToken) },
          error: null,
        };
      },
      connectManual: async (botToken, ownerId) => {
        const res = await telegramConnect(boxUrl, botToken, ownerId, token);
        return {
          ok: res.ok,
          botUsername: res.botUsername ?? null,
          error: res.error,
        };
      },
      disconnect: () => telegramDisconnect(boxUrl, token),
    }),
    [boxUrl, token, boxId],
  );

  return <TelegramConnect adapter={adapter} agentName={agentName} />;
}
