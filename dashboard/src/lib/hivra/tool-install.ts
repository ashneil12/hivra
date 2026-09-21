import "server-only";

// Tool installer (Wave 6) — install a curated TOOL onto a running Hivra CLI box.
// A tool is the join of an MCP server (+ its credentials) and, optionally, the
// curated skills that teach its use. Installing one fans out to the two existing
// SSH delivery paths:
//   1. applyToolMcpOnBox   — register the MCP server with its per-server env
//   2. installCuratedSkillsOnBox — seed the tool's teaching skills (if any)
//
// The MCP write is the load-bearing step (it carries the credentials); skills are
// a best-effort follow-on. We do the MCP write FIRST and only report a tool
// installed if that succeeds — a skills-only failure degrades the tool but doesn't
// leave a credential half-delivered. promptFragment is intentionally NOT applied
// in v1 (it would race the persona SOUL clobber; see the plan) — the field is
// carried for a later, guarded iteration.

import { CURATED_TOOLS, getToolById, isInstallableToolEntry, isToolSupportedOnKind, type ToolEntry } from "@/data/curated-tools";
import {
  applyToolMcpOnBox,
  toolMcpKindForType,
  type ToolMcpServerSpec,
} from "@/lib/hivra/tool-mcp-seed";
import { installCuratedSkillsOnBox } from "@/lib/hivra/skill-install";
import type { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

export interface ToolInstallAgent {
  id: string;
  type?: string | null;
  ip?: string | null;
}

/** One requested install: the tool id and the env values the user supplied. */
export interface ToolInstallRequest {
  id: string;
  /** User-entered values, keyed by the tool's declared env keys. */
  env?: Record<string, string>;
}

/** Why a requested tool was not installed — surfaced so a caller can tell a
 *  missing-key skip (actionable) apart from an unknown-id skip (a bug). */
type ToolSkipReason =
  | "unknown"
  | "not-installable"
  | "missing-required-key"
  | "invalid-value"
  | "unsupported-on-codex"
  | "unsupported-agent"
  | "invalid-box";

interface ToolSkip {
  id: string;
  reason: ToolSkipReason;
}

export interface ToolInstallResult {
  ok: boolean;
  /** Tool ids whose MCP server was written to the box. */
  installed: string[];
  /** Requested ids that were not installed, each with a reason. */
  skipped: ToolSkip[];
  /** Tool ids whose MCP landed but whose teaching skills failed to seed. */
  skillsFailed?: string[];
  error?: string;
}

/** Env-field metadata for the install form (no values — those are user input). */
export interface ToolEnvFieldMeta {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

/** Content-light tool metadata for the picker. No MCP command detail leaks. */
export interface InstallableToolMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  trust: ToolEntry["trust"];
  repoUrl?: string;
  /** The box MCP server name — used to diff installed-vs-available against the
   *  live box MCP list. Not sensitive (a server name), no command/env exposed. */
  mcpName: string;
  env: ToolEnvFieldMeta[];
  /** How many teaching skills this tool also installs. */
  skillCount: number;
}

function toMeta(t: ToolEntry): InstallableToolMeta {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    trust: t.trust,
    repoUrl: t.repoUrl,
    mcpName: t.mcp.name,
    env: (t.env ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      required: f.required,
      placeholder: f.placeholder,
    })),
    skillCount: (t.skillIds ?? []).length,
  };
}

/**
 * The installable slice of the tool catalog for a given box flavor. Filters out
 * unbuilt `requires` tools and (on codex) hosted http tools, so the picker never
 * offers something that would just come back skipped.
 */
export function listInstallableToolMeta(kind: "claude" | "codex" = "claude"): InstallableToolMeta[] {
  return CURATED_TOOLS.filter(
    (t) => isInstallableToolEntry(t) && isToolSupportedOnKind(t, kind),
  ).map(toMeta);
}

/** Result of resolving a requested tool: a writable spec, or a reason it can't be. */
export type ToolResolveResult = { spec: ToolMcpServerSpec } | { skip: ToolSkipReason };

/** Env values are user free-text bound for the SHARED box config. Bound their
 *  size, and reject control chars (incl. U+007F) that would produce an invalid
 *  TOML basic string and corrupt ~/.codex/config.toml for every tool on the box. */
const MAX_ENV_VALUE_LEN = 8192;
const FORBIDDEN_ENV_VALUE_RE = /[\u0000-\u001f\u007f]/;

/**
 * Resolve a requested tool + its user env into the MCP server spec to write, or a
 * skip reason (unknown id / not installable / a REQUIRED key missing / a tainted
 * value). Only declared env keys are carried through — unknown keys the client
 * sent are dropped (no smuggling arbitrary env onto the box).
 */
/** Substitute `{ENV_KEY}` placeholders from the collected env values. */
function fillPlaceholders(s: string, env: Record<string, string>): string {
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => (k in env ? env[k] : m));
}

