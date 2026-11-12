"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { wakeAgent } from "@/lib/hivra/agent-api";
import type { AgentSleepView } from "@/lib/hivra/agent-sleep-ui";

/** How long "Woke up in 1.4 s" stays on screen. */
export const WOKE_NOTE_MS = 4_000;

/** "1.4 s" under ten seconds, then whole seconds. */
export function formatWakeSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

export interface AgentWake {
  /** A plain message when the wake did not work, until the owner tries again. */
  failure: string | null;
  /** Ask again after a failure. */
  retry: () => void;
  /** Shown briefly after the agent comes up: how long that took. */
  wokeMs: number | null;
}

/**
 * Wakes a sleeping agent when its page opens, once per sleep. The page reads
 * `view` and `sleepState` from the agent's row; while it is asleep this sends one wake request,
 * and the page's own poll watches the row come up. When the request itself says
 * the agent is up, `onWoke` asks the page to read again at once.
 *
 * Fail toward awake: nothing here runs for an agent that reads as awake.
 */
export function useAgentWake(
  agentId: string,
  view: AgentSleepView,
  sleepState: string | null | undefined,
  onWoke: () => void,
): AgentWake {
  const [failure, setFailure] = useState<string | null>(null);
  const [wokeMs, setWokeMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The wake request has been answered (not failed) for this attempt.
  const [answeredAttempt, setAnsweredAttempt] = useState<number | null>(null);
  // The attempt already requested, per agent. Reset when the agent is awake.
  const requestedRef = useRef<{ agentId: string; attempt: number } | null>(null);
  // When this agent's sleep was first seen, and how long the server says the wake took.
  const startedRef = useRef<{ agentId: string; at: number; serverMs: number | null } | null>(null);
  const onWokeRef = useRef(onWoke);
  useEffect(() => { onWokeRef.current = onWoke; }, [onWoke]);

  useEffect(() => {
    if (view === "awake") {
      const started = startedRef.current;
      startedRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- A wake just finished: show how long it took.
      if (started && started.agentId === agentId) setWokeMs(started.serverMs ?? Date.now() - started.at);
      requestedRef.current = null;
      return;
    }
    if (startedRef.current?.agentId !== agentId) startedRef.current = { agentId, at: Date.now(), serverMs: null };
    const done = requestedRef.current;
    // One request per sleep: a change from asleep to waking does not ask again.
    if (done && done.agentId === agentId && done.attempt === attempt) return;
    const mine = { agentId, attempt };
    requestedRef.current = mine;
    void wakeAgent(agentId).then((result) => {
      // Another agent, or the agent woke by itself: this answer no longer matters.
      if (requestedRef.current !== mine) return;
      if (result.state === "failed") {
        setFailure(result.message);
        return;
      }
      setAnsweredAttempt(attempt);
      if (result.state === "awake") {
        if (startedRef.current?.agentId === agentId) startedRef.current.serverMs = result.wakeMs;
        onWokeRef.current();
      }
    });
  }, [agentId, view, attempt]);

  useEffect(() => {
    if (wokeMs === null) return;
    const timer = window.setTimeout(() => setWokeMs(null), WOKE_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [wokeMs]);

  // Another agent in the same page starts clean.
  const [seenAgent, setSeenAgent] = useState(agentId);
  if (seenAgent !== agentId) {
    setSeenAgent(agentId);
    setFailure(null);
    setWokeMs(null);
    setAnsweredAttempt(null);
  }

  const retry = useCallback(() => {
    setFailure(null);
    setAnsweredAttempt(null);
    setAttempt((value) => value + 1);
  }, []);

  // The request said "still waking" and the wake then did not work.
  const failedLater = view !== "awake" && sleepState === "wake_failed" && answeredAttempt === attempt;
  return {
    failure: failure ?? (failedLater ? WAKE_FAILED_LATER : null),
    retry,
    wokeMs,
  };
}

const WAKE_FAILED_LATER = "Your agent could not wake up just now. Try again in a moment.";
