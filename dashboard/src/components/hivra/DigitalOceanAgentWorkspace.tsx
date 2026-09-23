"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { ManagedSessionChat } from "@/components/hivra/ManagedSessionChat";
import { getManagedSession } from "@/lib/hivra/managed-session-client";
import type { ManagedSessionDto } from "@/lib/hivra/managed-session-contracts";

/** Agent page body for a DigitalOcean Managed Agents session. */
export function DigitalOceanAgentWorkspace({ agentId, onDeleted }: { agentId: string; onDeleted: () => void }) {
  const [session, setSession] = useState<ManagedSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => { onDeletedRef.current = onDeleted; }, [onDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    // Reconcile once on open so the page shows DigitalOcean's current state,
    // falling back to Hivra's last observation if DigitalOcean is unreachable.
    getManagedSession(agentId, { reconcile: true, signal: controller.signal })
      .catch(() => getManagedSession(agentId, { signal: controller.signal }))
      .then((next) => {
        if (next.status === "deleted") onDeletedRef.current();
        else setSession(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "This agent could not be loaded.");
      });
    return () => controller.abort();
  }, [agentId]);

  if (error) {
    return (
      <div role="alert" style={{ padding: 24, display: "flex", gap: 8, alignItems: "center", color: "var(--text-secondary)" }}>
        <AlertTriangle size={16} aria-hidden /> {error}
      </div>
    );
  }
  if (!session) {
    return (
      <div role="status" style={{ padding: 24, display: "flex", gap: 8, alignItems: "center", color: "var(--text-muted)" }}>
        <Loader2 size={16} aria-hidden /> Checking the DigitalOcean session…
      </div>
    );
  }
  return (
    <div style={{ height: "100%", minHeight: "calc(100dvh - 64px)", display: "flex", flexDirection: "column" }}>
      <ManagedSessionChat initialSession={session} onDeleted={() => onDeletedRef.current()} />
    </div>
  );
}
