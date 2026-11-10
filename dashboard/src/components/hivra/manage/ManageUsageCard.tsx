"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ComputerUsageError, getComputerUsage } from "@/lib/hivra/agent-api";
import {
  COMPUTER_USAGE_CLAIM_SECONDS,
  COMPUTER_USAGE_STALE_SECONDS,
  formatUptime,
  formatUsageAge,
  formatUsageGb,
  type ComputerUsageView,
} from "@/lib/hivra/computer-usage-contract";
import { capReason, type ManageCap } from "@/lib/hivra/manage-sections";
import { useManageSectionVisible } from "../ManageLayout";
import { UNREACHABLE_CARD_LINE, UnreachableCardLine, useReportUnreachable } from "./ManageReachability";
import { manageButtonGhost, manageCard, manageDisabled, manageLabel, manageMuted, manageSpin, manageValue } from "./manage-styles";

// Manage › Overview: the computer's live usage and uptime, read from its host
// (GET /api/hivra/agents/[id]/usage). The first look shows what Hivra last
// read and reads again only when that is old; after that it reads on Refresh,
// and when the computer changes state. Nothing polls in the background.

/**
 * Ask again after a read another request was already making, until that read
 * must be over: a reader holds the refresh for at most
 * COMPUTER_USAGE_CLAIM_SECONDS, so the last retry comes after it has finished
 * or given up, and the card never keeps saying "Reading…" for a read that
 * isn't happening.
 */
const REFRESHING_RETRY_MS = 3_000;
const REFRESHING_RETRIES = Math.ceil((COMPUTER_USAGE_CLAIM_SECONDS * 1000 + REFRESHING_RETRY_MS) / REFRESHING_RETRY_MS);
const CLOCK_TICK_MS = 15_000;

type UsageState = {
  view: ComputerUsageView | null;
  /** When `view` arrived, to keep its age current. */
  receivedAt: number;
  error: string | null;
  /** The usage route's code for this failure, when it sent one. */
  errorCode: string | null;
  loading: boolean;
};

function powerLine(view: ComputerUsageView): string {
  switch (view.power.observed) {
    case "running":
      return view.uptimeSeconds !== null ? `Running for ${formatUptime(view.uptimeSeconds)}` : "Running";
    case "stopped": return "Switched off";
    case "paused": return "Paused";
    case "missing": return "Not found on its host";
    default: return "Not known right now";
  }
}

function mismatchLine(view: ComputerUsageView): string | null {
  // A computer its host can't find isn't "switched off": Stop and Start would
  // fail on it, so the missing line below says what to do instead.
  if (view.power.matches !== false || view.power.observed === "missing") return null;
  if (view.power.recorded === "running") {
    return "Hivra's record says this computer is on, but its host says it's switched off. Use Stop and then Start to bring them back in line.";
  }
  return "Hivra's record says this computer is off, but its host says it's running. Refresh in a minute. If it stays like this, contact support.";
}

function UsageRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
      <dt className="mono" style={{ ...manageLabel, flex: "0 0 96px" }}>{label}</dt>
      <dd style={{ margin: 0, flex: "1 1 180px", minWidth: 0, display: "grid", gap: 2 }}>
        <span style={manageValue}>{value}</span>
        {hint ? <span style={{ ...manageMuted, fontSize: 11.5 }}>{hint}</span> : null}
      </dd>
    </div>
  );
}

