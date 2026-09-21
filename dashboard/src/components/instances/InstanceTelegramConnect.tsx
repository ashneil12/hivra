"use client";

// InstanceTelegramConnect — the Hermes-instance binding of the shared
// <TelegramConnect> flow. A Hermes instance runs Telegram as an in-process
// gateway connector configured by env; this wrapper maps the unified adapter
// onto the dashboard's /api/instances/[id]/integrations route.
//
// `beginConnect`  → POST { credentials: { token } } → route writes
//                    TELEGRAM_BOT_TOKEN only (no allowlist), restarting the
//                    gateway into pair mode. UI then shows the code step.
// `approveCode`   → POST { action: 'pairing-approve', credentials: { code } }
//                    → route runs `hermes pairing approve telegram <code>`
//                    inside the runtime container; gateway picks the approved
//                    id up live (no restart, no env write).
// `connectManual` → POST { credentials: { token, ownerId } } → route writes
//                    TELEGRAM_ALLOWED_USERS directly (pre-pairing-runtime
//                    fallback, hidden behind an "advanced" disclosure).

import { useMemo } from "react";

import { TelegramConnect, type TelegramConnectAdapter, type TelegramConnectStatus } from "@/components/channels/TelegramConnect";

// Bound every save round-trip client-side. The integrations route can hold the
// connection while it restarts the box's gateway; without a client deadline the
// fetch stays pending for the function's whole lifetime and the CONTINUE spinner
// reads as hung. AbortSignal.timeout fails the fetch with a TimeoutError we map
// to a friendly, retryable message so the spinner always resolves.
const SAVE_FETCH_TIMEOUT_MS = 25000;

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

const SAVE_TIMEOUT_MESSAGE =
  "Saving is taking longer than expected — your bot may still be restarting. Try again in a moment.";

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function InstanceTelegramConnect({
  instanceId,
  agentName,
  onStatusChange,
}: {
  instanceId: string;
  agentName?: string | null;
  onStatusChange?: (status: TelegramConnectStatus) => void;
}) {
  const adapter: TelegramConnectAdapter = useMemo(
    () => ({
      target: { kind: "hermes", id: instanceId },
      getStatus: async () => {
        try {
          const r = await fetch(`/api/instances/${instanceId}/integrations`, { cache: "no-store" });
          const j = await readJson(r);
          const data = (j?.data ?? null) as
            | {
                statuses?: Record<string, { configured?: boolean; presentFields?: string[] }>;
                configuredPlatforms?: string[];
              }
            | null;
          const telegram = data?.statuses?.Telegram;
          const configured = Boolean(
            telegram?.configured ||
              (Array.isArray(data?.configuredPlatforms) && data.configuredPlatforms.includes("Telegram")),
          );
          // The Hermes integrations route reads env *keys* only — it never
          // reports the gateway's bound user_ids (the PairingStore lives inside
          // the container) nor the bot's @username. The one liveness signal it
          // does expose is whether the owner allowlist (TELEGRAM_ALLOWED_USERS,
          // surfaced as the `ownerId` field) is present: that's only written
          // once the owner is paired/approved. So treat token-only as
          // pending — `connected` but not yet `active` — which renders the
          // amber "Connected (starting…)" state instead of a false green
          // "Bot is running" on a paste-but-not-approved bot. We still can't
          // surface the literal ownerId or botUsername from this route.
          const ownerBound = Array.isArray(telegram?.presentFields)
            ? telegram.presentFields.includes("ownerId")
            : false;
          return { connected: configured, active: configured && ownerBound };
        } catch {
          return { connected: false };
        }
      },
      beginConnect: async (botToken) => {
        try {
          const r = await fetch(`/api/instances/${instanceId}/integrations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Token-only payload → route writes TELEGRAM_BOT_TOKEN, clears any
            // pre-existing TELEGRAM_ALLOWED_USERS, restarts the gateway into
            // pair mode.
            body: JSON.stringify({ platform: "Telegram", credentials: { token: botToken } }),
            signal: AbortSignal.timeout(SAVE_FETCH_TIMEOUT_MS),
          });
          const j = await readJson(r);
          if (!r.ok || !j || j.success !== true) {
            return { ok: false, error: (j?.error as string) || `Couldn't connect (HTTP ${r.status})` };
          }
          return { ok: true, pairing: { kind: "code" }, error: null };
        } catch (e) {
          if (isAbortError(e)) return { ok: false, error: SAVE_TIMEOUT_MESSAGE };
          return { ok: false, error: (e as Error).message || "Network error reaching the instance" };
        }
      },
      approveCode: async (code) => {
        try {
          const r = await fetch(`/api/instances/${instanceId}/integrations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: "Telegram",
              action: "pairing-approve",
              credentials: { code },
            }),
            signal: AbortSignal.timeout(SAVE_FETCH_TIMEOUT_MS),
          });
          const j = await readJson(r);
          if (!r.ok || !j || j.success !== true) {
            return { ok: false, error: (j?.error as string) || `Couldn't approve (HTTP ${r.status})` };
          }
          return { ok: true, error: null };
        } catch (e) {
          if (isAbortError(e)) return { ok: false, error: SAVE_TIMEOUT_MESSAGE };
          return { ok: false, error: (e as Error).message || "Network error reaching the instance" };
        }
      },
      connectManual: async (botToken, ownerId) => {
        try {
          const r = await fetch(`/api/instances/${instanceId}/integrations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "Telegram", credentials: { token: botToken, ownerId } }),
            signal: AbortSignal.timeout(SAVE_FETCH_TIMEOUT_MS),
          });
          const j = await readJson(r);
          if (!r.ok || !j || j.success !== true) {
            return { ok: false, botUsername: null, error: (j?.error as string) || `Couldn't connect (HTTP ${r.status})` };
          }
          return { ok: true, botUsername: null, error: null };
        } catch (e) {
          if (isAbortError(e)) return { ok: false, botUsername: null, error: SAVE_TIMEOUT_MESSAGE };
          return { ok: false, botUsername: null, error: (e as Error).message || "Network error reaching the instance" };
        }
      },
      disconnect: async () => {
        try {
          await fetch(`/api/instances/${instanceId}/integrations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "Telegram", disconnect: true }),
          });
        } catch {
          // Best-effort.
        }
      },
    }),
    [instanceId],
  );

  return <TelegramConnect adapter={adapter} agentName={agentName} onStatusChange={onStatusChange} />;
}
