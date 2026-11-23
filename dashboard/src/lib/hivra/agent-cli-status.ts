// The agent software Hivra updates on Hivra agents (the Claude Code and Codex
// CLIs, and the Aeon dashboard, OpenClaw, Agent Zero, Hermes, OpenBot and
// Nuphos apps): what the agent's computer reports and what that means for its
// owner.
//
// One interpretation for every surface: the owner API and the agents list
// (server), and the agent header, list tag and Manage › Updates (client). Pure
// and client-safe: no I/O, no clock of its own, and no user copy (copy lives in
// the .tsx files so the vocabulary ratchet reads it).
//
// Hivra pins no version of any agent. A launch installs the newest release its
// upstream publishes at that moment, and after that only the owner changes it:
// the Update button (which installs upstream's newest release, the literal
// update target `latest`), or the agent's own update command. There is no
// tested version, no "behind", and no automatic update.

import {
  isCatalogAppId,
  UNIVERSAL_CATALOG_IDS,
  type UniversalCatalogAppId,
} from "./catalog-manifests";

export const AGENT_CLI_NAMES = ["claude-code", "codex"] as const;
export type AgentCliName = (typeof AGENT_CLI_NAMES)[number];
export const AGENT_APP_NAMES = ["aeon", "openclaw", "agent-zero", "hermes", "openbot", "nuphos", ...UNIVERSAL_CATALOG_IDS] as const;
export type AgentAppName = (typeof AGENT_APP_NAMES)[number];
/** What Hivra updates on the agent: its CLI or its hosted app. */
export type AgentSoftwareName = AgentCliName | AgentAppName;

const CLI_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const CATALOG_APP_VERSION = /^(?:sha256:[0-9a-f]{64}|v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9._-]{1,32})?|latest)$/;
const REASON = /^[a-z_]{1,40}$/;
/**
 * How each one names a version: an x.y.z release (the CLIs, OpenClaw), the
 * upstream commit Aeon's dashboard is built from, or Agent Zero's image digest.
 */
const UNIVERSAL_SOFTWARE_VERSIONS = Object.fromEntries(
  UNIVERSAL_CATALOG_IDS.map((id) => [id, CATALOG_APP_VERSION]),
) as unknown as Record<UniversalCatalogAppId, RegExp>;

const SOFTWARE_VERSION: Readonly<Record<AgentSoftwareName, RegExp>> = {
  "claude-code": CLI_VERSION,
  codex: CLI_VERSION,
  openclaw: CLI_VERSION,
  aeon: /^[0-9a-f]{40}$/,
  "agent-zero": /^sha256:[0-9a-f]{64}$/,
  // Hermes Agent's release, as `hermes --version` prints it (vX.Y.Z).
  hermes: CLI_VERSION,
  // OpenBot's release (x.y.z).
  openbot: CLI_VERSION,
  // Nuphos runtime release (x.y.z).
  nuphos: CLI_VERSION,
  ...UNIVERSAL_SOFTWARE_VERSIONS,
};

/**
 * What every update aims at: Hivra pins no version, so the updater resolves
 * the literal target `latest` to the newest release upstream publishes.
 */
export const AGENT_UPDATE_TARGET = "latest";

/** An update target: only the literal `latest`, since Hivra pins no version. */
export function isAgentSoftwareTarget(_name: AgentSoftwareName, value: unknown): value is string {
  return value === AGENT_UPDATE_TARGET;
}

/** A version in the form this software names its versions. */
export function isAgentSoftwareVersion(name: AgentSoftwareName, value: unknown): value is string {
  return typeof value === "string" && SOFTWARE_VERSION[name].test(value);
}

// ── The update_runtime host report ─────────────────────────────────────────

/**
 * The runtime updater's host-validated agent CLI line (Claude Code / Codex
 * computers): the installed version, the update target (always `latest`) and
 * whether a background swap was scheduled. The swap
 * itself runs on the computer after the request; GET /api/meta agentCli.update
 * reports its progress. Not to be confused with that progress's own states.
 */
export type AgentCliUpdateReport = {
  name: AgentCliName;
  version: string | null;
  target: string;
  state: "current" | "scheduled" | "running" | "failed";
};

