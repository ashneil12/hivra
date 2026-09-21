"use client";

// TelegramConnect — the ONE Telegram connect experience, shared by every agent
// kind. The flow is identical for the user no matter how the agent wires
// Telegram underneath; the per-kind difference is the adapter:
//
//   - Hermes lane (gateway): paste token → bot DMs the owner an 8-char one-time
//     code → owner pastes it here → `hermes pairing approve` adds them to the
//     gateway's approved list.
//   - Hivra lane (bux): paste token → dashboard renders a `t.me/<bot>?start=
//     <setup-token>` deeplink → first chat to tap binds as owner + token burns.
//
// Both replace the old browser `getUpdates` auto-capture path (brittle: webhook
// 409s, timeouts → cold-paste fallback) with the runtime's *native* pairing.
// A manual-id fallback is kept behind an "advanced" disclosure for version-skew
// against pre-pairing runtimes.

import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { Loader2, Send, ExternalLink, Check } from "lucide-react";

import {
  telegramGetMe,
  isValidBotTokenShape,
  isValidOwnerIdShape,
} from "@/lib/channels/telegram-api";
import { recordChannelConnection, type ChannelTargetKind } from "@/lib/channels/record-connection";
import { clientLog } from "@/lib/client/logger";

export interface TelegramConnectStatus {
  connected: boolean;
  active?: boolean;
  ownerId?: string | null;
}

/** Discriminated union — the adapter tells the UI which pairing UX to render
 *  after `beginConnect`. `deeplink` is one-tap (Hivra/bux native setup-token);
 *  `code` is paste-back (Hermes gateway native pairing). */
type TelegramPairingChallenge =
  | { kind: "deeplink"; url: string }
  | { kind: "code" };

export interface TelegramConnectAdapter {
  /** Who we're connecting — drives analytics + the persisted funnel signal. */
  target: { kind: ChannelTargetKind; id: string };
  getStatus(): Promise<TelegramConnectStatus>;
  /** Step 1. Validates+stores the token in pairing mode (no allowlist written).
   *  Returns the bot username and the pairing challenge to render. */
  beginConnect(botToken: string): Promise<{
    ok: boolean;
    botUsername?: string | null;
    pairing?: TelegramPairingChallenge;
    error: string | null;
  }>;
  /** Step 2 — `code` path only. Approves the code the bot DM'd the owner. */
  approveCode?(code: string): Promise<{ ok: boolean; error: string | null }>;
  /** Advanced fallback for pre-pairing runtimes: writes the owner allowlist
   *  directly, skipping the native pairing flow. */
  connectManual?(botToken: string, ownerId: string): Promise<{
    ok: boolean;
    botUsername?: string | null;
    error: string | null;
  }>;
  disconnect(): Promise<void>;
}

// Instrumentation must never make the connect flow throw.
function captureChannelEvent(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort only.
  }
}

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--etched-border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--ink-black)",
  fontSize: 13,
  fontFamily: "var(--font-mono), monospace",
  outline: "none",
};
const primaryBtn: React.CSSProperties = {
  border: "1px solid var(--ink-black)",
  background: "var(--ink-black)",
  color: "var(--bg-surface)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 800,
  padding: "11px 18px",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  justifySelf: "start",
};

type Step = "token" | "pair-deeplink" | "pair-code" | "connecting";

/** ~5 minutes of polling (every 2s) before we surface the manual fallback —
 *  long enough that a user opening their phone, hunting for the chat, and
 *  tapping Start won't time out. */
const STATUS_POLL_INTERVAL_MS = 2000;
const STATUS_POLL_TIMEOUT_MS = 5 * 60_000;

