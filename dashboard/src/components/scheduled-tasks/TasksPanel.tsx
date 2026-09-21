"use client";

// TasksPanel — the per-agent "Tasks" tab. Surfaces the box's standing scheduled
// jobs as first-class, owned, recurring work (the deepest switching-cost lever):
//   - run history line (last status / last error / next + last run)
//   - enable/pause toggle, run-now, edit (TaskModal), delete
//   - "New task" — a Free user keeps ONE standing task: their first create is
//     allowed; the 2nd (jobs.length >= FREE_STANDING_TASK_LIMIT) opens the
//     UpgradePaywallModal('cron'). Pro users are unlimited. Lifecycle/edit/
//     delete on an existing task are always allowed for the owner.
//
// All reads/writes go through the dashboard→box cron proxy at
// /api/instances/[id]/cron. The same one-task gate is enforced server-side on
// create; this is the matching client UX so a Free user isn't surprised by a
// 403. TaskModal stays pure: this panel is the caller that POSTs/PUTs its onSave.

// Free includes a single standing task; keep this in lockstep with the
// server-side FREE_STANDING_TASK_LIMIT in the cron route.
const FREE_STANDING_TASK_LIMIT = 1;

import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Play,
  Pause,
  Pencil,
  Trash2,
  Plus,
  Lock,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { TaskModal } from "@/components/scheduled-tasks/TaskModal";
import { UpgradePaywallModal } from "@/components/billing/UpgradePaywallModal";
import { clientLog } from "@/lib/client/logger";
import { isPlatformDailyBriefJob } from "@/lib/daily-brief-shared";

// Shape of a job as returned by the box (GET /api/cron/jobs).
interface BoxJob {
  id: string;
  name: string;
  prompt: string;
  schedule?: unknown;
  schedule_display?: string;
  enabled: boolean;
  state?: "scheduled" | "paused" | string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  deliver?: string;
  profile?: string;
  profile_name?: string;
}

// The TaskModal speaks LiveJob; map a BoxJob into it for editing.
interface LiveJob {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  errorCount?: number;
  profileName?: string;
  state?: string;
  deliver?: string;
  nextRunAt?: string;
  lastRunAt?: string;
}

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
  color: "var(--text-muted)",
};

function rawScheduleString(schedule: unknown): string {
  if (typeof schedule === "string") return schedule;
  // The box returns the parsed cron dict on schedule; the human string lives on
  // schedule_display. For editing we need a RAW cron string — fall back to a
  // sensible default if only the dict is present.
  return "";
}

