import "server-only";

import { activityControlOrigin } from "@/lib/activity-observability/collectors";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { runOnComputer } from "./install";
import { ASK_HOOK_FILE, ASK_HOOK_VERSION } from "./plugin-bundle.generated";
import { inboxAnswersEnabled } from "./prompts";

/**
 * "Ask me first" for Claude Code computers (Manage › Permissions).
 *
 * Hivra's chat runs Claude Code without its own permission prompts. With this
 * on, a PreToolUse hook (provisioner/agent-addons/hivra-ask-claude) stops before
 * every shell command and file change and waits for the owner's answer in
 * Needs you. Off by default; full-auto stays the default.
 *
 * Everything the hook trusts is root-owned on the computer: the hook itself,
 * the managed Claude Code settings that list it, the on/off file and Hivra's
 * address. The agent runs as bux and cannot switch it off from inside.
 */

const SOURCE = "agent-inbox-ask-first";
export const ASK_MARKER = "HIVRA_ASK_INSTALLED";
const ASK_TYPE = "claude-code";
const HOOK_PATH = "/opt/hivra/ask/hivra-ask-hook.py";
const MAX_PER_RUN = 3;

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Root script that installs the hook and sets the switch. Leaves other managed settings alone. */
export function buildAskFirstGuestScript(origin: string, on: boolean, file = ASK_HOOK_FILE, version = ASK_HOOK_VERSION): string {
  if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origin)) throw new Error("invalid Hivra origin");
  if (!/^[0-9a-f]{16}$/.test(version)) throw new Error("invalid hook version");
  if (!/^[A-Za-z0-9+/=]+$/.test(file)) throw new Error("invalid hook file");
  const mode = on ? "on" : "off";
  return `set -euo pipefail
export LC_ALL=C
H=/home/bux
id bux >/dev/null 2>&1 || { echo "no agent user" >&2; exit 3; }
[ "$(head -c 64 "$H/.hivra/agent-kind" 2>/dev/null | tr -d '[:space:]')" = claude ] || { echo "not a Claude Code computer" >&2; exit 3; }
[ -s "$H/.hivra/api-token" ] || { echo "no box token" >&2; exit 3; }
command -v python3 >/dev/null || { echo "python3 missing" >&2; exit 3; }
install -d -o root -g root -m 0755 /opt/hivra /opt/hivra/ask /etc/hivra /etc/claude-code
printf '%s' '${file}' | base64 -d > ${HOOK_PATH}.tmp
chown root:root ${HOOK_PATH}.tmp && chmod 0755 ${HOOK_PATH}.tmp && mv -f ${HOOK_PATH}.tmp ${HOOK_PATH}
printf '%s' '${b64(origin)}' | base64 -d > /etc/hivra/control-origin.tmp
chmod 0644 /etc/hivra/control-origin.tmp && mv -f /etc/hivra/control-origin.tmp /etc/hivra/control-origin
python3 -I -B - <<'PY'
import json, os
path = "/etc/claude-code/managed-settings.json"
cmd = "/usr/bin/python3 -I -B ${HOOK_PATH}"
try:
    with open(path, encoding="utf-8") as handle:
        settings = json.load(handle)
except FileNotFoundError:
    settings = {}
if not isinstance(settings, dict):
    raise SystemExit("managed settings are not an object; left unchanged")
hooks = settings.setdefault("hooks", {})
if not isinstance(hooks, dict):
    raise SystemExit("managed hooks are not an object; left unchanged")
pre = hooks.setdefault("PreToolUse", [])
if not isinstance(pre, list):
    raise SystemExit("managed PreToolUse hooks are not a list; left unchanged")
pre[:] = [e for e in pre if not (isinstance(e, dict) and any(isinstance(h, dict) and h.get("command") == cmd for h in e.get("hooks", [])))]
pre.append({"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit", "hooks": [{"type": "command", "command": cmd, "timeout": 600}]})
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(settings, handle, indent=2)
    handle.write("\\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
printf '%s\\n' '${mode}' > /etc/hivra/ask-first.tmp
chmod 0644 /etc/hivra/ask-first.tmp && mv -f /etc/hivra/ask-first.tmp /etc/hivra/ask-first
echo ${ASK_MARKER} ${version} ${mode}
`;
}

export interface AskFirstState { available: boolean; enabled: boolean }

type AgentRow = Record<string, unknown> & { id: string; user_id: string; type: string; status: string };

async function ownedAgent(userId: string, agentId: string): Promise<AgentRow | null> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("*")
    .eq("id", agentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`could not load the agent: ${error.message}`);
  const row = data as AgentRow | null;
  return row && row.status !== "deleted" ? row : null;
}

/** Whether "Ask me first" can be offered on this agent, and whether it is on. Null when not the owner's. */
export async function readAskFirst(userId: string, agentId: string): Promise<AskFirstState | null> {
  const agent = await ownedAgent(userId, agentId);
  if (!agent) return null;
  if (!inboxAnswersEnabled() || agent.type !== ASK_TYPE) return { available: false, enabled: false };
  const { data, error } = await supabaseAdmin!
    .from("agent_inbox_installs")
    .select("ask_first")
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (error) throw new Error(`could not read Ask me first: ${error.message}`);
  return { available: true, enabled: Boolean((data as { ask_first?: boolean } | null)?.ask_first) };
}