export function resolveToolMcpSpec(
  req: ToolInstallRequest,
  kind: "claude" | "codex" = "claude",
): ToolResolveResult {
  const tool = getToolById(req.id);
  if (!tool) return { skip: "unknown" };
  if (!isInstallableToolEntry(tool)) return { skip: "not-installable" };
  if (!isToolSupportedOnKind(tool, kind)) return { skip: "unsupported-on-codex" };
  const suppliedEnv = req.env && typeof req.env === "object" ? req.env : {};
  const env: Record<string, string> = {};
  for (const field of tool.env ?? []) {
    const raw = suppliedEnv[field.key];
    const val = typeof raw === "string" ? raw.trim() : "";
    if (!val) {
      if (field.required) return { skip: "missing-required-key" };
      continue; // optional + blank -> omit
    }
    if (val.length > MAX_ENV_VALUE_LEN || FORBIDDEN_ENV_VALUE_RE.test(val)) {
      if (field.required) return { skip: "invalid-value" };
      continue; // optional + tainted -> omit rather than corrupt the config
    }
    env[field.key] = val;
  }

  const transport = tool.mcp.transport ?? "stdio";
  if (transport === "http") {
    // Hosted endpoint: credentials ride auth HEADERS, not an env block. Any header
    // whose placeholder went unfilled (optional key omitted) is dropped.
    const headers: Record<string, string> = {};
    for (const [h, tpl] of Object.entries(tool.mcp.headers ?? {})) {
      const filled = fillPlaceholders(tpl, env);
      if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(filled)) continue; // unresolved -> drop
      headers[h] = filled;
    }
    return {
      spec: { name: tool.mcp.name, transport: "http", url: String(tool.mcp.url), headers },
    };
  }

  return {
    spec: {
      name: tool.mcp.name,
      transport: "stdio",
      command: String(tool.mcp.command),
      // Arg placeholders let tools that only take CLI-flag credentials work.
      args: (tool.mcp.args ?? []).map((a) => fillPlaceholders(String(a), env)),
      env,
    },
  };
}

/**
 * Install the given tools onto a running box. All tools target the SAME box, so
 * they share one agent type -> one MCP kind, and every installable tool's MCP
 * server is written in a SINGLE host->guest round-trip. Teaching skills are then
 * seeded in one more round-trip (their own idempotent path).
 *
 * On MCP transport failure NOTHING is reported installed (the write is one atomic
 * guest script) and `error` is set. A skills-only failure still reports the tools
 * installed (their credentials landed) but lists them in `skillsFailed`.
 */
export async function installToolsOnBox(
  agent: ToolInstallAgent,
  requests: ToolInstallRequest[],
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<ToolInstallResult> {
  const kind = toolMcpKindForType(agent.type);
  if (!kind) {
    return { ok: false, installed: [], skipped: requests.map((r) => ({ id: r.id, reason: "unsupported-agent" as const })), error: "unsupported agent type" };
  }
  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) {
    return { ok: false, installed: [], skipped: requests.map((r) => ({ id: r.id, reason: "invalid-box" as const })), error: "missing or invalid box ip" };
  }

  const servers: ToolMcpServerSpec[] = [];
  const installedIds: string[] = [];
  const skipped: ToolSkip[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    if (seen.has(req.id)) continue;
    seen.add(req.id);
    const resolved = resolveToolMcpSpec(req, kind);
    if ("skip" in resolved) {
      skipped.push({ id: req.id, reason: resolved.skip });
      continue;
    }
    servers.push(resolved.spec);
    installedIds.push(req.id);
  }

  if (servers.length === 0) {
    // Nothing installable — succeed iff there was genuinely nothing to do.
    return { ok: skipped.length === 0, installed: [], skipped };
  }

  const mcpRes = await applyToolMcpOnBox(kind, "add", ip, servers, env);
  if (!mcpRes.ok) {
    return { ok: false, installed: [], skipped, error: mcpRes.error };
  }

  // Best-effort: seed the union of teaching skills for the installed tools.
  const skillIds = Array.from(
    new Set(installedIds.flatMap((id) => getToolById(id)?.skillIds ?? [])),
  );
  let skillsFailed: string[] | undefined;
  if (skillIds.length > 0) {
    const skillRes = await installCuratedSkillsOnBox(
      { id: agent.id, type: agent.type ?? null, ip: agent.ip ?? null },
      skillIds,
      env,
    );
    if (!skillRes.ok) {
      // MCP already landed; flag which tools carried skills that didn't seed.
      skillsFailed = installedIds.filter((id) => (getToolById(id)?.skillIds ?? []).length > 0);
    }
  }

  return { ok: true, installed: installedIds, skipped, ...(skillsFailed ? { skillsFailed } : {}) };
}

/**
 * Uninstall a tool: remove its MCP server from the box config. Teaching skills are
 * intentionally LEFT in place (they're inert markdown without the MCP server, and
 * may be shared with other tools). Idempotent — removing an absent server is a
 * no-op success.
 */
export async function uninstallToolFromBox(
  agent: ToolInstallAgent,
  toolId: string,
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<{ ok: boolean; error?: string }> {
  const kind = toolMcpKindForType(agent.type);
  if (!kind) return { ok: false, error: "unsupported agent type" };
  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) return { ok: false, error: "missing or invalid box ip" };
  const tool = getToolById(toolId);
  if (!tool) return { ok: false, error: "unknown tool" };
  const res = await applyToolMcpOnBox(kind, "remove", ip, [
    { name: tool.mcp.name, command: "", args: [], env: {} },
  ], env);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
