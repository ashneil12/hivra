"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { wakeAgent, type WakeAgentResult } from "@/lib/hivra/agent-api";
import { isFastWakeEnabled } from "@/lib/hivra/fast-wake-flags";
import type { AgentSleepView } from "@/lib/hivra/agent-sleep-ui";

/** How long "Woke up in 1.4 s" stays on screen. */
export const WOKE_NOTE_MS = 4_000;

/** "1.4 s" under ten seconds, then whole seconds. */
export function formatWakeSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/**
 * Agents the owner just put to sleep by hand from this page (Nap now, Hibernate
 * now). The page must not wake them again by itself: the test would never leave
 * the agent asleep. The hold ends when the owner wakes the agent, when it is
 * awake again, or when the page is left or opened afresh.
 */
const manualSleepHolds = new Set<string>();

/** Called by the settings screen after a sleep the owner asked for. */
export function holdAutoWake(agentId: string): void {
  manualSleepHolds.add(agentId);
}

/** Called when the owner wakes the agent by hand, or the page is left. */
export function releaseAutoWake(agentId: string): void {
  manualSleepHolds.delete(agentId);
}

/** Why the page is not waking a sleeping agent: the owner asked for the sleep, or it napped while the page sat open. */
export type AgentRestingReason = "manual" | "idle";

export interface AgentWake {
  /** A plain message when the wake did not work, until the owner tries again. */
  failure: string | null;
  /** Ask again after a failure, or wake an agent the page is holding asleep. */
  retry: () => void;
  /** Shown briefly after the agent comes up: how long that took. */
  wokeMs: number | null;
  /** Set while the page is leaving a sleeping agent asleep on purpose. */
  resting: AgentRestingReason | null;
}

/**
 * Wakes a sleeping agent when its page opens, once per sleep. The page reads
 * `view` and `sleepState` from the agent's row; while it is asleep this sends one wake request,
 * and the page's own poll watches the row come up. When the request itself says
 * the agent is up, `onWoke` asks the page to read again at once.
 *
 * Two sleeps are not woken by the page on its own. One the owner asked for from
 * this page (a test) stays until they press Wake. One that began while the page
 * sat open and unused (the agent napped because nobody used it) stays until the
 * owner comes back to the page: a press, a key, a touch, or the tab becoming
 * visible. Without this an open, idle page would wake the agent every time it
 * napped, and its surfaces would be torn down and rebuilt each time.
 *
 * Fail toward awake: nothing here runs for an agent that reads as awake.
 */