/** The same report for an agent app (HIVRA_AGENT_APP line). */
export type AgentAppUpdateReport = {
  name: AgentAppName;
  version: string | null;
  target: string;
  state: AgentCliUpdateReport["state"];
};
export type AgentSoftwareUpdateReport = AgentCliUpdateReport | AgentAppUpdateReport;

export const AGENT_CLI_LINE = /^HIVRA_AGENT_CLI name=(claude-code|codex) version=(\d{1,6}\.\d{1,6}\.\d{1,6}|unknown) target=(latest) state=(current|scheduled|running|failed)$/;

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

export const AGENT_APP_LINE = /^HIVRA_AGENT_APP name=([a-z][a-z0-9-]{1,38}[a-z0-9]) version=(\S{1,80}) target=(\S{1,80}) state=(current|scheduled|running|failed)$/;

/** The runtime updater's host-validated agent app line, each version in its app's own form. */
export function parseAgentAppReport(stdout: string): AgentAppUpdateReport | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = AGENT_APP_LINE.exec(line);
    if (!match) continue;
    if (!(AGENT_APP_NAMES as readonly string[]).includes(match[1])) continue;
    const name = match[1] as AgentAppName;
    const version = match[2] === "unknown" ? null : match[2];
    if (version !== null && !isAgentSoftwareVersion(name, version)) return null;
    if (!isAgentSoftwareTarget(name, match[3])) return null;
    return { name, version, target: match[3], state: match[4] as AgentAppUpdateReport["state"] };
  }
  return null;
}

// ── GET /api/meta agentCli / agentApp (read with the computer's bearer) ────

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
  name: AgentSoftwareName;
  /** null: the computer couldn't read (or, for an app, hasn't recorded) its version. */
  version: string | null;
  update: AgentCliUpdateProgress | null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The agentCli (or agentApp) object from an authenticated GET /api/meta,
 * strictly: an unknown name, a version not in the software's own form, or a
 * malformed update is refused (null) rather than guessed at. `expected` is the
 * CLI or app this agent runs.
 */
