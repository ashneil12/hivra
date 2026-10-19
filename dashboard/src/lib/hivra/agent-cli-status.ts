// Claude Code and Codex versions on Hivra agents: what the agent's computer
// reports, which version Hivra has tested, and what that means for its owner.
//
// One interpretation for every surface: the owner API and the agents list
// (server), the automatic-update sweep (cron), and the agent header, list tag
// and Manage › Updates (client). Pure and client-safe: no I/O, no clock of its
// own, and no user copy (copy lives in the .tsx files so the vocabulary
// ratchet reads it).
//
// "Behind" always means behind Hivra's tested version (AGENT_CLI_VERSIONS in
// the release), never behind the vendor's newest release.

export const AGENT_CLI_NAMES = ["claude-code", "codex"] as const;
export type AgentCliName = (typeof AGENT_CLI_NAMES)[number];

const CLI_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const REASON = /^[a-z_]{1,40}$/;

export function isAgentCliVersion(value: unknown): value is string {
  return typeof value === "string" && CLI_VERSION.test(value);
}

/** Numeric x.y.z order: negative when a is older than b, 0 when equal. */
export function compareCliVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// ── The update_runtime host report ─────────────────────────────────────────

/**
 * The runtime updater's host-validated agent CLI line (Claude Code / Codex
 * computers): the installed version, this release's tested version
 * (AGENT_CLI_VERSIONS) and whether a background swap was scheduled. The swap
 * itself runs on the computer after the request; GET /api/meta agentCli.update
 * reports its progress. Not to be confused with that progress's own states.
 */
export type AgentCliUpdateReport = {
  name: AgentCliName;
  version: string | null;
  target: string;
  state: "current" | "scheduled" | "running" | "failed";
};

export const AGENT_CLI_LINE = /^HIVRA_AGENT_CLI name=(claude-code|codex) version=(\d{1,6}\.\d{1,6}\.\d{1,6}|unknown) target=(\d{1,6}\.\d{1,6}\.\d{1,6}) state=(current|scheduled|running|failed)$/;

export function parseAgentCliReport(stdout: string): AgentCliUpdateReport | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = AGENT_CLI_LINE.exec(line);
    if (match) {
      return {
        name: match[1] as AgentCliUpdateReport["name"],
        version: match[2] === "unknown" ? null : match[2],
        target: match[3],
        state: match[4] as AgentCliUpdateReport["state"],
      };
    }
  }
  return null;
}

// ── GET /api/meta agentCli (read with the computer's bearer) ───────────────

export const AGENT_CLI_UPDATE_STATES = ["downloading", "waiting", "installing", "done", "deferred", "rolled_back", "failed"] as const;
export type AgentCliUpdateState = (typeof AGENT_CLI_UPDATE_STATES)[number];
const IN_PROGRESS: ReadonlySet<AgentCliUpdateState> = new Set(["downloading", "waiting", "installing"]);

export function isAgentCliUpdateInProgress(state: unknown): boolean {
  return IN_PROGRESS.has(state as AgentCliUpdateState);
}

export interface AgentCliUpdateProgress {
  state: AgentCliUpdateState;
  target: string;
  updatedAt: string | null;
  reason: string | null;
}

export interface AgentCliMetaReport {
  name: AgentCliName;
  /** null: the computer couldn't read its own CLI version. */
  version: string | null;
  update: AgentCliUpdateProgress | null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The agentCli object from an authenticated GET /api/meta, strictly: an
 * unknown name, a version that isn't x.y.z, or a malformed update is refused
 * (null) rather than guessed at. `expected` is the CLI this agent runs.
 */
export function parseAgentCliMeta(value: unknown, expected: AgentCliName): AgentCliMetaReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.name !== expected) return null;
  if (raw.version !== null && !isAgentCliVersion(raw.version)) return null;
  let update: AgentCliUpdateProgress | null = null;
  if (raw.update !== undefined) {
    const candidate = raw.update;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const progress = candidate as Record<string, unknown>;
    if (!(AGENT_CLI_UPDATE_STATES as readonly string[]).includes(String(progress.state))) return null;
    if (!isAgentCliVersion(progress.target)) return null;
    if (progress.reason !== undefined && !(typeof progress.reason === "string" && REASON.test(progress.reason))) return null;
    update = {
      state: progress.state as AgentCliUpdateState,
      target: progress.target,
      updatedAt: isoOrNull(progress.updatedAt),
      reason: typeof progress.reason === "string" ? progress.reason : null,
    };
  }
  return { name: expected, version: raw.version as string | null, update };
}

// ── Which agents this covers ───────────────────────────────────────────────

/**
 * Agents whose connection service Hivra can check here: Claude Code and Codex
 * (which also report their CLI version), and the dashboard agents whose
 * connection service Hivra updates the same way. DeepSeek (whose update is
 * refused), computers and every other kind of computer are not covered.
 */
