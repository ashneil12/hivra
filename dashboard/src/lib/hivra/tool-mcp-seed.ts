import "server-only";

// Tool MCP seeding (Wave 6) — register/unregister an MCP server (with its own
// per-server credentials) on a running Hivra CLI box, over the same host->guest
// SSH path the Bankr/skills seeders use (orchestrator key, ubuntu@<ip> -> sudo).
//
// WHY WE WRITE THE BOX CONFIG DIRECTLY (not the box's /api/mcp): that endpoint
// takes only {name, command, args} — it can't carry the MCP server's `env`, which
// is exactly where a tool's API key must live (verified 2026-07-23 against
// hivra-chat/server.js: the box sources ~/.hivra/bankr.env by NAME only, so a
// generic tool env file wouldn't be read; but the box's MCP listers read the
// config files straight, and never echo the env block back). So we write the
// config the box already reads:
//   * claude-code -> ~/.claude.json   `mcpServers[name] = {type,command,args,env}`
//   * codex       -> ~/.codex/config.toml  [mcp_servers.name] (+ .env sub-table)
//
// Delivery is a fixed node program (no user data interpolated into code — the
// spec, including secrets, is piped to the program's STDIN as base64, so no
// credential ever lands in a shell argv, an environment variable, or on disk —
// i.e. nothing readable via the box process table (/proc/<pid>/cmdline|environ)
// or a temp file). The node runtime is guaranteed present (both agent CLIs are
// node apps). The whole guest script is itself base64-wrapped and streamed over
// SSH stdin, exactly like the skills seeder, so nothing touches an outer command
// line either.

import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";

/** Agent type -> the box config flavor. Only CLI boxes with an MCP config qualify. */
const MCP_KIND_BY_TYPE: Record<string, "claude" | "codex"> = {
  "claude-code": "claude",
  codex: "codex",
};

export function toolMcpKindForType(type?: string | null): "claude" | "codex" | null {
  if (!type) return null;
  return MCP_KIND_BY_TYPE[type] ?? null;
}

/**
 * One MCP server to register. Either a local stdio process (command/args/env) or
 * a hosted http endpoint (url/headers). Placeholders are already substituted by
 * the resolver — everything here is final, literal values.
 */