export function parseAgentCliMeta(value: unknown, expected: AgentSoftwareName): AgentCliMetaReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.name !== expected) return null;
  if (raw.version !== null && !isAgentSoftwareVersion(expected, raw.version)) return null;
  let update: AgentCliUpdateProgress | null = null;
  if (raw.update !== undefined) {
    const candidate = raw.update;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const progress = candidate as Record<string, unknown>;
    if (!(AGENT_CLI_UPDATE_STATES as readonly string[]).includes(String(progress.state))) return null;
    if (!isAgentSoftwareTarget(expected, progress.target)) return null;
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
 * Agents whose software Hivra checks and updates here: Claude Code and Codex
 * (their CLI) and the Aeon, OpenClaw and Agent Zero agents (their hosted app),
 * each through the same in-place connection-service update. DeepSeek (whose
 * update is refused), computers and every other kind of computer are not
 * covered.
 */
export const AGENT_SOFTWARE_TYPES = ["claude-code", "codex", "aeon", "openclaw", "agent-zero", "hermes", "openbot", "nuphos", ...UNIVERSAL_CATALOG_IDS] as const;
export type AgentSoftwareType = (typeof AGENT_SOFTWARE_TYPES)[number];

const UNIVERSAL_GATEWAY_KINDS = Object.fromEntries(
  UNIVERSAL_CATALOG_IDS.map((id) => [id, "catalog-app"]),
) as unknown as Record<UniversalCatalogAppId, string>;

/** The agentKind each covered agent's connection service reports on /api/meta. */
const GATEWAY_KIND: Record<AgentSoftwareType, string> = {
  "claude-code": "claude",
  codex: "codex",
  aeon: "aeon",
  openclaw: "openclaw",
  "agent-zero": "agent-zero",
  hermes: "hermes",
  openbot: "openbot",
  nuphos: "nuphos",
  ...UNIVERSAL_GATEWAY_KINDS,
};

export interface AgentSoftwareSubject {
  type: AgentSoftwareType;
  /** Claude Code or Codex; null for the app agents. */
  cli: AgentCliName | null;
  /** The Aeon dashboard, OpenClaw, Agent Zero, Hermes, or a universal catalog app; null for the CLI agents. */
  app: AgentAppName | null;
  /** Whichever of the two this agent runs. */
  software: AgentSoftwareName;
  gatewayKind: string;
}

/** The agent this row describes, when Hivra can check its software here. */
export function agentSoftwareSubject(row: {
  type?: unknown;
  computer_profile?: unknown;
  computer_substrate?: unknown;
}): AgentSoftwareSubject | null {
  if (row.computer_profile != null) return null;
  // Proxmox computers (Hivra Cloud or the owner's server) and "My cloud"
  // computers (a provider VM the owner pays for) update through the same
  // in-guest scripts; every other substrate has its own update path.
  if (row.computer_substrate != null && row.computer_substrate !== "proxmox-kvm" && row.computer_substrate !== "provider-vm") return null;
  if (!(AGENT_SOFTWARE_TYPES as readonly unknown[]).includes(row.type)) return null;
  const type = row.type as AgentSoftwareType;
  const cli = type === "claude-code" || type === "codex" ? type : null;
  const app = type === "aeon" || type === "openclaw" || type === "agent-zero" || type === "hermes" || type === "openbot" || type === "nuphos" || isCatalogAppId(type) ? type : null;
  return {
    type,
    cli,
    app,
    software: (cli ?? app) as AgentSoftwareName,
    gatewayKind: GATEWAY_KIND[type],
  };
}

// ── The stored observation (public.hivra_agent_cli_updates) ─────────────────

/**
 * What Hivra last saw on the computer:
 * - reported: the CLI or app version was read (it may be null:
 *   version_unreadable);
 * - checking: the connection service is current but hasn't read the version
 *   yet (a few seconds after it starts);
 * - older_connection_service: it predates version reporting;
 * - not_reported: current, but it reports no version for this kind of agent
 *   (a connection service from before app versions were reported);
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
export type AgentSoftwareFailure = "download_failed" | "install_failed" | "could_not_start" | "no_space"
  /** Hermes: `hermes update` stopped because its install has changes of the owner's own. */
  | "local_changes";

export type AgentSoftwareView =
  | { kind: "not_running" }
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "older_connection_service" }
  | { kind: "not_reported" }
  | { kind: "version_unreadable" }
  | { kind: "current"; installed: string }
  | { kind: "updating"; phase: AgentSoftwareUpdatePhase; target: string; installed: string | null }
  | { kind: "update_done"; target: string; installed: string }
  | { kind: "update_deferred"; target: string; installed: string | null }
  | { kind: "update_rolled_back"; target: string; installed: string | null }
  | { kind: "update_failed"; reason: AgentSoftwareFailure; target: string; installed: string | null };

/** A request newer than this with no progress yet reads as "starting". */
export const AGENT_CLI_PENDING_REQUEST_MS = 10 * 60_000;
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
/**
 * The same for an app (hivra-agent-app-update.sh): an Aeon dashboard build
 * (10-minute fetch, 30-minute install, 30-minute build) or an Agent Zero image
 * pull of up to an hour; an install that may copy Agent Zero's data aside and
 * waits up to 3 minutes for the app to answer.
 */
export const AGENT_APP_PHASE_LIMIT_MS: Readonly<Record<"downloading" | "waiting" | "installing", number>> = {
  downloading: 95 * 60_000,
  waiting: 6 * 60 * 60_000 + 15 * 60_000,
  installing: 60 * 60_000,
};
function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface DeriveAgentSoftwareInput {
  subject: AgentSoftwareSubject;
  /** hivra_agents.status */
  status: string;
  record: AgentSoftwareRecord | null;
  now: number;
}

/** An update that stopped is shown this long, unless a newer one replaces it. */
export const AGENT_UPDATE_FAILURE_SHOWN_MS = 24 * 60 * 60_000;

/**
 * What the owner should see about this agent's software right now. Hivra pins
 * no version, so there is nothing to be behind: it is the installed version,
 * an update in progress, or what the last update did.
 */
