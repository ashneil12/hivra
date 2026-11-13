"use client";

import { useCallback, useEffect, useState } from "react";
import { getAgent } from "@/lib/hivra/agent-api";
import type { HermesWorkspaceReadiness } from "./useHermesWorkspaceReady";

const POLL_MS = 4000;
const POLL_DEADLINE_MS = 12 * 60 * 1000;

/** Whether a new Hivra agent can answer: its record says running and it has a
 * chat address. That is the bar the agent page uses to open its chat, so the
 * launch screen offers Start chatting exactly when the page would show a
 * working agent. Observed state only: a failed read, a missing address or any
 * other status keeps it not ready. A failed launch (status error) and the end
 * of the bounded window both stop the checks, so the screen never claims a
 * check that is no longer running. */
export function useAgentRunningReadiness(agentId: string | null | undefined): HermesWorkspaceReadiness {
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [stopped, setStopped] = useState<{ agentId: string; round: number } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const ready = Boolean(agentId) && readyFor === agentId;
  const gaveUp = !ready && Boolean(agentId) && stopped !== null && stopped.agentId === agentId && stopped.round === round;

  useEffect(() => {
    if (!agentId || ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const next = () => {
      if (Date.now() < deadline) timer = setTimeout(poll, POLL_MS);
      else setStopped({ agentId, round });
    };
    const poll = async () => {
      try {
        const agent = await getAgent(agentId);
        if (cancelled) return;
        if (agent?.status === "running" && agent.chat_url) {
          setReadyFor(agentId);
          return;
        }
        if (agent?.status === "error") {
          setFailedFor(agentId);
          setStopped({ agentId, round });
          return;
        }
      } catch {
        if (cancelled) return;
      }
      next();
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, ready, round]);

  const recheck = useCallback(() => setRound(value => value + 1), []);
  const failed = !ready && Boolean(agentId) && failedFor === agentId && gaveUp;
  return { ready, checking: Boolean(agentId) && !ready && !gaveUp, recheck, failed };
}