export const AGENT_SOFTWARE_TYPES = ["claude-code", "codex", "aeon", "openclaw", "agent-zero"] as const;
export type AgentSoftwareType = (typeof AGENT_SOFTWARE_TYPES)[number];

/** The agentKind each covered agent's connection service reports on /api/meta. */
const GATEWAY_KIND: Record<AgentSoftwareType, string> = {
  "claude-code": "claude",
  codex: "codex",
  aeon: "aeon",
  openclaw: "openclaw",
  "agent-zero": "agent-zero",
};

export interface AgentSoftwareSubject {
  type: AgentSoftwareType;
  /** Claude Code or Codex; null for agents that report no version of their own. */
  cli: AgentCliName | null;
  gatewayKind: string;
}

/** The agent this row describes, when Hivra can check its software here. */
export function agentSoftwareSubject(row: {
  type?: unknown;
  computer_profile?: unknown;
  computer_substrate?: unknown;
}): AgentSoftwareSubject | null {
  if (row.computer_profile != null) return null;
  if (row.computer_substrate != null && row.computer_substrate !== "proxmox-kvm") return null;
  if (!(AGENT_SOFTWARE_TYPES as readonly unknown[]).includes(row.type)) return null;
  const type = row.type as AgentSoftwareType;
  return {
    type,
    cli: type === "claude-code" || type === "codex" ? type : null,
    gatewayKind: GATEWAY_KIND[type],
  };
}

// ── The stored observation (public.hivra_agent_cli_updates) ─────────────────

/**
 * What Hivra last saw on the computer:
 * - reported: the CLI version was read (it may be null: version_unreadable);
 * - checking: the connection service is current but hasn't read its CLI
 *   version yet (a few seconds after it starts);
 * - older_connection_service: it predates version reporting;
 * - not_reported: current, and this kind of agent reports no version;
 * - unreachable: the computer couldn't be read.
 */
export const AGENT_SOFTWARE_OBSERVATIONS = [
  "reported", "checking", "version_unreadable", "older_connection_service", "unreachable", "not_reported",
] as const;
export type AgentSoftwareObservation = (typeof AGENT_SOFTWARE_OBSERVATIONS)[number];

export const AGENT_CLI_REQUEST_RESULTS = [
  "scheduled", "current", "running", "failed", "host_not_ready", "busy", "unverified", "refused",
] as const;
export type AgentCliRequestResult = (typeof AGENT_CLI_REQUEST_RESULTS)[number];

/** One hivra_agent_cli_updates row, as far as the interpretation reads it. */
export interface AgentSoftwareRecord {
  cli_name?: string | null;
  observation?: string | null;
  installed_version?: string | null;
  tested_version?: string | null;
  hivra_installed_version?: string | null;
  update_state?: string | null;
  update_target?: string | null;
  update_reason?: string | null;
  update_updated_at?: string | null;
  observed_at?: string | null;
  requested_at?: string | null;
  requested_target?: string | null;
  requested_by?: string | null;
  request_result?: string | null;
  auto_update?: boolean | null;
  auto_update_changed_at?: string | null;
  auto_paused_target?: string | null;
  auto_paused_reason?: string | null;
  updated_at?: string | null;
}

// ── The view ───────────────────────────────────────────────────────────────

export type AgentSoftwareUpdatePhase = "starting" | "downloading" | "waiting" | "installing" | "finishing";
export type AgentSoftwareFailure = "download_failed" | "install_failed" | "could_not_start";

export type AgentSoftwareView =
  | { kind: "not_running" }
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "older_connection_service" }
  | { kind: "not_reported" }
  | { kind: "version_unreadable" }
  | { kind: "current"; installed: string }
  | { kind: "behind"; installed: string }
  /** Newer than tested, and not a version Hivra put there: the owner's own. */
  | { kind: "ahead_custom"; installed: string }
  /** Newer than tested because Hivra lowered its tested version after installing it. */
  | { kind: "ahead_hivra"; installed: string }
  | { kind: "updating"; phase: AgentSoftwareUpdatePhase; target: string; installed: string | null }
  | { kind: "update_done"; target: string; installed: string }
  | { kind: "update_deferred"; target: string; installed: string | null }
  | { kind: "update_rolled_back"; target: string; installed: string | null }
  | { kind: "update_failed"; reason: AgentSoftwareFailure; target: string; installed: string | null };

export type AgentSoftwareViewKind = AgentSoftwareView["kind"];