export function ManageUsageCard({ agentId, cap, recordedStatus }: {
  agentId: string;
  /** agent.manage.usage: whether Hivra can read this computer's usage, and if not, why. */
  cap: ManageCap | null | undefined;
  /** The computer's status on record; a change reads the host again. */
  recordedStatus: string;
}) {
  const visible = useManageSectionVisible();
  const usable = cap?.state === "available";
  // Read the first time the section is shown, never while it is hidden.
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<UsageState>({ view: null, receivedAt: 0, error: null, errorCode: null, loading: false });
  const [now, setNow] = useState(() => Date.now());
  // Said to screen readers once per finished read. The "Updated … ago" label
  // below changes with the clock, so it isn't a live region itself.
  const [announcement, setAnnouncement] = useState("");
  const request = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (mode: "cached" | "live"): Promise<ComputerUsageView | null> => {
    request.current.controller?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const controller = new AbortController();
    const id = request.current.id + 1;
    request.current = { id, controller };
    setState((current) => ({ ...current, loading: true, error: null, errorCode: null }));
    try {
      const view = await getComputerUsage(agentId, { cached: mode === "cached", signal: controller.signal });
      if (request.current.id !== id) return null;
      const receivedAt = Date.now();
      setNow(receivedAt);
      setState({ view, receivedAt, error: null, errorCode: null, loading: false });
      return view;
    } catch (error) {
      if (request.current.id !== id || controller.signal.aborted) return null;
      const message = error instanceof ComputerUsageError && error.status === 429
        ? `${error.message} Try again in ${error.retryAfterSeconds ?? 60} seconds.`
        : error instanceof Error && error.message ? error.message : "Hivra couldn't read this computer's usage.";
      const errorCode = error instanceof ComputerUsageError ? error.code : null;
      setState((current) => ({ ...current, error: message, errorCode, loading: false }));
      return null;
    }
  }, [agentId]);

  const refresh = useCallback(async () => {
    retries.current = 0;
    const view = await load("live");
    // Another request was already reading the host: ask again shortly.
    const retry = (latest: ComputerUsageView | null) => {
      if (!latest) return;
      if (!latest.refreshing) {
        // With nothing read before, the failure is already an alert below.
        if (latest.observedAt) {
          setAnnouncement(latest.notes.includes("host_unreachable")
            ? "Hivra couldn't reach this computer's host just now."
            : `Usage updated ${formatUsageAge(latest.ageSeconds ?? 0)}.`);
        }
        return;
      }
      if (retries.current >= REFRESHING_RETRIES) {
        // That read has finished or given up by now without an answer here:
        // stop saying it is in progress, and let Refresh ask again.
        setState((current) => (current.view === latest ? { ...current, view: { ...latest, refreshing: false } } : current));
        return;
      }
      retries.current += 1;
      retryTimer.current = setTimeout(() => { void load("live").then(retry); }, REFRESHING_RETRY_MS);
    };
    retry(view);
  }, [load]);

  // First look, once the section is on screen: what Hivra last read, then a
  // new read if that is old. It waits a tick, because a link to another
  // section opens that section right after the first render.
  useEffect(() => {
    if (!visible || !usable || opened) return;
    const timer = setTimeout(() => {
      setOpened(true);
      void load("cached").then((view) => {
        if (!view) return;
        const old = view.observedAt === null || view.stale || view.notes.includes("status_changed");
        if (old) void refresh();
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, usable, opened, load, refresh]);

  // A state change (Stop, Start, Restart…) makes the last read out of date,
  // so read again, once the card has been looked at.
  const latest = useRef({ opened, refresh });
  useEffect(() => { latest.current = { opened, refresh }; });
  const lastStatus = useRef(recordedStatus);
  useEffect(() => {
    if (lastStatus.current === recordedStatus) return;
    lastStatus.current = recordedStatus;
    if (!latest.current.opened) return;
    const timer = setTimeout(() => { void latest.current.refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [recordedStatus]);

  // Keep "Updated … ago" current while the section is on screen.
  useEffect(() => {
    if (!visible || !state.view?.observedAt) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [visible, state.view?.observedAt]);

  useEffect(() => () => {
    request.current.controller?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // The host didn't answer: Manage's one banner says so, and this card says
  // only that it is unavailable instead of its own error.
  const unreachableNow = usable && !state.loading
    && (Boolean(state.view?.notes.includes("host_unreachable")) || state.errorCode === "host_unreachable");
  useReportUnreachable("usage", unreachableNow);

  if (!cap) return null;

  const heading = <div className="mono" style={manageLabel}>Usage</div>;
  if (!usable) {
    return (
      <div style={{ display: "grid", gap: 10 }} data-testid="manage-usage">
        {heading}
        <div style={manageCard}><div style={manageMuted}>{capReason(cap)}</div></div>
      </div>
    );
  }

  const { view, error, loading } = state;
  const age = view?.ageSeconds != null ? view.ageSeconds + Math.max(0, (now - state.receivedAt) / 1000) : null;
  const running = view?.power.observed === "running";
  const notes = view?.notes ?? [];
  const lines: Array<{ key: string; text: string; alert?: boolean }> = [];
  if (view) {
    const mismatch = mismatchLine(view);
    if (mismatch) lines.push({ key: "mismatch", text: mismatch, alert: true });
    if (notes.includes("vm_missing")) {
      // Recorded as on but not on its host: nothing on this page can fix that.
      lines.push(view.power.recorded === "running"
        ? { key: "missing", text: "Hivra couldn't find this computer on its host. Contact support.", alert: true }
        : { key: "missing", text: "Hivra couldn't find this computer on its host." });
    }
    if (notes.includes("resources_unavailable")) lines.push({ key: "resources", text: "CPU, memory and power state aren't available right now." });
    if (notes.includes("guest_agent_unavailable")) lines.push({ key: "guest", text: "Disk use isn't available: the computer's guest agent didn't answer." });
    if (notes.includes("host_unreachable")) {
      // Manage's banner says the computer can't be reached; this card only
      // says it is unavailable (and keeps the age of what it last read).
      if (!loading) {
        lines.push({
          key: "host",
          text: age !== null ? `${UNREACHABLE_CARD_LINE}. Last read ${formatUsageAge(age)}.` : UNREACHABLE_CARD_LINE,
        });
      }
    }
    if (notes.includes("status_changed") && !loading) {
      lines.push({ key: "changed", text: "This computer changed state after this was read. Refresh to read it again." });
    }
  }

  const disk = view?.disk ?? null;
  const diskValue = disk?.guestReported && disk.usedBytes !== null && disk.sizeBytes !== null
    ? `${formatUsageGb(disk.usedBytes)} GB used of ${formatUsageGb(disk.sizeBytes)} GB`
    : disk?.allocatedBytes != null ? `${formatUsageGb(disk.allocatedBytes)} GB disk` : "—";
  const updated = loading && !view?.observedAt ? "Reading…"
    : age !== null ? `Updated ${formatUsageAge(age)}${age > COMPUTER_USAGE_STALE_SECONDS && !notes.includes("host_unreachable") ? " · out of date" : ""}`
      : view?.refreshing ? "Reading…" : null;

  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="manage-usage">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {heading}
        {updated ? <span style={{ ...manageMuted, fontSize: 11.5 }}>{updated}</span> : null}
        <span role="status" className="sr-only">{announcement}</span>
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          style={{ ...manageDisabled(manageButtonGhost, loading), marginLeft: "auto" }}
        >
          {loading ? <Loader2 size={13} style={manageSpin} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />} Refresh
        </button>
      </div>
      <div style={manageCard}>
        {view && (view.observedAt || notes.includes("vm_missing")) ? (
          <dl style={{ margin: 0, display: "grid", gap: 10 }}>
            <UsageRow label="Power" value={powerLine(view)} />
            {running ? (
              <>
                <UsageRow label="CPU" value={view.cpu ? `${view.cpu.percent}% of ${view.cpu.vcpus} CPU` : "—"} />
                <UsageRow
                  label="Memory"
                  value={view.memory ? `${formatUsageGb(view.memory.usedBytes)} GB in use of ${formatUsageGb(view.memory.maximumBytes)} GB` : "—"}
                  hint={view.memory?.includesCache ? "Includes the computer's file cache, so it can read high." : null}
                />
              </>
            ) : null}
            {view.power.observed !== "missing" ? <UsageRow label="Disk" value={diskValue} /> : null}
          </dl>
        ) : !error && !(notes.includes("host_unreachable") && !loading) ? (
          <div role="status" style={manageMuted}>{loading || view?.refreshing ? "Reading this computer's usage…" : "No usage read yet. Use Refresh to read it."}</div>
        ) : null}
        {lines.map((line) => (
          <div key={line.key} role={line.alert ? "alert" : undefined} style={{ ...manageMuted, fontSize: 11.5 }}>{line.text}</div>
        ))}
        {error && state.errorCode === "host_unreachable" ? <UnreachableCardLine testId="manage-usage-unreachable" />
          : error ? <div role="alert" style={{ ...manageMuted, color: "var(--hg-bad)" }}>{error}</div> : null}
      </div>
    </div>
  );
}
