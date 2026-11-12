import "server-only";

import { activityControlOrigin } from "@/lib/activity-observability/collectors";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { buildPinnedGuestHostScript, resolvePinnedGuestTarget } from "@/lib/hivra/pinned-guest-seed";
import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { INBOX_PLUGIN_FILES, INBOX_PLUGIN_VERSION } from "./plugin-bundle.generated";
import { inboxAnswersEnabled } from "./prompts";

/**
 * Puts the hivra-inbox plugin on running Hermes computers, once per plugin
 * version, and turns it on with Hermes's own `hermes plugins enable`. The
 * gateway picks it up through Hermes's graceful `hermes gateway restart`,
 * which lets running replies finish first.
 */

const SOURCE = "agent-inbox-install";
export const INSTALLED_MARKER = "HIVRA_INBOX_INSTALLED";
const PLUGIN_NAME = "hivra-inbox";
const MAX_PER_RUN = 3;
const GUEST_TIMEOUT_MS = 150_000;

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Root script for the computer (run through the pinned guest route). */
export function buildInboxInstallGuestScript(origin: string, files = INBOX_PLUGIN_FILES, version = INBOX_PLUGIN_VERSION): string {
  if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origin)) throw new Error("invalid Hivra origin");
  if (!/^[0-9a-f]{16}$/.test(version)) throw new Error("invalid plugin version");
  const writes = Object.entries(files).map(([name, body]) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("invalid plugin file");
    return `printf '%s' '${body}' | base64 -d > "$P/${name}.tmp" && mv -f "$P/${name}.tmp" "$P/${name}"`;
  });
  return `set -euo pipefail
export LC_ALL=C
H=/home/bux
id bux >/dev/null 2>&1 || { echo "no agent user" >&2; exit 3; }
[ "$(head -c 64 "$H/.hivra/agent-kind" 2>/dev/null | tr -d '[:space:]')" = hermes ] || { echo "not a Hermes computer" >&2; exit 3; }
[ -s "$H/.hivra/api-token" ] || { echo "no box token" >&2; exit 3; }
HERMES="$H/.local/bin/hermes"
[ -x "$HERMES" ] || { echo "Hermes is not installed" >&2; exit 3; }
P="$H/.hermes/plugins/${PLUGIN_NAME}"
install -d -o bux -g bux -m 0755 "$H/.hermes" "$H/.hermes/plugins" "$P"
${writes.join("\n")}
printf '%s\\n' '${version}' > "$P/.hivra-version"
chown -R bux:bux "$P"
chmod 0644 "$P"/*
printf '%s' '${b64(origin)}' | base64 -d > "$H/.hivra/control-origin"
chown bux:bux "$H/.hivra/control-origin"
chmod 0644 "$H/.hivra/control-origin"
uid="$(id -u bux)"
ubux() {
  timeout -k 10 120 sudo -u bux -H env HOME="$H" XDG_RUNTIME_DIR="/run/user/$uid" \\
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" PATH="$H/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}
ubux "$HERMES" plugins enable ${PLUGIN_NAME} </dev/null >/dev/null
ubux "$HERMES" gateway restart </dev/null >/dev/null 2>&1 || echo "gateway restart deferred" >&2
echo ${INSTALLED_MARKER} ${version}
`;
}

export interface InstallRow { agent_id: string; version: string | null; attempted_at: string | null; attempts: number }

/** Minutes to wait before trying a computer again: 15, 30, 60 ... up to 6 hours. */
export function retryAfterMinutes(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(attempts - 1, 0), 360);
}

export function needsInstall(install: InstallRow | undefined, now: number, version = INBOX_PLUGIN_VERSION): boolean {
  if (!install) return true;
  if (install.version === version) return false;
  if (!install.attempted_at || install.attempts <= 0) return true;
  return now - Date.parse(install.attempted_at) >= retryAfterMinutes(install.attempts) * 60_000;
}

export type InstallSweepResult =
  | { state: "off" | "no_origin" }
  | { state: "ran"; tried: number; installed: number; failed: number };

export async function sweepInboxInstalls(now = new Date()): Promise<InstallSweepResult> {
  if (!inboxAnswersEnabled()) return { state: "off" };
  const origin = activityControlOrigin();
  if (!origin) return { state: "no_origin" };
  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;

  const { data: agents, error } = await db
    .from("hivra_agents")
    .select("*")
    .eq("type", "hermes")
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`could not list Hermes computers: ${error.message}`);
  const rows = (agents ?? []) as Record<string, unknown>[];

  let installs: InstallRow[] = [];
  if (rows.length) {
    const { data, error: installError } = await db
      .from("agent_inbox_installs")
      .select("agent_id, version, attempted_at, attempts")
      .in("agent_id", rows.map((row) => String(row.id)));
    if (installError) throw new Error(`could not read installs: ${installError.message}`);
    installs = (data ?? []) as InstallRow[];
  }
  const byAgent = new Map(installs.map((row) => [row.agent_id, row]));
  const due = rows.filter((row) => needsInstall(byAgent.get(String(row.id)), now.getTime())).slice(0, MAX_PER_RUN);

  let installed = 0;
  let failed = 0;
  for (const agent of due) {
    const agentId = String(agent.id);
    const attempts = (byAgent.get(agentId)?.attempts ?? 0) + 1;
    await db.from("agent_inbox_installs").upsert({ agent_id: agentId, attempted_at: now.toISOString(), attempts }, { onConflict: "agent_id" });
    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await runOnComputer(String(agent.user_id), agent, buildInboxInstallGuestScript(origin));
    } catch (cause) {
      outcome = { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
    if (outcome.ok) {
      installed += 1;
      await db.from("agent_inbox_installs").update({
        version: INBOX_PLUGIN_VERSION, installed_at: new Date().toISOString(), attempts: 0, last_error: null,
      }).eq("agent_id", agentId);
    } else {
      failed += 1;
      await db.from("agent_inbox_installs").update({ last_error: outcome.detail.slice(0, 300) }).eq("agent_id", agentId);
      log.warn("could not put the Needs you add-on on a Hermes computer", {
        source: SOURCE, failureType: "inbox_install_failed", agentId, attempts,
      });
    }
  }
  return { state: "ran", tried: due.length, installed, failed };
}

/** Runs a root script on the computer through the pinned guest route; ok when stdout carries `expect`. */
export async function runOnComputer(userId: string, agent: Record<string, unknown>, guestScript: string, expect = `${INSTALLED_MARKER} ${INBOX_PLUGIN_VERSION}`): Promise<{ ok: boolean; detail: string }> {
  const context = await resolveHivraAgentExecutionContext(userId, agent as unknown as Parameters<typeof resolveHivraAgentExecutionContext>[1]);
  const pinned = resolvePinnedGuestTarget({ ip: agent.ip as string | null, vmid: agent.vmid as number | null }, context);
  if (!pinned.ok) return { ok: false, detail: `computer identity not verified (${pinned.reason})` };
  const result = await runProxmoxHostScript(buildPinnedGuestHostScript(pinned.target, guestScript), context.env, GUEST_TIMEOUT_MS);
  const stdout = result.stdout ?? "";
  if (result.ok && stdout.includes(expect)) return { ok: true, detail: "" };
  const stderr = ((result as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-2).join(" ");
  return { ok: false, detail: stderr || (result as { error?: string }).error || "install did not finish" };
}