export interface ToolMcpServerSpec {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// The node program that mutates the box's MCP config. Fixed source — every input
// arrives via process.env.HIVRA_TOOL_SPEC (base64 JSON), so there is no path for
// a tool name / arg / secret to become executable code. Handles both add + remove
// and both config flavors. Prints HIVRA_TOOLS_OK on success.
export const MCP_NODE_PROGRAM = String.raw`
const fs = require("fs");
const path = require("path");
let spec;
try {
  const rawSpec = fs.readFileSync(0, "utf8").trim();
  spec = JSON.parse(Buffer.from(rawSpec, "base64").toString("utf8"));
} catch (e) { console.error("bad spec"); process.exit(1); }
const HOME = spec.home || process.env.HOME || "/home/bux";
const op = spec.op === "remove" ? "remove" : "add";
const servers = Array.isArray(spec.servers) ? spec.servers : [];
const names = servers.map((s) => String(s.name));

if (spec.kind === "claude") {
  const p = path.join(HOME, ".claude.json");
  // Distinguish "missing" (fine — start fresh) from "present but unparseable"
  // (REFUSE — overwriting would wipe oauthAccount / projects / other servers).
  let raw = null;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) {}
  let j = {};
  if (raw != null) {
    try { j = JSON.parse(raw); }
    catch (e) { console.error("existing ~/.claude.json is not valid JSON; refusing to overwrite"); process.exit(1); }
  }
  if (!j.mcpServers || typeof j.mcpServers !== "object") j.mcpServers = {};
  if (op === "remove") {
    for (const n of names) delete j.mcpServers[n];
  } else {
    for (const s of servers) {
      let entry;
      if (s.transport === "http") {
        entry = { type: "http", url: String(s.url) };
        if (s.headers && typeof s.headers === "object" && Object.keys(s.headers).length) entry.headers = s.headers;
      } else {
        entry = { type: "stdio", command: String(s.command), args: Array.isArray(s.args) ? s.args.map(String) : [] };
        if (s.env && typeof s.env === "object" && Object.keys(s.env).length) entry.env = s.env;
      }
      j.mcpServers[String(s.name)] = entry;
    }
  }
  // Atomic: write a sibling temp then rename, so a killed writer can't truncate
  // the config (which would then trip the refuse-to-overwrite guard above).
  const tmp = p + ".hivra." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  console.log("HIVRA_TOOLS_OK");
  process.exit(0);
}

if (spec.kind === "codex") {
  const p = path.join(HOME, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let t = "";
  try { t = fs.readFileSync(p, "utf8"); } catch (e) {}
  // Names are validated to [A-Za-z0-9_-] upstream (TOOL_MCP_NAME_RE), none of
  // which are regex-special here, so the name is safe to interpolate raw.
  // Strip any existing [mcp_servers.<name>] and [mcp_servers.<name>.<sub>] sections.
  // Consume each section body up to the NEXT line-start "[" (a real section
  // header) or EOF — NOT the next "[" anywhere, since an args array ("args = [..]")
  // contains a "[" mid-line. Same idiom the box's own remover uses.
  for (const n of names) {
    const re = new RegExp("^\\[mcp_servers\\." + n + "(?:\\.[A-Za-z0-9_]+)?\\][^]*?(?=^\\[|$(?![^]))", "gm");
    t = t.replace(re, "");
  }
  if (op === "add") {
    for (const s of servers) {
      let block = "[mcp_servers." + String(s.name) + "]\n";
      block += "command = " + JSON.stringify(String(s.command)) + "\n";
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      block += "args = [" + args.map((a) => JSON.stringify(a)).join(", ") + "]\n";
      if (s.env && typeof s.env === "object" && Object.keys(s.env).length) {
        block += "\n[mcp_servers." + String(s.name) + ".env]\n";
        for (const k of Object.keys(s.env)) block += k + " = " + JSON.stringify(String(s.env[k])) + "\n";
      }
      t = t.replace(/\s+$/, "") + "\n\n" + block;
    }
  }
  const tmp = p + ".hivra." + process.pid;
  fs.writeFileSync(tmp, t.replace(/^\n+/, ""), { mode: 0o600 });
  fs.renameSync(tmp, p);
  console.log("HIVRA_TOOLS_OK");
  process.exit(0);
}

console.error("bad kind");
process.exit(1);
`;

/**
 * Guest script (runs as root via sudo on the box). Resolves node, drops the fixed
 * program to a temp file (0644 — it holds NO secret, and bux must be able to read
 * it), and runs it AS bux with the base64 spec piped to STDIN (never argv/env).
 */
export function buildToolMcpGuestScript(specB64: string): string {
  return `set -e
BUX=/home/bux
[ -d "$BUX" ] || { echo "no box home" >&2; exit 1; }
NODE="$(sudo -u bux bash -lc 'command -v node' 2>/dev/null || true)"
[ -n "$NODE" ] || NODE=/usr/bin/node
[ -x "$NODE" ] || { echo "node not found on box" >&2; exit 1; }
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s' '${b64(MCP_NODE_PROGRAM)}' | base64 -d > "$TMP"
chmod 0644 "$TMP"
printf '%s' '${specB64}' | sudo -u bux env HOME="$BUX" "$NODE" "$TMP"
`;
}

/**
 * Host script (runs as root on the Proxmox host). Streams the base64-wrapped guest
 * script to the guest over stdin — same key + ssh opts as the provisioner/skills
 * seeder. No credential ever appears on any command line.
 */
export function buildToolMcpHostScript(ip: string, guestScript: string): string {
  const outer = b64(guestScript);
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
printf '%s' '${outer}' | ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "base64 -d | sudo bash"
`;
}

/** Build the base64 JSON spec the node program consumes. */
export function buildToolMcpSpec(
  kind: "claude" | "codex",
  op: "add" | "remove",
  servers: ToolMcpServerSpec[],
): string {
  const spec = { kind, op, home: "/home/bux", servers };
  return b64(JSON.stringify(spec));
}

/**
 * Add or remove a set of MCP servers on a running box. Best-effort + idempotent:
 * add overwrites an existing server of the same name; remove is a no-op if absent.
 * Returns {ok:false, error} on any transport/box failure so the caller can report
 * it (nothing is stamped installed on failure).
 */
export async function applyToolMcpOnBox(
  kind: "claude" | "codex",
  op: "add" | "remove",
  ip: string,
  servers: ToolMcpServerSpec[],
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<{ ok: boolean; error: string }> {
  if (!/^[0-9.]+$/.test(ip)) return { ok: false, error: "missing or invalid box ip" };
  if (servers.length === 0) return { ok: true, error: "" };
  const specB64 = buildToolMcpSpec(kind, op, servers);
  const script = buildToolMcpHostScript(ip, buildToolMcpGuestScript(specB64));
  let res: HostScriptResult;
  try {
    res = await runProxmoxHostScript(script, env, 30_000);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (res.ok && /HIVRA_TOOLS_OK/.test(res.stdout || "")) return { ok: true, error: "" };
  return { ok: false, error: (res.error || res.stderr || "mcp seed failed").slice(0, 200) };
}