function toLiveJob(job: BoxJob): LiveJob {
  return {
    id: job.id,
    name: job.name,
    schedule: rawScheduleString(job.schedule) || job.schedule_display || "0 9 * * *",
    command: job.prompt,
    enabled: job.enabled,
    errorCount: job.last_error ? 1 : 0,
    profileName: job.profile,
    state: job.state,
    deliver: job.deliver,
    nextRunAt: job.next_run_at ?? undefined,
    lastRunAt: job.last_run_at ?? undefined,
  };
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusColor(job: BoxJob): string {
  if (job.last_error) return "#ef4444";
  const status = (job.last_status || "").toLowerCase();
  if (status === "success" || status === "ok" || status === "completed") return "#22c55e";
  if (status === "running") return "var(--gold-leaf)";
  return "var(--text-muted)";
}

export function TasksPanel({
  instanceId,
  agentName = "your agent",
  agentStatus = "running",
  isFreePlan = false,
  currentPlan,
}: {
  instanceId: string;
  // Optional so the standard instance console can mount this with just an
  // instanceId; the agent lane passes the richer name/status/plan it has.
  agentName?: string;
  agentStatus?: string;
  isFreePlan?: boolean;
  currentPlan?: string | null;
}) {
  const [jobs, setJobs] = useState<BoxJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<LiveJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const agentForModal = { id: instanceId, name: agentName, status: agentStatus };

  // The platform-seeded "Daily brief" job is a system job (surfaced in the
  // command panel's Today's brief, not here) — exclude it from the user's task
  // list + count so it doesn't render as an editable row or count against the
  // free limit. Matches the server's countExistingJobs exclusion exactly.
  const visibleJobs = jobs.filter((job) => !isPlatformDailyBriefJob(job));

  // Free keeps ONE standing task. A Free user can create while under the limit;
  // a Pro user always can. Editing / lifecycle / delete on an EXISTING task is
  // always allowed for the owner (they manage the task they already have).
  const atFreeLimit = isFreePlan && visibleJobs.length >= FREE_STANDING_TASK_LIMIT;

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/cron?profile=all`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLoadError((body && body.error) || "Could not load scheduled tasks.");
        setJobs([]);
        return;
      }
      const data = await res.json();
      setJobs(Array.isArray(data) ? (data as BoxJob[]) : []);
    } catch (err) {
      clientLog.error("Failed to load scheduled tasks", err, {
        source: "tasks-panel",
        instanceId,
        failureType: "tasks_panel_load_failed",
      });
      setLoadError("Could not load scheduled tasks.");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const openNewTask = () => {
    if (atFreeLimit) {
      setPaywallOpen(true);
      return;
    }
    setEditingJob(null);
    setModalOpen(true);
  };

  // Editing an existing task is always allowed for the owner — it doesn't add a
  // task, so a Free user managing their single standing task is fine.
  const openEditTask = (job: BoxJob) => {
    setEditingJob(toLiveJob(job));
    setModalOpen(true);
  };

  // The caller TaskModal.onSave routes through: create -> POST, edit -> PUT.
  const handleSave = useCallback(
    async (
      data: {
        name: string;
        schedule: string;
        command: string;
        agentId: string;
        profileName: string;
        status: "active" | "paused";
        deliver: string;
      },
      isEdit: boolean,
    ) => {
      setSaving(true);
      setActionError(null);
      try {
        const targetId = data.agentId || instanceId;
        const profileQuery = data.profileName
          ? `&profile=${encodeURIComponent(data.profileName)}`
          : "";
        let res: Response;
        if (isEdit && editingJob) {
          // status 'active'|'paused' -> enabled true|false (box: scheduled|paused).
          res = await fetch(
            `/api/instances/${encodeURIComponent(targetId)}/cron?profile=${encodeURIComponent(data.profileName || "default")}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jobId: editingJob.id,
                updates: {
                  name: data.name,
                  schedule: data.schedule, // RAW cron string
                  prompt: data.command, // command -> prompt
                  enabled: data.status === "active",
                  // TODO(paioclaw-riplist): the cron route's UPDATE_SCHEMA does NOT
                  // accept `deliver` (only CREATE does), so an edited task can't yet
                  // change its delivery target. To support editing delivery, add
                  // `deliver` to UPDATE_SCHEMA + the PUT proxy body in
                  // app/api/instances/[id]/cron/route.ts and confirm the box's
                  // CronJobUpdate accepts it, then send `data.deliver` here.
                },
              }),
            },
          );
        } else {
          res = await fetch(
            `/api/instances/${encodeURIComponent(targetId)}/cron?profile=${encodeURIComponent(data.profileName || "default")}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: data.name,
                schedule: data.schedule, // RAW cron string
                prompt: data.command, // command -> prompt
                // User-chosen delivery target; defaults to "local" (the prior
                // hardcoded value) so blank/unchanged tasks keep current behavior.
                deliver: data.deliver || "local",
              }),
            },
          );
        }

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (res.status === 403) {
            setModalOpen(false);
            setPaywallOpen(true);
            return;
          }
          setActionError((body && body.error) || "Could not save the task.");
          return;
        }

        // A freshly created job is enabled by default; if the user chose "paused",
        // honor it with a follow-up pause so create + status are consistent.
        if (!isEdit && data.status === "paused") {
          const created = await res.json().catch(() => null);
          const newJobId = created && typeof created.id === "string" ? created.id : null;
          if (newJobId) {
            await fetch(
              `/api/instances/${encodeURIComponent(targetId)}/cron?action=pause&jobId=${encodeURIComponent(newJobId)}${profileQuery}`,
              { method: "POST" },
            ).catch(() => {});
          }
        }

        setModalOpen(false);
        setEditingJob(null);
        await loadJobs();
      } catch (err) {
        clientLog.error("Failed to save scheduled task", err, {
          source: "tasks-panel",
          instanceId,
          failureType: "tasks_panel_save_failed",
        });
        setActionError("Could not save the task.");
      } finally {
        setSaving(false);
      }
    },
    [editingJob, instanceId, loadJobs],
  );

  const runLifecycle = useCallback(
    async (job: BoxJob, action: "pause" | "resume" | "trigger") => {
      // Lifecycle on an existing task is open to the owner (incl. Free).
      setBusyJobId(job.id);
      setActionError(null);
      try {
        const profileQuery = job.profile ? `&profile=${encodeURIComponent(job.profile)}` : "";
        const res = await fetch(
          `/api/instances/${encodeURIComponent(instanceId)}/cron?action=${action}&jobId=${encodeURIComponent(job.id)}${profileQuery}`,
          { method: "POST" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (res.status === 403) {
            setPaywallOpen(true);
            return;
          }
          setActionError((body && body.error) || `Could not ${action} the task.`);
          return;
        }
        await loadJobs();
      } catch (err) {
        clientLog.error("Failed to update scheduled task lifecycle", err, {
          source: "tasks-panel",
          instanceId,
          action,
          failureType: "tasks_panel_lifecycle_failed",
        });
        setActionError(`Could not ${action} the task.`);
      } finally {
        setBusyJobId(null);
      }
    },
    [instanceId, loadJobs],
  );

  const deleteJob = useCallback(
    async (job: BoxJob) => {
      // Deleting an existing task is open to the owner (incl. Free) — it frees
      // their single standing-task slot.
      if (typeof window !== "undefined" && !window.confirm(`Delete scheduled task "${job.name}"?`)) {
        return;
      }
      setBusyJobId(job.id);
      setActionError(null);
      try {
        const profileQuery = job.profile ? `&profile=${encodeURIComponent(job.profile)}` : "";
        const res = await fetch(
          `/api/instances/${encodeURIComponent(instanceId)}/cron?jobId=${encodeURIComponent(job.id)}${profileQuery}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (res.status === 403) {
            setPaywallOpen(true);
            return;
          }
          setActionError((body && body.error) || "Could not delete the task.");
          return;
        }
        await loadJobs();
      } catch (err) {
        clientLog.error("Failed to delete scheduled task", err, {
          source: "tasks-panel",
          instanceId,
          failureType: "tasks_panel_delete_failed",
        });
        setActionError("Could not delete the task.");
      } finally {
        setBusyJobId(null);
      }
    },
    [instanceId, loadJobs],
  );

  const iconButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid var(--etched-border)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-mono), monospace",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "6px 9px",
    cursor: "pointer",
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "clamp(16px, 4vw, 28px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <CalendarClock size={18} style={{ color: "var(--gold-leaf)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="serif" style={{ fontSize: "1.4rem", fontWeight: 400, margin: 0, color: "var(--ink-black)" }}>
            Scheduled Tasks
          </h2>
          <div className="mono" style={{ fontSize: 10, marginTop: 4, opacity: 0.55 }}>
            Recurring jobs {agentName} runs on its own — reports, monitors, follow-ups.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadJobs()}
          disabled={loading}
          style={iconButtonStyle}
          aria-label="Refresh tasks"
        >
          <RefreshCw size={12} /> Refresh
        </button>
        <button
          type="button"
          onClick={openNewTask}
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            border: "1px solid var(--ink-black)",
            background: "var(--ink-black)",
            color: "var(--bg-surface)",
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            padding: "8px 14px",
            cursor: "pointer",
          }}
        >
          {atFreeLimit ? <Lock size={13} /> : <Plus size={13} />} New task
        </button>
      </div>

      {actionError ? (
        <div
          style={{
            border: "1px solid #ef4444",
            background: "rgba(239,68,68,0.06)",
            color: "#ef4444",
            fontSize: 12,
            padding: "10px 12px",
            marginBottom: 16,
          }}
        >
          {actionError}
        </div>
      ) : null}

      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
        </div>
      ) : loadError ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 13, marginBottom: 12 }}>{loadError}</div>
          <button type="button" onClick={() => void loadJobs()} style={iconButtonStyle}>
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      ) : visibleJobs.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
          <div className="serif" style={{ fontSize: 20, color: "var(--ink-black)", marginBottom: 8 }}>
            No scheduled tasks yet
          </div>
          <div style={{ fontSize: 13, maxWidth: 420, margin: "0 auto 18px", lineHeight: 1.6 }}>
            Give {agentName} a standing job and it runs on its own — even when you&apos;re not here.
            Example: every weekday at 8am, summarize the inbox and flag anything urgent.
          </div>
          <button
            type="button"
            onClick={openNewTask}
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              border: "1px solid var(--ink-black)",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              fontSize: 10,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              padding: "9px 16px",
              cursor: "pointer",
            }}
          >
            {/* Empty state ⇒ 0 jobs ⇒ never at the free limit, so always Plus. */}
            <Plus size={13} /> Create your first task
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visibleJobs.map((job) => {
            const busy = busyJobId === job.id;
            return (
              <div
                key={job.id}
                style={{
                  border: "1px solid var(--etched-border)",
                  background: "var(--bg-surface)",
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  opacity: job.enabled ? 1 : 0.7,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="serif" style={{ fontSize: 15, color: "var(--ink-black)" }}>
                        {job.name || "Untitled task"}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          padding: "2px 6px",
                          border: "1px solid var(--etched-border)",
                          color: job.enabled ? "var(--gold-leaf)" : "var(--text-muted)",
                        }}
                      >
                        {job.enabled ? "Scheduled" : "Paused"}
                      </span>
                    </div>
                    <div className="mono" style={{ fontSize: 11, marginTop: 5, color: "var(--text-secondary)" }}>
                      {job.schedule_display || rawScheduleString(job.schedule) || "—"}
                    </div>
                  </div>
                </div>

                {/* Run-history line: last status / last error / next + last run. */}
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    flexWrap: "wrap",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    borderTop: "1px solid var(--etched-border)",
                    paddingTop: 9,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: statusColor(job),
                        display: "inline-block",
                      }}
                    />
                    <span style={labelStyle}>Last run</span>
                    {formatTime(job.last_run_at)}
                    {job.last_status ? ` · ${job.last_status}` : ""}
                  </span>
                  <span>
                    <span style={labelStyle}>Next</span> {formatTime(job.next_run_at)}
                  </span>
                  {job.last_error ? (
                    <span style={{ color: "#ef4444" }}>
                      <span style={{ ...labelStyle, color: "#ef4444" }}>Error</span> {job.last_error}
                    </span>
                  ) : null}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => void runLifecycle(job, "trigger")}
                    disabled={busy}
                    style={iconButtonStyle}
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
                  </button>
                  <button
                    type="button"
                    onClick={() => void runLifecycle(job, job.enabled ? "pause" : "resume")}
                    disabled={busy}
                    style={iconButtonStyle}
                  >
                    {job.enabled ? <Pause size={12} /> : <Play size={12} />} {job.enabled ? "Pause" : "Resume"}
                  </button>
                  <button type="button" onClick={() => openEditTask(job)} disabled={busy} style={iconButtonStyle}>
                    <Pencil size={12} /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteJob(job)}
                    disabled={busy}
                    style={{ ...iconButtonStyle, color: "#ef4444", borderColor: "rgba(239,68,68,0.4)" }}
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TaskModal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingJob(null);
        }}
        onSave={handleSave}
        saving={saving}
        agents={[agentForModal]}
        editingJobInitial={editingJob}
        editingAgentId={instanceId}
        editingProfileName={editingJob?.profileName || "default"}
      />

      {paywallOpen ? (
        <UpgradePaywallModal
          feature="cron"
          currentPlan={currentPlan ?? null}
          onClose={() => setPaywallOpen(false)}
        />
      ) : null}
    </div>
  );
}