export function useAgentWake(
  agentId: string,
  view: AgentSleepView,
  sleepState: string | null | undefined,
  onWoke: () => void,
  /**
   * False while the page has not read this agent yet: it reads as awake then, but nobody
   * has seen it awake, so a sleep found on the first read is woken at once.
   */
  loaded = true,
): AgentWake {
  const [failure, setFailure] = useState<string | null>(null);
  const [wokeMs, setWokeMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The wake request has been answered (not failed) for this attempt.
  const [answeredAttempt, setAnsweredAttempt] = useState<number | null>(null);
  // The attempt already requested, per agent. Reset when the agent is awake.
  const requestedRef = useRef<{ agentId: string; attempt: number } | null>(null);
  // Why a sleeping agent is being left asleep, and for which agent.
  const [rest, setRest] = useState<{ agentId: string; reason: AgentRestingReason } | null>(null);
  // This agent was seen awake while the page was open, so a sleep that follows is one it fell into.
  const seenAwakeRef = useRef<string | null>(null);
  // When this agent's sleep was first seen, and how long the server says the wake took.
  const startedRef = useRef<{ agentId: string; at: number; serverMs: number | null } | null>(null);
  const onWokeRef = useRef(onWoke);
  useEffect(() => { onWokeRef.current = onWoke; }, [onWoke]);
  // With the early_wake switch: a wake request sent while the page reads the agent for the
  // first time, used only if that read finds it asleep.
  const earlyRef = useRef<{ agentId: string; answer: Promise<WakeAgentResult> } | null>(null);

  // A page opened afresh wakes a sleeping agent at once anyway, so the request can go out
  // beside the first read instead of after it. An agent that is awake answers at once.
  useEffect(() => {
    if (loaded || !isFastWakeEnabled("early_wake", process.env.NEXT_PUBLIC_HIVRA_FAST_WAKE)) return;
    if (earlyRef.current?.agentId === agentId) return;
    earlyRef.current = { agentId, answer: wakeAgent(agentId) };
  }, [agentId, loaded]);

  // A page opened afresh (or left) starts without a hold from an earlier visit.
  useEffect(() => {
    releaseAutoWake(agentId);
    return () => releaseAutoWake(agentId);
  }, [agentId]);

  const resting = rest?.agentId === agentId ? rest.reason : null;

  useEffect(() => {
    if (view === "awake") {
      if (loaded) {
        seenAwakeRef.current = agentId;
        // The first read found it awake: the early answer is about a sleep that is not there.
        earlyRef.current = null;
      }
      releaseAutoWake(agentId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The agent is up: nothing is being held any more.
      setRest((current) => (current ? null : current));
      const started = startedRef.current;
      startedRef.current = null;
      if (started && started.agentId === agentId) setWokeMs(started.serverMs ?? Date.now() - started.at);
      requestedRef.current = null;
      return;
    }
    if (startedRef.current?.agentId !== agentId) startedRef.current = { agentId, at: Date.now(), serverMs: null };
    // Someone else is already waking it: nothing is held.
    if (view === "waking" && resting) {
      releaseAutoWake(agentId);
      setRest(null);
      return;
    }
    if (view === "asleep") {
      if (resting) return;
      const reason: AgentRestingReason | null = manualSleepHolds.has(agentId)
        ? "manual"
        : seenAwakeRef.current === agentId && requestedRef.current === null ? "idle" : null;
      if (reason) {
        seenAwakeRef.current = null;
        setRest({ agentId, reason });
        return;
      }
    }
    const done = requestedRef.current;
    // One request per sleep: a change from asleep to waking does not ask again.
    if (done && done.agentId === agentId && done.attempt === attempt) return;
    const mine = { agentId, attempt };
    requestedRef.current = mine;
    const early = earlyRef.current;
    earlyRef.current = null;
    const answer = early && early.agentId === agentId ? early.answer : wakeAgent(agentId);
    void answer.then((result) => {
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
  }, [agentId, view, attempt, resting, loaded]);

  // An agent that napped while the page sat open wakes when its owner comes back.
  useEffect(() => {
    if (resting !== "idle") return;
    const comeBack = () => setRest(null);
    const onVisible = () => { if (document.visibilityState === "visible") comeBack(); };
    // A click inside the agent's own frame never reaches this window, but it takes focus
    // from it: the window blurs and the frame becomes the active element.
    const onBlur = () => {
      window.setTimeout(() => { if (document.activeElement instanceof HTMLIFrameElement) comeBack(); }, 0);
    };
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, comeBack, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("blur", onBlur);
    return () => {
      for (const name of events) window.removeEventListener(name, comeBack);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("blur", onBlur);
    };
  }, [resting]);

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
    releaseAutoWake(agentId);
    setRest(null);
    setFailure(null);
    setAnsweredAttempt(null);
    setAttempt((value) => value + 1);
  }, [agentId]);

  // The request said "still waking" and the wake then did not work.
  const failedLater = view !== "awake" && sleepState === "wake_failed" && answeredAttempt === attempt;
  return {
    failure: failure ?? (failedLater ? WAKE_FAILED_LATER : null),
    retry,
    wokeMs,
    resting,
  };
}

const WAKE_FAILED_LATER = "Your agent could not wake up just now. Try again in a moment.";
