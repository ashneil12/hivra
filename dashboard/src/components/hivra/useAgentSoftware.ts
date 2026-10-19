"use client";

// One shared reading per agent of its software state (Claude Code / Codex
// version, update progress, automatic-update choice), for the agent header
// chip and Manage › Updates together: one request serves both, and one poller
// follows an update while either is on screen.
//
// Polling, only while something is changing: every 3 s for the first 30 s of
// an update, every 10 s up to 3 minutes, then every minute (and every minute
// while the computer waits for a reply to finish), up to 6 h 15 min; a
// reading still "checking" is asked again every 5 s, three times. Polls pause
// while the page is hidden and stop once the update has ended.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getAgentSoftware, type AgentSoftwareState } from "@/lib/hivra/agent-software-api";

const CHECKING_RETRY_MS = 5_000;
const CHECKING_RETRIES = 3;
const POLL_LIMIT_MS = 6 * 60 * 60_000 + 15 * 60_000;
/** A surface shown again after this reads again. */
const REUSE_MS = 60_000;

export interface AgentSoftwareSnapshot {
  state: AgentSoftwareState | null;
  loading: boolean;
  /** The last read failed (the owner API or the computer), with its message. */
  error: string | null;
}

/** Views after which an update just asked for has nothing more to show. */
const SETTLED = new Set(["current", "update_done", "ahead_custom", "not_running", "not_reported"]);
/** How long an update just asked for is looked for before the computer reports it. */
const REPORT_GRACE_MS = 60_000;

/** How long until the next read, or null when nothing is changing. */
export function nextAgentSoftwarePoll(state: AgentSoftwareState | null, followingSince: number | null, checkingTries: number, now: number): number | null {
  if (!state?.supported) return null;
  const view = state.view;
  if (view.kind === "checking") return checkingTries < CHECKING_RETRIES ? CHECKING_RETRY_MS : null;
  const elapsed = followingSince === null ? null : now - followingSince;
  if (view.kind === "updating") {
    if (elapsed !== null && elapsed > POLL_LIMIT_MS) return null;
    if (view.phase === "waiting") return 60_000;
    return elapsed === null || elapsed < 30_000 ? 3_000 : elapsed < 180_000 ? 10_000 : 60_000;
  }
  // Just asked for, and the computer hasn't reported it yet.
  if (elapsed !== null && elapsed < REPORT_GRACE_MS && !SETTLED.has(view.kind)) return 3_000;
  return null;
}

class AgentSoftwareEntry {
  snapshot: AgentSoftwareSnapshot = { state: null, loading: false, error: null };
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private followingSince: number | null = null;
  private checkingTries = 0;
  private readAt: number | null = null;
  private waitingForVisible = false;

  constructor(private readonly agentId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private set(next: Partial<AgentSoftwareSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.waitingForVisible && typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    this.waitingForVisible = false;
  }

  private onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", this.onVisible);
    this.waitingForVisible = false;
    void this.read(true);
  };

  private schedule() {
    this.stop();
    if (this.listeners.size === 0) return;
    const delay = nextAgentSoftwarePoll(this.snapshot.state, this.followingSince, this.checkingTries, Date.now());
    if (delay === null) {
      this.followingSince = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.waitingForVisible = true;
        document.addEventListener("visibilitychange", this.onVisible);
        return;
      }
      void this.read(true);
    }, delay);
  }

  /** A newly shown surface's read: the stored reading (the server refreshes a stale one). */
  ensureLoaded() {
    if (this.inflight || (this.readAt !== null && Date.now() - this.readAt < REUSE_MS)) return;
    void this.read(false);
  }

  read(live: boolean): Promise<void> {
    if (this.inflight) return this.inflight;
    this.set({ loading: true });
    this.inflight = (async () => {
      try {
        const state = await getAgentSoftware(this.agentId, { live });
        this.readAt = Date.now();
        if (state.supported && state.view.kind === "checking") this.checkingTries += 1;
        else this.checkingTries = 0;
        if (state.supported && state.view.kind === "updating" && this.followingSince === null) this.followingSince = Date.now();
        this.set({ state, loading: false, error: null });
      } catch (error) {
        this.readAt = Date.now();
        this.set({ loading: false, error: error instanceof Error ? error.message : "Couldn't check this agent's software." });
      } finally {
        this.inflight = null;
        this.schedule();
      }
    })();
    return this.inflight;
  }

  /** An update was just asked for: follow it from now, starting with a fresh read. */
  follow(): Promise<void> {
    this.followingSince = Date.now();
    this.checkingTries = 0;
    // A read already on its way began before the update; read again after it.
    return (this.inflight ?? Promise.resolve()).then(() => this.read(true));
  }

  replace(state: AgentSoftwareState) {
    this.set({ state, error: null });
    this.schedule();
  }
}

const entries = new Map<string, AgentSoftwareEntry>();

function entryFor(agentId: string): AgentSoftwareEntry {
  let entry = entries.get(agentId);
  if (!entry) {
    entry = new AgentSoftwareEntry(agentId);
    entries.set(agentId, entry);
  }
  return entry;
}

/**
 * Follow an update another control just asked for (Manage's connection
 * service update also moves Claude Code and Codex). Only where a surface is
 * already showing this agent's software.
 */
export function followAgentSoftware(agentId: string): void {
  void entries.get(agentId)?.follow();
}

/** Tests start every case from nothing. */
export function resetAgentSoftwareForTests() {
  entries.clear();
}

const EMPTY: AgentSoftwareSnapshot = { state: null, loading: false, error: null };
const noop = () => () => undefined;

export interface UseAgentSoftware extends AgentSoftwareSnapshot {
  /** Read the computer again now. */
  refresh: () => Promise<void>;
  /** Start following an update that was just asked for. */
  follow: () => Promise<void>;
  /** Show an answer the owner API just gave (after saving a choice). */
  replace: (state: AgentSoftwareState) => void;
}

/** The shared software state for this agent; `enabled` false reads nothing. */
export function useAgentSoftware(agentId: string | null, enabled: boolean): UseAgentSoftware {
  const entry = agentId && enabled ? entryFor(agentId) : null;
  const snapshot = useSyncExternalStore(
    entry ? entry.subscribe : noop,
    () => entry?.snapshot ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => { entry?.ensureLoaded(); }, [entry]);
  const refresh = useCallback(async () => { await entry?.read(true); }, [entry]);
  const follow = useCallback(async () => { await entry?.follow(); }, [entry]);
  const replace = useCallback((state: AgentSoftwareState) => { entry?.replace(state); }, [entry]);
  return { ...snapshot, refresh, follow, replace };
}