export function TelegramConnect({
  adapter,
  agentName,
  onStatusChange,
}: {
  adapter: TelegramConnectAdapter;
  agentName?: string | null;
  /** Notified whenever the connection status is (re)resolved — lets a host
   *  surface (e.g. the instance page) suppress its own activation nudges once
   *  the bot is connected, and re-enable them on disconnect. */
  onStatusChange?: (status: TelegramConnectStatus) => void;
}) {
  const [status, setStatus] = useState<TelegramConnectStatus | null>(null);
  const [step, setStep] = useState<Step>("token");
  const [botToken, setBotToken] = useState("");
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [connectedUsername, setConnectedUsername] = useState<string | null>(null);
  const [deeplinkUrl, setDeeplinkUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pollAbortRef = useRef<AbortController | null>(null);
  // Synchronous re-entrancy lock for the connect call. React state (`busy`)
  // commits a render too late to guard two near-simultaneous invocations.
  const connectingRef = useRef(false);
  // Becomes true once verifyToken has run at least once. Used to reveal the
  // advanced manual-id fallback on the token step after a failed beginConnect
  // (e.g. the box is on an old bux image with no setup-token support).
  const [tokenAttempted, setTokenAttempted] = useState(false);

  const refresh = useCallback(() => {
    void adapter.getStatus().then(setStatus);
  }, [adapter]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => () => pollAbortRef.current?.abort(), []);

  // Surface every resolved status to an optional host (see onStatusChange) so it
  // can keep its own connection-aware UI (nudges, banners) in sync in-session.
  useEffect(() => {
    if (status) onStatusChange?.(status);
  }, [status, onStatusChange]);

  const channelProps = useCallback(
    () => ({ channel: "telegram", box_id: adapter.target.id, target_kind: adapter.target.kind }),
    [adapter.target.id, adapter.target.kind],
  );

  /** Once-only successful-bind handler: persist funnel signal, fire analytics,
   *  flip the UI to the connected card. */
  const handlePairingSuccess = useCallback(
    (ownerIdHint?: string | null) => {
      captureChannelEvent("channel_connected", channelProps());
      setStatus((prev) => ({
        connected: true,
        active: prev?.active ?? false,
        ownerId: ownerIdHint ?? prev?.ownerId ?? null,
      }));
      setConnectedUsername(botUsername);
      void recordChannelConnection({
        channel: "telegram",
        targetKind: adapter.target.kind,
        targetId: adapter.target.id,
      }).catch((err) => {
        clientLog.warn(
          "telegram channel connection record failed",
          { source: "telegram-connect", targetKind: adapter.target.kind },
          err,
        );
      });
      setBotToken("");
      setCode("");
      setOwnerId("");
      refresh();
    },
    [adapter.target.id, adapter.target.kind, botUsername, channelProps, refresh],
  );

  /** Long-poll getStatus until the runtime reports the chat is bound. Used by
   *  the deeplink flow: the dashboard never sees the `/start <token>` directly;
   *  the bind happens on the box and we wait for it to show up in status. */
  const pollUntilBound = useCallback(
    (signal: AbortSignal) => {
      const startedAt = Date.now();
      const tick = async () => {
        if (signal.aborted) return;
        try {
          const s = await adapter.getStatus();
          setStatus(s);
          if (s.connected) {
            captureChannelEvent("channel_paired", { ...channelProps(), method: "deeplink" });
            handlePairingSuccess(s.ownerId ?? null);
            return;
          }
        } catch {
          // Best-effort — keep polling.
        }
        if (Date.now() - startedAt > STATUS_POLL_TIMEOUT_MS) {
          setNotice("Still waiting on Telegram. Try tapping Start again, or use the advanced manual entry below.");
          setManualOpen(true);
          return;
        }
        setTimeout(tick, STATUS_POLL_INTERVAL_MS);
      };
      void tick();
    },
    [adapter, channelProps, handlePairingSuccess],
  );

  /** Step 1: validate the BotFather token + ask the adapter to start pairing. */
  const verifyToken = useCallback(async () => {
    if (busy) return;
    const token = botToken.trim();
    setError(null);
    setNotice(null);
    if (!isValidBotTokenShape(token)) {
      setError("That doesn't look like a bot token. Paste the whole token BotFather gave you.");
      return;
    }
    setBusy(true);
    setTokenAttempted(true);
    captureChannelEvent("channel_connect_started", channelProps());
    try {
      const info = await telegramGetMe(token);
      if (!info.ok) {
        setError(info.error);
        return;
      }
      setBotUsername(info.username);
      // The box restarts its gateway during beginConnect — the round-trip can
      // take many seconds. Show progress so a slow (but healthy) connect reads
      // as "working", not "hung". Cleared as soon as beginConnect resolves.
      setNotice("Saving your bot and restarting the connection… this can take up to a minute.");
      const begin = await adapter.beginConnect(token);
      setNotice(null);
      if (!begin.ok || !begin.pairing) {
        captureChannelEvent("channel_connect_failed", channelProps());
        setError(begin.error || "Couldn't start the pairing flow. Try again.");
        return;
      }
      if (begin.pairing.kind === "deeplink") {
        setDeeplinkUrl(begin.pairing.url);
        setStep("pair-deeplink");
        pollAbortRef.current?.abort();
        const ac = new AbortController();
        pollAbortRef.current = ac;
        pollUntilBound(ac.signal);
      } else {
        setStep("pair-code");
      }
    } finally {
      setBusy(false);
    }
  }, [adapter, botToken, busy, channelProps, pollUntilBound]);

  /** Step 2 (code path): submit the code the bot DM'd to the owner. */
  const submitCode = useCallback(async () => {
    if (busy || connectingRef.current) return;
    const trimmed = code.trim().toUpperCase();
    setError(null);
    setNotice(null);
    if (!/^[A-Z0-9]{8}$/.test(trimmed)) {
      setError("Codes are 8 letters/numbers. Check the message your bot sent and try again.");
      return;
    }
    if (!adapter.approveCode) {
      setError("This agent doesn't support code pairing.");
      return;
    }
    connectingRef.current = true;
    setBusy(true);
    setStep("connecting");
    try {
      const res = await adapter.approveCode(trimmed);
      if (!res.ok) {
        captureChannelEvent("channel_connect_failed", channelProps());
        setError(res.error || "Couldn't approve that code. It may have expired — message your bot to get a fresh one.");
        setStep("pair-code");
        return;
      }
      captureChannelEvent("channel_paired", { ...channelProps(), method: "code" });
      handlePairingSuccess();
    } finally {
      setBusy(false);
      connectingRef.current = false;
    }
  }, [adapter, busy, channelProps, code, handlePairingSuccess]);

  /** Advanced fallback: write the owner allowlist directly (pre-pairing
   *  runtimes only). */
  const manualConnect = useCallback(async () => {
    if (busy || connectingRef.current) return;
    if (!adapter.connectManual) {
      setError("Manual id entry isn't supported here. Use the pairing flow above.");
      return;
    }
    const owner = ownerId.trim();
    const token = botToken.trim();
    if (!isValidOwnerIdShape(owner)) {
      setError("Enter your numeric Telegram id (digits only).");
      return;
    }
    if (!isValidBotTokenShape(token)) {
      setError("The bot token looks wrong — start over and re-paste it.");
      setStep("token");
      return;
    }
    connectingRef.current = true;
    setBusy(true);
    setStep("connecting");
    captureChannelEvent("channel_owner_captured", { ...channelProps(), method: "manual" });
    try {
      const res = await adapter.connectManual(token, owner);
      if (!res.ok) {
        captureChannelEvent("channel_connect_failed", channelProps());
        setError(res.error || "Couldn't connect Telegram. Try again.");
        setStep("pair-code");
        return;
      }
      if (res.botUsername) setBotUsername(res.botUsername);
      handlePairingSuccess(owner);
    } finally {
      setBusy(false);
      connectingRef.current = false;
    }
  }, [adapter, botToken, busy, channelProps, handlePairingSuccess, ownerId]);

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    pollAbortRef.current?.abort();
    await adapter.disconnect();
    setConnectedUsername(null);
    setStep("token");
    setBotToken("");
    setCode("");
    setOwnerId("");
    setBotUsername(null);
    setDeeplinkUrl(null);
    setManualOpen(false);
    setTokenAttempted(false);
    refresh();
    setBusy(false);
  }

  const connected = Boolean(status?.connected);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "36px 20px", height: "100%", overflowY: "auto" }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 42,
          height: 42,
          border: "1px solid var(--gold-leaf)",
          color: "var(--gold-leaf)",
          marginBottom: 16,
        }}
      >
        <Send size={18} />
      </div>
      <h2
        className="serif"
        style={{
          fontSize: "clamp(1.7rem, 5vw, 2.3rem)",
          fontWeight: 400,
          color: "var(--ink-black)",
          margin: "0 0 10px",
          lineHeight: 1.1,
        }}
      >
        Chat from Telegram
      </h2>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65, margin: "0 0 24px" }}>
        Connect a Telegram bot and message {agentName?.trim() || "your agent"} from your phone — and get pinged
        the moment work is done. Takes about a minute.
      </p>

      {error ? (
        <div
          style={{
            border: "1px solid #c0392b",
            background: "rgba(192,57,43,0.08)",
            color: "#e06c5a",
            fontSize: 13,
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          style={{
            border: "1px solid var(--etched-border)",
            background: "rgba(255,255,255,0.04)",
            color: "var(--text-secondary)",
            fontSize: 13,
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          {notice}
        </div>
      ) : null}

      {status === null ? (
        <div style={{ padding: 30, textAlign: "center" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
        </div>
      ) : connected ? (
        <ConnectedCard
          status={status}
          connectedUsername={connectedUsername}
          agentName={agentName}
          busy={busy}
          onDisconnect={() => void disconnect()}
        />
      ) : step === "token" ? (
        <TokenStep
          botToken={botToken}
          setBotToken={setBotToken}
          busy={busy}
          onContinue={() => void verifyToken()}
        />
      ) : step === "pair-deeplink" ? (
        <DeeplinkPairingStep
          botUsername={botUsername}
          deeplinkUrl={deeplinkUrl}
        />
      ) : (
        <CodePairingStep
          botUsername={botUsername}
          code={code}
          setCode={setCode}
          busy={busy || step === "connecting"}
          onSubmit={() => void submitCode()}
        />
      )}

      {!connected && status !== null && (step !== "token" || tokenAttempted) ? (
        <ManualFallback
          open={manualOpen}
          setOpen={setManualOpen}
          available={Boolean(adapter.connectManual)}
          ownerId={ownerId}
          setOwnerId={setOwnerId}
          busy={busy || step === "connecting"}
          onConnect={() => void manualConnect()}
        />
      ) : null}
    </div>
  );
}

function ConnectedCard({
  status,
  connectedUsername,
  agentName,
  busy,
  onDisconnect,
}: {
  status: TelegramConnectStatus;
  connectedUsername: string | null;
  agentName?: string | null;
  busy: boolean;
  onDisconnect: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: 20,
        display: "grid",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: status.active === false ? "var(--text-muted)" : "#22c55e",
          }}
        />
        <strong className="serif" style={{ fontSize: 18, fontWeight: 400, color: "var(--ink-black)" }}>
          {status.active === false ? "Connected (starting…)" : "Bot is running"}
        </strong>
      </div>
      <div className="mono" style={{ ...mono, opacity: 0.7 }}>
        {connectedUsername ? `@${connectedUsername}` : "Telegram bot"}
        {status.ownerId ? ` · owner ${status.ownerId}` : ""}
      </div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
        Open Telegram, find your bot{connectedUsername ? ` (@${connectedUsername})` : ""}, and send it a message
        — it reaches {agentName?.trim() || "your agent"}.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {connectedUsername ? (
          <a
            href={`https://t.me/${connectedUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{
              border: "1px solid var(--ink-black)",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontWeight: 800,
              padding: "9px 14px",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <ExternalLink size={13} /> Open in Telegram
          </a>
        ) : null}
        <button
          type="button"
          onClick={onDisconnect}
          disabled={busy}
          className="mono"
          style={{
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "#e06c5a",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
            padding: "9px 14px",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : "Disconnect"}
        </button>
      </div>
    </div>
  );
}

function TokenStep({
  botToken,
  setBotToken,
  busy,
  onContinue,
}: {
  botToken: string;
  setBotToken: (v: string) => void;
  busy: boolean;
  onContinue: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65 }}>
        In Telegram, message{" "}
        <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)" }}>
          @BotFather
        </a>{" "}
        →{" "}
        <span className="mono" style={{ ...mono, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
          /newbot
        </span>{" "}
        → paste the token it gives you. That&apos;s the only thing you copy.
      </div>
      <div>
        <div className="mono" style={{ ...mono, marginBottom: 6 }}>
          Bot token
        </div>
        <input
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onContinue();
          }}
          placeholder="123456789:ABCdef…"
          style={inputStyle}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <button
        type="button"
        onClick={onContinue}
        disabled={busy || !botToken.trim()}
        className="mono"
        style={{ ...primaryBtn, cursor: busy || !botToken.trim() ? "default" : "pointer", opacity: busy || !botToken.trim() ? 0.5 : 1 }}
      >
        {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />} Continue
      </button>
    </div>
  );
}

function DeeplinkPairingStep({
  botUsername,
  deeplinkUrl,
}: {
  botUsername: string | null;
  deeplinkUrl: string | null;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <div className="mono" style={{ ...mono, opacity: 0.8 }}>
        {botUsername ? `@${botUsername}` : "Your bot"} · last step
      </div>
      <p style={{ fontSize: 13.5, color: "var(--ink-black)", lineHeight: 1.6, margin: 0 }}>
        Open your bot and tap <strong>Start</strong>. Only the first chat to tap binds — anyone else who finds
        the bot is silently ignored.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {deeplinkUrl ? (
          <a
            href={deeplinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{
              border: "1px solid var(--ink-black)",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontWeight: 800,
              padding: "10px 16px",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <ExternalLink size={13} /> Open {botUsername ? `@${botUsername}` : "bot"} & tap Start
          </a>
        ) : null}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text-secondary)" }}>
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
          Waiting for you to tap Start…
        </span>
      </div>
    </div>
  );
}

function CodePairingStep({
  botUsername,
  code,
  setCode,
  busy,
  onSubmit,
}: {
  botUsername: string | null;
  code: string;
  setCode: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <div className="mono" style={{ ...mono, opacity: 0.8 }}>
        {botUsername ? `@${botUsername}` : "Your bot"} · last step
      </div>
      <p style={{ fontSize: 13.5, color: "var(--ink-black)", lineHeight: 1.6, margin: 0 }}>
        Open your bot and send it any message. It&apos;ll reply with an <strong>8-character code</strong> — paste it
        here to authorize yourself. Anyone else who messages the bot gets a code too, but only you can approve
        one.
      </p>
      <div>
        <div className="mono" style={{ ...mono, marginBottom: 6 }}>
          Code
        </div>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="ABCD2345"
          maxLength={12}
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, letterSpacing: "0.18em", textTransform: "uppercase" }}
        />
      </div>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || !code.trim()}
        className="mono"
        style={{ ...primaryBtn, cursor: busy || !code.trim() ? "default" : "pointer", opacity: busy || !code.trim() ? 0.5 : 1 }}
      >
        {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} Approve code
      </button>
    </div>
  );
}

function ManualFallback({
  open,
  setOpen,
  available,
  ownerId,
  setOwnerId,
  busy,
  onConnect,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  available: boolean;
  ownerId: string;
  setOwnerId: (v: string) => void;
  busy: boolean;
  onConnect: () => void;
}) {
  if (!available) return null;
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mono"
          style={{
            ...mono,
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            justifySelf: "start",
            padding: 0,
            textTransform: "none",
            letterSpacing: 0,
            fontSize: 12,
            textDecoration: "underline",
            opacity: 1,
          }}
        >
          Advanced: paste your Telegram id directly (older agents only)
        </button>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            Skips the pairing handshake and writes your numeric id straight into the allowlist. Use this only if
            the pairing flow doesn&apos;t work on this agent.
          </div>
          <div className="mono" style={{ ...mono, marginBottom: 0 }}>
            Your Telegram user id
          </div>
          <input
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConnect();
            }}
            placeholder="123456789"
            inputMode="numeric"
            style={inputStyle}
          />
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            Get it from{" "}
            <a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)" }}>
              @userinfobot
            </a>{" "}
            (tap Start — it replies with your numeric id).
          </div>
          <button
            type="button"
            onClick={onConnect}
            disabled={busy || !ownerId.trim()}
            className="mono"
            style={{ ...primaryBtn, cursor: busy || !ownerId.trim() ? "default" : "pointer", opacity: busy || !ownerId.trim() ? 0.5 : 1 }}
          >
            {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} Connect Telegram
          </button>
        </div>
      )}
    </div>
  );
}