export function deriveAgentSoftware(input: DeriveAgentSoftwareInput): AgentSoftwareView {
  const { subject, status, record, now } = input;
  if (status !== "running") return { kind: "not_running" };
  const observation = record?.observation ?? null;
  if (!observation) return { kind: "checking" };
  if (observation === "unreachable") return { kind: "unreachable" };
  if (observation === "older_connection_service") return { kind: "older_connection_service" };
  if (observation === "not_reported") return { kind: "not_reported" };
  if (observation !== "reported" && observation !== "version_unreadable") return { kind: "checking" };
  const installed = observation === "reported" && isAgentSoftwareVersion(subject.software, record?.installed_version)
    ? record.installed_version : null;
  const updateAt = time(record?.update_updated_at);
  const state = (AGENT_CLI_UPDATE_STATES as readonly string[]).includes(String(record?.update_state))
    ? record?.update_state as AgentCliUpdateState : null;
  const target = AGENT_UPDATE_TARGET;
  const requestedAt = time(record?.requested_at);
  const observedAt = time(record?.observed_at);
  const hasUpdate = state !== null && isAgentSoftwareTarget(subject.software, record?.update_target)
    && (updateAt === null || requestedAt === null || updateAt >= requestedAt - CLOCK_SKEW_MS);

  // An update the owner asked for that the computer hasn't started reporting yet.
  if (requestedAt !== null && record?.requested_target === AGENT_UPDATE_TARGET
    && now - requestedAt >= -CLOCK_SKEW_MS && now - requestedAt < AGENT_CLI_PENDING_REQUEST_MS && !hasUpdate) {
    if (record.request_result === "failed") return { kind: "update_failed", reason: "could_not_start", target, installed };
    if (record.request_result == null || record.request_result === "scheduled" || record.request_result === "running") {
      return { kind: "updating", phase: "starting", target, installed };
    }
  }
  if (state !== null && hasUpdate) {
    switch (state) {
      case "downloading":
      case "waiting":
      case "installing": {
        const limit = (subject.app ? AGENT_APP_PHASE_LIMIT_MS : AGENT_CLI_PHASE_LIMIT_MS)[state] + CLOCK_SKEW_MS;
        const since = updateAt ?? observedAt;
        if (since === null || now - since <= limit) return { kind: "updating", phase: state, target, installed };
        break;
      }
      case "done":
        if (installed !== null && updateAt !== null && now - updateAt < AGENT_CLI_DONE_RECENT_MS) {
          return { kind: "update_done", target: installed, installed };
        }
        break;
      case "deferred":
        if (updateAt !== null && now - updateAt < AGENT_UPDATE_FAILURE_SHOWN_MS) return { kind: "update_deferred", target, installed };
        break;
      case "rolled_back":
        if (updateAt !== null && now - updateAt < AGENT_UPDATE_FAILURE_SHOWN_MS) return { kind: "update_rolled_back", target, installed };
        break;
      case "failed":
        if (updateAt !== null && now - updateAt < AGENT_UPDATE_FAILURE_SHOWN_MS) {
          const reason: AgentSoftwareFailure = record?.update_reason === "local_changes" ? "local_changes"
            : record?.update_reason === "no_space" ? "no_space"
            : record?.update_reason === "download_failed" ? "download_failed"
            : record?.update_reason === "not_installed" ? "could_not_start"
            : "install_failed";
          return { kind: "update_failed", reason, target, installed };
        }
        break;
      default:
        break;
    }
  }
  return installed === null ? { kind: "version_unreadable" } : { kind: "current", installed };
}

export type AgentSoftwareBadge = "update_available" | "updating" | "update_failed";

/**
 * The one-word attention state the agent header and the agents list show.
 * Hivra doesn't know when upstream has a newer release than the one installed,
 * so "update available" only means an older connection service or an update
 * that is still waiting to run.
 */
export function agentSoftwareBadge(view: AgentSoftwareView): AgentSoftwareBadge | null {
  switch (view.kind) {
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
  app: AgentAppName | null;
  installed: string | null;
}

export function summarizeAgentSoftware(view: AgentSoftwareView, subject: AgentSoftwareSubject): AgentSoftwareSummary {
  const installed = "installed" in view ? view.installed : null;
  return { badge: agentSoftwareBadge(view), cli: subject.cli, app: subject.app, installed };
}
