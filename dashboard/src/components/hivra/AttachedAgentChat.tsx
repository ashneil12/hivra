"use client";

// The computer page's Chat tab for an agent added to it (design 5.4, 5.8).
// The owner's browser talks to the agent's own sandboxed chat instance through
// the computer's gateway (/agents/<installation-id>/), with the computer's own
// sign-in. Everything that instance answers is the agent's, so its sign-in
// link opens only on the OpenAI or ChatGPT sign-in hosts (T28).

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { LoadingState } from "@/components/ui/LoadingState";
import { HivraChat } from "@/components/hivra/HivraChat";
import { HivraLogin } from "@/components/hivra/HivraLogin";
import { useChatReadiness } from "@/components/hivra/useChatReadiness";
import { ATTACH_RUNTIME_NAME } from "@/lib/agent-computers/attach-plan";
import { fetchAttachGate } from "@/lib/agent-computers/attach-client";
import { ATTACHED_AGENTS_CHANGED_EVENT, type AttachedAgentChatTarget } from "@/lib/agent-computers/attached-agent-surface";
import type { HivraAgent } from "@/lib/hivra/agent-api";

/**
 * The agent added to this computer, once it is ready to chat, or null. Read
 * from the computer's attach gate (where attach is not offered the gate is a
 * 404 and this stays null), and again whenever Manage announces a change.
 */
export function useAttachedAgentChat(agent: Pick<HivraAgent, "id" | "type" | "status"> | null, id: string): AttachedAgentChatTarget | null {
  const eligible = Boolean(agent && agent.id === id && agent.type === "linux-desktop" && agent.status === "running");
  const [version, setVersion] = useState(0);
  const [read, setRead] = useState<{ id: string; value: AttachedAgentChatTarget | null } | null>(null);
  useEffect(() => {
    const changed = () => setVersion((value) => value + 1);
    window.addEventListener(ATTACHED_AGENTS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ATTACHED_AGENTS_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    if (!eligible) return;
    let alive = true;
    void fetchAttachGate(id).then((result) => {
      if (!alive) return;
      const ready = result.state === "ready"
        ? result.gate.attachments.find((attachment) => attachment.phase === "attached" && attachment.installationId)
        : undefined;
      setRead({ id, value: ready?.installationId
        ? { computerId: id, installationId: ready.installationId, agentName: ready.agentName || ATTACH_RUNTIME_NAME } : null });
    });
    return () => { alive = false; };
  }, [eligible, id, version]);
  return eligible && read?.id === id ? read.value : null;
}

/** The attached agent's chat, under its computer's gateway origin. */
export function attachedChatBase(chatUrl: string, installationId: string): string {
  return `${chatUrl.replace(/\/$/, "")}/agents/${encodeURIComponent(installationId)}`;
}

export function AttachedAgentChat({ computerId, computerName, chatUrl, installationId, token, agentName }: {
  computerId: string;
  computerName: string;
  chatUrl: string;
  installationId: string;
  token: string | null | undefined;
  agentName: string;
}) {
  const [reload, setReload] = useState(0);
  const base = attachedChatBase(chatUrl, installationId);
  const readiness = useChatReadiness(`${computerId}:${installationId}`, "running", base, "codex", token, reload);
  if (readiness === null) return <LoadingState compact label={`Checking ${ATTACH_RUNTIME_NAME}…`} />;
  if (readiness === "unavailable" || readiness === "upgrade_required") {
    return (
      <div style={{ padding: "clamp(32px, 6vw, 56px) clamp(16px, 4vw, 40px)", textAlign: "center", color: "var(--text-muted)" }} role="status">
        <div className="serif" style={{ fontSize: 22, color: "var(--ink-black)", marginBottom: 8 }}>{ATTACH_RUNTIME_NAME} isn&apos;t reachable right now</div>
        <p style={{ fontSize: 13, maxWidth: 440, margin: "0 auto 16px", lineHeight: 1.6 }}>
          It runs on {computerName} as its own user. If the computer just restarted, it may still be starting. Its work and your files are unchanged.
        </p>
        <button type="button" onClick={() => setReload((value) => value + 1)}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 40, padding: "9px 14px", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)", cursor: "pointer" }}>
          <RefreshCw size={13} aria-hidden /> Check again
        </button>
      </div>
    );
  }
  if (readiness === "sign_in_required") {
    return <HivraLogin boxUrl={base} token={token} agentKind="codex" productName={ATTACH_RUNTIME_NAME} displayName={agentName}
      untrustedLinks onDone={() => setReload((value) => value + 1)} />;
  }
  return <HivraChat key={`${computerId}:${installationId}:chat`} boxUrl={base} token={token} agentName={agentName} agentKind="codex"
    storageKey={`${computerId}:agent:${installationId}`} />;
}