export type SetAskFirstResult =
  | { ok: true; state: AskFirstState }
  | { ok: false; status: 404 | 409 | 502; message: string };

/** Turn "Ask me first" on or off. Changes the computer first, then records it. */
export async function setAskFirst(userId: string, agentId: string, on: boolean, now = new Date()): Promise<SetAskFirstResult> {
  const agent = await ownedAgent(userId, agentId);
  if (!agent) return { ok: false, status: 404, message: "Agent not found" };
  if (!inboxAnswersEnabled() || agent.type !== ASK_TYPE) return { ok: false, status: 409, message: "Ask me first is only for Claude Code agents." };
  if (agent.status !== "running") return { ok: false, status: 409, message: "Start this agent first, then change Ask me first." };
  const origin = activityControlOrigin();
  if (!origin) return { ok: false, status: 409, message: "Ask me first is not available right now." };
  let outcome: { ok: boolean; detail: string };
  try {
    outcome = await runOnComputer(userId, agent, buildAskFirstGuestScript(origin, on), `${ASK_MARKER} ${ASK_HOOK_VERSION} ${on ? "on" : "off"}`);
  } catch (cause) {
    outcome = { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!outcome.ok) {
    log.warn("could not change Ask me first on a Claude Code computer", {
      source: SOURCE, failureType: "ask_first_apply_failed", agentId, errorDescription: outcome.detail.slice(0, 300),
    });
    return { ok: false, status: 502, message: "Couldn't reach this agent's computer. Try again in a minute." };
  }
  const { error } = await supabaseAdmin!.from("agent_inbox_installs").upsert({
    agent_id: agent.id, ask_first: on, version: ASK_HOOK_VERSION, installed_at: now.toISOString(),
    attempted_at: now.toISOString(), attempts: 0, last_error: null,
  }, { onConflict: "agent_id" });
  if (error) throw new Error(`could not save Ask me first: ${error.message}`);
  return { ok: true, state: { available: true, enabled: on } };
}

/**
 * Cron: when the hook changes, put the new one on Claude Code computers that
 * have "Ask me first" on. Computers where it is off need nothing: the old hook
 * does nothing while the switch is off, and turning it on installs the latest.
 */
export async function sweepAskHookUpdates(now = new Date()): Promise<{ tried: number; installed: number; failed: number }> {
  const none = { tried: 0, installed: 0, failed: 0 };
  if (!inboxAnswersEnabled() || !supabaseAdmin) return none;
  const origin = activityControlOrigin();
  if (!origin) return none;
  const db = supabaseAdmin;
  const { data: rows, error } = await db
    .from("agent_inbox_installs")
    .select("agent_id, version, attempted_at, attempts")
    .eq("ask_first", true)
    .neq("version", ASK_HOOK_VERSION)
    .limit(50);
  if (error) throw new Error(`could not read Ask me first installs: ${error.message}`);
  const stale = (rows ?? []) as { agent_id: string; version: string | null; attempted_at: string | null; attempts: number }[];
  if (!stale.length) return none;
  const { data: agents, error: agentError } = await db
    .from("hivra_agents")
    .select("*")
    .in("id", stale.map((row) => row.agent_id))
    .eq("type", ASK_TYPE)
    .eq("status", "running")
    // A sleeping computer cannot take the hook, and a try on one would count as a failed attempt.
    .eq("sleep_state", "awake");
  if (agentError) throw new Error(`could not list Claude Code computers: ${agentError.message}`);
  const due = ((agents ?? []) as AgentRow[]).filter((agent) => {
    const row = stale.find((r) => r.agent_id === agent.id);
    if (!row?.attempted_at || row.attempts <= 0) return true;
    return now.getTime() - Date.parse(row.attempted_at) >= Math.min(15 * 2 ** Math.max(row.attempts - 1, 0), 360) * 60_000;
  }).slice(0, MAX_PER_RUN);
  let installed = 0;
  let failed = 0;
  for (const agent of due) {
    const attempts = (stale.find((r) => r.agent_id === agent.id)?.attempts ?? 0) + 1;
    await db.from("agent_inbox_installs").update({ attempted_at: now.toISOString(), attempts }).eq("agent_id", agent.id);
    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await runOnComputer(String(agent.user_id), agent, buildAskFirstGuestScript(origin, true), `${ASK_MARKER} ${ASK_HOOK_VERSION} on`);
    } catch (cause) {
      outcome = { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
    if (outcome.ok) {
      installed += 1;
      await db.from("agent_inbox_installs").update({ version: ASK_HOOK_VERSION, installed_at: new Date().toISOString(), attempts: 0, last_error: null }).eq("agent_id", agent.id);
    } else {
      failed += 1;
      await db.from("agent_inbox_installs").update({ last_error: outcome.detail.slice(0, 300) }).eq("agent_id", agent.id);
      log.warn("could not update the Ask me first hook", { source: SOURCE, failureType: "ask_first_update_failed", agentId: agent.id, attempts });
    }
  }
  return { tried: due.length, installed, failed };
}