/** A request newer than this with no progress yet reads as "starting". */
export const AGENT_CLI_PENDING_REQUEST_MS = 10 * 60_000;
/** A done swap whose new version isn't read yet reads as "finishing" this long. */
export const AGENT_CLI_FINISHING_MS = 2 * 60_000;
/** A finished update is shown as just finished for this long. */
export const AGENT_CLI_DONE_RECENT_MS = 6 * 60 * 60_000;
/** Box and server clocks may disagree by this much. */
const CLOCK_SKEW_MS = 60_000;
/**
 * The longest each step of an update can last on the computer
 * (hivra-agent-cli-update.sh: a 15-minute download, up to 6 hours waiting for
 * a reply to finish, a 10-minute install), with some margin. A step reported
 * for longer than this has ended, one way or another.
 */
export const AGENT_CLI_PHASE_LIMIT_MS: Readonly<Record<"downloading" | "waiting" | "installing", number>> = {
  downloading: 20 * 60_000,
  waiting: 6 * 60 * 60_000 + 15 * 60_000,
  installing: 15 * 60_000,
};
/** Request results after which the computer may have changed. */
const REQUEST_MAY_HAVE_RUN = new Set(["scheduled", "running", "unverified"]);

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function versionOrNull(value: unknown): string | null {
  return isAgentCliVersion(value) ? value : null;
}

export interface DeriveAgentSoftwareInput {
  subject: AgentSoftwareSubject;
  /** hivra_agents.status */
  status: string;
  /** Hivra's tested version for this CLI (AGENT_CLI_VERSIONS); null for agents without one. */
  tested: string | null;
  record: AgentSoftwareRecord | null;
  now: number;
}

function versionView(installed: string | null, tested: string, hivraInstalled: string | null): AgentSoftwareView {
  if (installed === null) return { kind: "version_unreadable" };
  const order = compareCliVersions(installed, tested);
  if (order === 0) return { kind: "current", installed };
  if (order < 0) return { kind: "behind", installed };
  return installed === hivraInstalled ? { kind: "ahead_hivra", installed } : { kind: "ahead_custom", installed };
}

/** What the owner should see about this agent's software right now. */
export function deriveAgentSoftware(input: DeriveAgentSoftwareInput): AgentSoftwareView {
  const { subject, status, tested, record, now } = input;
  if (status !== "running") return { kind: "not_running" };
  const observation = record?.observation ?? null;
  if (!observation) return { kind: "checking" };
  if (observation === "unreachable") return { kind: "unreachable" };
  if (observation === "older_connection_service") return { kind: "older_connection_service" };
  if (!subject.cli || !tested) return observation === "not_reported" ? { kind: "not_reported" } : { kind: "checking" };
  if (observation !== "reported" && observation !== "version_unreadable") return { kind: "checking" };

  const installed = observation === "reported" ? versionOrNull(record?.installed_version) : null;
  const updateAt = time(record?.update_updated_at);
  const update = record?.update_target === tested && (AGENT_CLI_UPDATE_STATES as readonly string[]).includes(String(record?.update_state))
    ? { state: record?.update_state as AgentCliUpdateState, target: tested, at: updateAt, reason: record?.update_reason ?? null }
    : null;

  // An update Hivra asked for that the computer hasn't started reporting yet.
  const requestedAt = time(record?.requested_at);
  const observedAt = time(record?.observed_at);
  const pending = record?.requested_target === tested && requestedAt !== null
    && now - requestedAt >= -CLOCK_SKEW_MS && now - requestedAt < AGENT_CLI_PENDING_REQUEST_MS
    && (!update || update.at === null || update.at < requestedAt - CLOCK_SKEW_MS);
  if (pending) {
    if (record?.request_result === "failed") return { kind: "update_failed", reason: "could_not_start", target: tested, installed };
    // No result yet: an automatic update Hivra claimed and is still sending.
    if (record?.request_result == null || record.request_result === "scheduled" || record.request_result === "running") {
      return { kind: "updating", phase: "starting", target: tested, installed };
    }
  }
  if (
    record?.requested_target === tested && requestedAt !== null
    && (record.request_result == null || REQUEST_MAY_HAVE_RUN.has(record.request_result))
    && (observedAt === null || observedAt < requestedAt)
  ) {
    // An update was sent and the computer hasn't been read since: what it
    // has now is unknown until it is read again (the last reading is older
    // than the update, so it can't say "behind").
    return { kind: "checking" };
  }

  if (update) {
    const reachedTarget = installed === update.target;
    // A deferred, rolled-back or failed update only still applies while the
    // computer has an older version (or none it can read). Once it reports
    // a newer one, the owner installed it after the update stopped: the
    // version decides, so automatic updates never move it back down.
    const stillBelowTarget = installed === null || compareCliVersions(installed, update.target) < 0;
    switch (update.state) {
      case "downloading":
      case "waiting":
      case "installing": {
        const limit = AGENT_CLI_PHASE_LIMIT_MS[update.state] + CLOCK_SKEW_MS;
        const since = update.at ?? observedAt;
        if (since === null || now - since <= limit) {
          return { kind: "updating", phase: update.state, target: update.target, installed };
        }
        // This step has run past its limit. If the computer still reported it
        // after it should have ended, its updater stopped: say what it has.
        // Otherwise it may have finished since that reading: unknown until
        // the computer is read again.
        if (update.at !== null && observedAt !== null && observedAt - update.at > limit) break;
        return { kind: "checking" };
      }
      case "done":
        if (reachedTarget) {
          if (update.at !== null && now - update.at < AGENT_CLI_DONE_RECENT_MS) return { kind: "update_done", target: update.target, installed: update.target };
          break;
        }
        // The computer reads its new version a moment after the swap.
        if (update.at !== null && now - update.at < AGENT_CLI_FINISHING_MS) {
          return { kind: "updating", phase: "finishing", target: update.target, installed };
        }
        if (installed === null) return { kind: "checking" };
        break;
      case "deferred":
        if (stillBelowTarget) return { kind: "update_deferred", target: update.target, installed };
        break;
      case "rolled_back":
        if (stillBelowTarget) return { kind: "update_rolled_back", target: update.target, installed };
        break;
      case "failed":
        if (stillBelowTarget) {
          return { kind: "update_failed", reason: update.reason === "download_failed" ? "download_failed" : "install_failed", target: update.target, installed };
        }
        break;
    }
  }
  return versionView(installed, tested, versionOrNull(record?.hivra_installed_version));
}

export type AgentSoftwareBadge = "update_available" | "updating" | "update_failed";

/** The one-word attention state the agent header and the agents list show. */
export function agentSoftwareBadge(view: AgentSoftwareView): AgentSoftwareBadge | null {
  switch (view.kind) {
    case "behind":
    case "ahead_hivra":
    case "older_connection_service":
    case "update_deferred":
      return "update_available";
    case "updating":
      return "updating";
    case "update_rolled_back":
    case "update_failed":
      return "update_failed";
    default:
      return null;
  }
}

/** What the agents list carries per agent: enough for its tag, nothing more. */
export interface AgentSoftwareSummary {
  badge: AgentSoftwareBadge | null;
  cli: AgentCliName | null;
  installed: string | null;
  tested: string | null;
}

export function summarizeAgentSoftware(view: AgentSoftwareView, subject: AgentSoftwareSubject, tested: string | null): AgentSoftwareSummary {
  const installed = "installed" in view ? view.installed : null;
  return { badge: agentSoftwareBadge(view), cli: subject.cli, installed, tested };
}

// ── Automatic updates ──────────────────────────────────────────────────────

/**
 * HIVRA_AGENT_CLI_AUTO_UPDATE, the rollout switch: off (the default, also
 * when unset or unknown) does nothing; preview only reports what it would
 * update; on updates.
 */
export type AgentCliAutoUpdateMode = "off" | "preview" | "on";

export function agentCliAutoUpdateMode(raw: string | undefined | null): AgentCliAutoUpdateMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "on" || value === "preview" ? value : "off";
}

/**
 * The owner's choice, or Hivra's default when they haven't made one: on for
 * agents on Hivra Cloud, off on the owner's own server.
 */
export function effectiveAgentCliAutoUpdate(record: AgentSoftwareRecord | null, deploymentMode: unknown): {
  enabled: boolean;
  source: "default" | "owner";
} {
  if (typeof record?.auto_update === "boolean") return { enabled: record.auto_update, source: "owner" };
  return { enabled: deploymentMode !== "self-managed", source: "default" };
}

export type AgentCliAutoSkip =
  | "not_reported"
  | "not_behind"
  | "owner_version"
  | "updating"
  | "paused";

/**
 * Whether automatic updates may move this agent to the tested version, from
 * what the computer last reported. Only a reported version counts (an older
 * connection service waits for its owner's first update), an owner's own
 * newer install is never touched, and a target that failed before stays
 * paused until the owner updates. Idle and cooldown checks come after this.
 */
export function agentCliAutoUpdateGate(view: AgentSoftwareView, record: AgentSoftwareRecord | null, tested: string):
  { ok: true } | { ok: false; skip: AgentCliAutoSkip } {
  if (record?.auto_paused_target === tested) return { ok: false, skip: "paused" };
  switch (view.kind) {
    case "behind":
    case "ahead_hivra":
    case "update_deferred":
      return { ok: true };
    case "ahead_custom":
      return { ok: false, skip: "owner_version" };
    case "updating":
      return { ok: false, skip: "updating" };
    case "update_rolled_back":
    case "update_failed":
      return { ok: false, skip: "paused" };
    case "current":
    case "update_done":
      return { ok: false, skip: "not_behind" };
    default:
      return { ok: false, skip: "not_reported" };
  }
}
