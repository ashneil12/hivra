import { createHash } from "node:crypto";

import { sshExec, type ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { getHetznerInstanceStatus, buildHermesEnvLines, buildHonchoConfig, buildProviderEnv, buildProviderEnvResetMap, type AgentSettings, type HonchoSettings } from "@/lib/services/hetzner-instance-service";
import { getProxmoxInfrastructure } from "@/lib/services/proxmox-instance-service";
import { PROVIDER_ID_MAP, resolveProviderBaseUrl } from "@/lib/services/provider-config";
import { supportsHermesAuthProvider } from "@/lib/provider-auth";
import type { A2ASettings } from "@/lib/instance-settings";
import { resolveHermesHomeDirFromConfig } from "@/lib/hermes-home";
import { normalizeModelValue } from "@/lib/models";
import { log } from "@/lib/logger";
import { isWebfreeBackend } from "@/lib/types/instance";
import { GATEWAY_SUBPROFILE_SUPERVISOR_SH_B64 } from "@/lib/services/gateway-supervisor";
import { buildManagedGatewayStatusCommand } from "@/lib/services/managed-gateway-command";
import { getHermesGuestSshTarget } from "@/lib/services/proxmox-infrastructure";

// SCRIPTURE_ANCHOR: profile-branch | John 15:5 | Verse: I am the vine. You are the branches.
const LOG_SOURCE = "profile-service";

/**
 * The only characters a per-instance hostname may contain. The fqdn flows into
 * a shell variable assignment and a curl flag inside the Caddy reload script,
 * so both the caller (updateAgentCaddyRouting) and the script builder hard
 * allowlist it — an fqdn that fails this check must never reach the host.
 */
const CADDY_FQDN_ALLOWLIST = /^[a-zA-Z0-9.-]+$/;

export interface Profile {
  id: string;
  instance_id: string;
  user_id: string;
  name: string;
  display_name: string | null;
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
  gateway_port: number | null;
  status: "stopped" | "running" | "creating" | "error";
  created_at: string;
  updated_at: string;
}

export class InstanceAccessError extends Error {
  constructor() {
    super("Instance not found or unauthorized");
    this.name = "InstanceAccessError";
  }
}

export function sanitizeDockerName(name: string): string {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid identifier format. Only alphanumeric characters, dashes, and underscores are allowed. Got: ${name}`);
  }
  return name;
}

export class ProfileService {
  private static pickAvailablePort(usedPorts: Set<number>): number {
    for (let port = 8650; port <= 8670; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error("No available ports for new profile. Maximum of 18 profiles reached.");
  }

  private static buildContainerName(instanceId: string): string {
    return `agent-${instanceId}`;
  }

  private static buildProfileDir(hermesHome: string, safeName: string): string {
    return `${hermesHome}/profiles/${safeName}`;
  }

  private static buildHermesBinaryResolutionLines(): string[] {
    return [
      `HERMES_BIN=/opt/venv/bin/hermes`,
      `if [ ! -x "$HERMES_BIN" ]; then`,
      `  HERMES_BIN=/opt/hermes/.venv/bin/hermes`,
      `fi`,
      `if [ ! -x "$HERMES_BIN" ]; then`,
      `  HERMES_BIN=$(command -v hermes)`,
      `fi`,
    ];
  }

  private static buildPythonBinaryResolutionLines(): string[] {
    return [
      `HERMES_AGENT_DIR="\${HERMES_WEBUI_AGENT_DIR:-\${HERMES_HOME:-}/hermes-agent}"`,
      `PYTHON_BIN=/opt/venv/bin/python`,
      `if [ ! -x "$PYTHON_BIN" ]; then`,
      `  PYTHON_BIN=/opt/hermes/.venv/bin/python`,
      `fi`,
      `if [ ! -x "$PYTHON_BIN" ] && [ -n "$HERMES_AGENT_DIR" ]; then`,
      `  PYTHON_BIN="$HERMES_AGENT_DIR/.venv/bin/python"`,
      `fi`,
      `if [ ! -x "$PYTHON_BIN" ]; then`,
      `  PYTHON_BIN=$(command -v python3 || command -v python)`,
      `fi`,
    ];
  }

  private static buildDockerPythonCommand(instanceId: string, pythonCode: string): string {
    return [
      `docker exec ${this.buildContainerName(instanceId)} sh -lc '`,
      `set -e`,
      ...this.buildPythonBinaryResolutionLines(),
      `"$PYTHON_BIN" -`,
      `' <<'PY'`,
      pythonCode.trim(),
      `PY`,
    ].join("\n");
  }

  private static buildGatewayStopContainerLines(profileDir: string, safeName: string, removePidFile = false): string[] {
    const lines = [
      ...this.buildHermesBinaryResolutionLines(),
      // Stop the supervisor BEFORE the gateway, or it would just respawn it.
      // SIGTERM lets the supervisor's trap tear down its gateway child cleanly.
      `if [ -f ${profileDir}/gateway-supervisor.pid ]; then`,
      `  SUP=$(tr -dc 0-9 < ${profileDir}/gateway-supervisor.pid 2>/dev/null)`,
      `  if [ -n "$SUP" ]; then kill -TERM "$SUP" 2>/dev/null || true; fi`,
      `fi`,
      `"$HERMES_BIN" -p ${safeName} gateway stop || true`,
      `if [ -f ${profileDir}/gateway.pid ]; then`,
      `  PID=$(python3 -c "import json, sys; d=sys.stdin.read().strip(); print(json.loads(d).get(\\"pid\\", \\"\\")) if d.startswith(\\"{\\") else print(d)" < ${profileDir}/gateway.pid 2>/dev/null)`,
      `  if [ -n "$PID" ]; then`,
      `    kill -9 $PID 2>/dev/null || true`,
      `  fi`,
    ];

    if (removePidFile) {
      lines.push(`  rm -f ${profileDir}/gateway.pid`);
    }

    lines.push(`fi`);
    if (removePidFile) {
      lines.push(`rm -f ${profileDir}/gateway-supervisor.pid`);
    }
    return lines;
  }

  private static buildGatewayStopScript(
    containerName: string,
    profileDir: string,
    safeName: string,
    options?: { removePidFile?: boolean; removeProfileDir?: boolean }
  ): string {
    const lines = this.buildGatewayStopContainerLines(profileDir, safeName, options?.removePidFile);

    if (options?.removeProfileDir) {
      lines.push(`rm -rf ${profileDir} || true`);
    }

    return `
docker exec ${containerName} sh -c '
  ${lines.join("\n  ")}
'
`;
  }

  private static buildGatewayStartScript(
    containerName: string,
    hermesHome: string,
    profileDir: string,
    safeName: string,
    gatewayPort: number
  ): string {
    const stopExistingGatewayLines = this.buildGatewayStopContainerLines(profileDir, safeName, true).join("\n  ");

    return `
docker exec -i ${containerName} sh << 'CONTAINEREOF'
  ${stopExistingGatewayLines}

  MAIN_KEY=$(grep "^API_SERVER_KEY" ${hermesHome}/.env 2>/dev/null | cut -d= -f2 | head -n 1 | tr -d '"\\r' || true)
  if [ -z "$MAIN_KEY" ]; then
    echo "API_SERVER_KEY missing from ${hermesHome}/.env; profile gateway cannot authenticate dashboard requests." >&2
    exit 1
  fi
  
  # Strip only API_SERVER_ overrides that need fresh values for this gateway port.
  # Messaging tokens (Telegram, Discord, Slack) are intentionally PRESERVED here.
  # They are only stripped at clone time in createProfile to prevent bot collisions.
  sed -i -E '/^(API_SERVER_(PORT|HOST|KEY|ENABLED)|PROFILE_NAME)=/d' ${profileDir}/.env 2>/dev/null || true
  rm -f ${profileDir}/gateway.pid 2>/dev/null || true
  
  # Inject explicit configuration into .env so it survives Python's load_dotenv(override=True)
  {
    echo "API_SERVER_PORT=${gatewayPort}"
    echo "API_SERVER_HOST=0.0.0.0"
    echo "API_SERVER_KEY=$MAIN_KEY"
    echo "API_SERVER_ENABLED=true"
    echo "PROFILE_NAME=${safeName}"
  } >> ${profileDir}/.env
  
  ${this.buildHermesBinaryResolutionLines().join("\n  ")}

  if [ -f ${profileDir}/.env ]; then
    set -a
    . ${profileDir}/.env
    set +a
  fi

  # Launch the gateway under a self-restarting supervisor so a crash doesn't
  # silently drop this profile's cron + chat delivery until the next restart.
  echo ${GATEWAY_SUBPROFILE_SUPERVISOR_SH_B64} | base64 -d > ${profileDir}/gateway-supervisor.sh
  env HERMES_HOME=${profileDir} HERMES_BIN="$HERMES_BIN" nohup sh ${profileDir}/gateway-supervisor.sh </dev/null >> ${profileDir}/gateway.log 2>&1 &
  echo $! > ${profileDir}/gateway-supervisor.pid
  
  # Wait for the gateway to actually bind to its port (up to 15 seconds).
  # This replaces the old blind "sleep 2" which was too short.
  READY=0
  STATUS_READY=0
  STATUS_FILE=${profileDir}/gateway-status.log
  for i in $(seq 1 30); do
    if wget -qO /dev/null --timeout=1 http://127.0.0.1:${gatewayPort}/v1/models 2>/dev/null; then
      if [ -e "${hermesHome}/hermes-agent/.venv" ] || [ -L "${hermesHome}/hermes-agent/.venv" ]; then
        env HERMES_HOME=${profileDir} HERMES_WEBUI_AGENT_DIR=${hermesHome}/hermes-agent ${buildManagedGatewayStatusCommand()} > "$STATUS_FILE" 2>&1 || true
      else
        ( [ -x "$HERMES_BIN" ] && env -u UV_PROJECT_ENVIRONMENT HERMES_HOME=${profileDir} "$HERMES_BIN" gateway status ) > "$STATUS_FILE" 2>&1 || true
      fi
      if grep -q "Gateway is running" "$STATUS_FILE"; then
        READY=1
        STATUS_READY=1
        break
      fi
    fi
    sleep 0.5
  done

  if [ "$READY" != "1" ] || [ "$STATUS_READY" != "1" ]; then
    echo "Profile gateway failed to bind to port ${gatewayPort}." >&2
    if [ -f "$STATUS_FILE" ]; then
      cat "$STATUS_FILE" >&2 || true
    fi
    echo "Profile gateway env/config diagnostics:" >&2
    if [ -f ${profileDir}/.env ]; then
      awk -F= '/^(HERMES_INFERENCE_PROVIDER|OPENAI_BASE_URL|PROVIDER|LLM_PROVIDER|MODEL|HERMES_MODEL)=/ { print $1"=<set>" }' ${profileDir}/.env >&2 || true
    else
      echo "profile .env missing at ${profileDir}/.env" >&2
    fi
    if [ -f ${profileDir}/config.yaml ]; then
      awk '
        /^model:/ { in_model=1; print; next }
        in_model && /^  (default|provider|base_url):/ { print; next }
        in_model && /^[^[:space:]]/ { in_model=0 }
      ' ${profileDir}/config.yaml >&2 || true
    else
      echo "profile config.yaml missing at ${profileDir}/config.yaml" >&2
    fi
    if [ -f ${profileDir}/gateway.log ]; then
      tail -n 80 ${profileDir}/gateway.log >&2 || true
    fi
    exit 1
  fi
CONTAINEREOF
`;
  }

  /**
   * Retrieves the IPv4 address of the host running the actual agent container.
   *
   * Returns the *guest* IP for both providers — sshExec auto-bastions Proxmox
   * private IPs through PROXMOX_SSH_HOST (see hetzner/ssh.ts:isProxmoxPrivateGuestIp),
   * so callers can use the same docker-exec patterns regardless of where the
   * VM lives.
   */
  static async getHostIpForInstance(instanceId: string, userId: string): Promise<string> {
    return (await ProfileService.getGuestSshForInstance(instanceId, userId)).ip;
  }

  /**
   * The guest IP plus the `sshExec` target for it (`getHermesGuestSshTarget`):
   * the instance's host, stored VMID and id. Pass both to every guest command;
   * the IP alone names a VM on every host that shares the private prefix.
   */
  static async getGuestSshForInstance(
    instanceId: string,
    userId: string
  ): Promise<{ ip: string; guestTarget: ProxmoxSshHostConfig | null }> {
    sanitizeDockerName(instanceId);
    const { data: instance, error } = await supabaseAdmin!
      .from("hermes_instances")
      .select("id, host_id, config, ipv4_address, proxmox_vmid, proxmox_node, gateway_url")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .maybeSingle<{
        id: string;
        host_id: string | null;
        config: Record<string, unknown> | null;
        ipv4_address: string | null;
        proxmox_vmid?: number | null;
        proxmox_node?: string | null;
        gateway_url?: string | null;
      }>();

    if (error) {
      throw new Error("Instance lookup failed");
    }
    if (!instance) {
      throw new InstanceAccessError();
    }
    const guestTarget = getHermesGuestSshTarget(instance);
    const ip = await ProfileService.resolveInstanceHostIp(instance);
    return { ip, guestTarget };
  }

  private static async resolveInstanceHostIp(instance: {
    host_id: string | null;
    config: Record<string, unknown> | null;
    ipv4_address: string | null;
  }): Promise<string> {

    // Proxmox-backed instances expose the guest's private IPv4 in
    // config.infrastructure. sshExec auto-routes private subnet IPs through
    // the Proxmox host as a bastion, so callers can SSH "directly" to the
    // guest the same way they do for Hetzner.
    const proxmoxInfrastructure = getProxmoxInfrastructure(instance.config ?? undefined);
    if (proxmoxInfrastructure) {
      return proxmoxInfrastructure.privateIpv4;
    }

    if (!instance.host_id) {
      // Legacy single-node instances may have no host record but a stored
      // ipv4_address from provisioning.
      if (instance.ipv4_address) {
        return instance.ipv4_address;
      }
      throw new Error("Instance host address is unavailable");
    }

    const { data: host, error: hostErr } = await supabaseAdmin!
      .from("hermes_hosts")
      .select("hetzner_server_id, ipv4_address")
      .eq("id", instance.host_id)
      .single<{ hetzner_server_id: number | null; ipv4_address: string | null }>();

    if (hostErr || !host) {
      throw new Error(`Host record missing for instance`);
    }

    if (host.ipv4_address) {
      return host.ipv4_address;
    }

    if (!host.hetzner_server_id) {
      throw new Error(`Host has no resolvable IPv4 address`);
    }

    const hs = await getHetznerInstanceStatus(host.hetzner_server_id);
    if (!hs.ipv4) {
      throw new Error(`Host IP address not yet available`);
    }
    return hs.ipv4;
  }

  static async getHermesHomeForInstance(instanceId: string, userId: string): Promise<string> {
    sanitizeDockerName(instanceId);
    const { data: instance, error } = await supabaseAdmin!
      .from("hermes_instances")
      .select("config")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .single();

    if (error || !instance) {
      throw new Error("Instance not found or unauthorized");
    }

    return resolveHermesHomeDirFromConfig(instance.config as Record<string, unknown> | undefined);
  }

  static async getProfileGatewayPort(instanceId: string, userId: string, name: string): Promise<number | null> {
    const safeName = sanitizeDockerName(name);
    const { data: profile, error } = await supabaseAdmin!
      .from("profiles")
      .select("gateway_port")
      .eq("instance_id", instanceId)
      .eq("user_id", userId)
      .eq("name", safeName)
      .maybeSingle();

    if (error) {
      throw new Error("Failed to resolve profile gateway port");
    }

    return typeof profile?.gateway_port === "number" ? profile.gateway_port : null;
  }

  static async getProfileProvider(instanceId: string, userId: string, name: string): Promise<string | null> {
    const safeName = sanitizeDockerName(name);
    const { data: profile, error } = await supabaseAdmin!
      .from("profiles")
      .select("provider")
      .eq("instance_id", instanceId)
      .eq("user_id", userId)
      .eq("name", safeName)
      .maybeSingle();

    if (error) {
      throw new Error("Failed to resolve profile provider");
    }

    return typeof profile?.provider === "string" ? profile.provider : null;
  }

  /**
   * Generates a shell command chunk that uses python to patch the .env file cleanly.
   * It base64 encodes the payload to avoid bash string escaping nightmares.
   */
  static buildEnvPatchCommand(envPath: string, updates: Record<string, string>): string {
    const updatesB64 = Buffer.from(JSON.stringify(updates)).toString("base64");
    
    const pythonScript = `
import json, re, sys, base64
try:
    with open('${envPath}', 'r') as f: content = f.read()
except FileNotFoundError:
    content = ''

updates = json.loads(base64.b64decode('${updatesB64}').decode('utf-8'))
for k, v in updates.items():
    if v == '' or v is None:
        content = re.sub(r'^' + k + r'=.*\\n?', '', content, flags=re.MULTILINE)
    else:
        if re.search(r'^' + k + r'=', content, flags=re.MULTILINE):
            content = re.sub(r'^' + k + r'=.*', k + '=' + str(v), content, flags=re.MULTILINE)
        else:
            content += '\\n' + k + '=' + str(v) + '\\n'

content = re.sub(r'\\n{2,}', '\\n', content)

with open('${envPath}', 'w') as f:
    f.write(content.strip() + '\\n')
`;

    const b64Python = Buffer.from(pythonScript).toString("base64");
    return [
      ...this.buildPythonBinaryResolutionLines(),
      `echo "${b64Python}" | base64 -d | "$PYTHON_BIN"`,
      ``,
    ].join("\n");
  }

  /**
   * Older WebUI VM compose files accidentally pinned the webui service to
   * uid/gid 1024. That pin bypasses the image entrypoint's root-time setup
   * when profile/provider saves force-recreate the container, causing WebUI
   * to restart-loop on "sudo: a terminal is required" / "/app" setup errors.
   *
   * Remove only the webui service pin. The sidecar service may still run as
   * 1024:1024 intentionally and must be left alone.
   */
  static buildRemoveWebUIUserPinCommand(composePath: string): string {
    const pythonScript = `
from pathlib import Path

compose_path = Path(${JSON.stringify(composePath)})
try:
    lines = compose_path.read_text().splitlines()
except FileNotFoundError:
    print("removed_webui_user_pin=false compose_missing=true")
    raise SystemExit(0)

out = []
in_services = False
current_service = None
removed = False

for line in lines:
    stripped = line.strip()

    if line and not line.startswith(" ") and stripped.endswith(":"):
        in_services = stripped == "services:"
        current_service = None
    elif in_services and line.startswith("  ") and not line.startswith("    ") and stripped.endswith(":"):
        current_service = stripped[:-1].strip("'\\\"")

    if (
        in_services
        and current_service == "webui"
        and stripped in ('user: "1024:1024"', "user: '1024:1024'", "user: 1024:1024")
    ):
        removed = True
        continue

    out.append(line)

if removed:
    compose_path.write_text("\\n".join(out) + "\\n")

print(f"removed_webui_user_pin={str(removed).lower()}")
`;

    const b64Python = Buffer.from(pythonScript).toString("base64");
    return [
      ...this.buildPythonBinaryResolutionLines(),
      `echo "removed_webui_user_pin_check=starting"`,
      `echo "${b64Python}" | base64 -d | "$PYTHON_BIN"`,
      ``,
    ].join("\n");
  }

  /**
   * List all profiles on the container via SSH and sync with the database.
   */
  static async syncProfiles(instanceId: string, userId: string) {
    const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
    const hermesHome = await this.getHermesHomeForInstance(instanceId, userId);
    const containerName = this.buildContainerName(instanceId);

    // Read the directories inside the canonical Hermes profile home to discover them quickly
    // Gateway PID file indicates if it's running
    const script = `
      docker exec ${containerName} sh -c '
        if [ ! -d ${hermesHome}/profiles ]; then
           echo "[]";
           exit 0;
        fi
        cd ${hermesHome}/profiles
        echo "["
        first=1
        for d in */; do
           if [ "$d" = "*/" ]; then break; fi
           name="\${d%/}"
           running="false"
           if [ -f "$name/gateway.pid" ]; then
              pid=$(python3 -c "import json, sys; d=sys.stdin.read().strip(); print(json.loads(d).get(\\"pid\\", \\"\\")) if d.startswith(\\"{\\") else print(d)" < "$name/gateway.pid" 2>/dev/null)
              if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then running="true"; fi
           fi
           if [ $first -eq 0 ]; then echo ","; fi
           first=0
           echo "{ \\"name\\": \\"$name\\", \\"running\\": $running }"
        done
        echo "]"
      '
    `;

    const res = await sshExec(ip, script, { timeoutMs: 15000, proxmoxHostConfig: guestTarget });
    if (!res.ok) {
      const failureDetails = redactSensitiveCommandOutput(
        [res.error, res.stderr, res.stdout]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
          .join(" | ") || "unknown ssh error",
        600
      );
      throw new Error(`Failed to sync profiles: ${failureDetails}`);
    }

    // Find the JSON block (some bash output or warnings might be prepended)
    const jsonStart = res.stdout.indexOf("[");
    const jsonEnd = res.stdout.lastIndexOf("]") + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      throw new Error("Failed to parse profile sync output: missing JSON array");
    }

    const rawJson = res.stdout.substring(jsonStart, jsonEnd);
    let profiles: Array<{ name: string; running: boolean }>;

    try {
      profiles = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(
        `Failed to parse profile sync output: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const { data: currentDbProfiles, error: currentDbProfilesError } = await supabaseAdmin!
      .from("profiles")
      .select("id, name, status, gateway_port")
      .eq("instance_id", instanceId);

    if (currentDbProfilesError) {
      throw new Error("Failed to load existing profiles for sync");
    }

    const dbMap = new Map((currentDbProfiles || []).map((p) => [p.name, p]));
    const usedPorts = new Set(
      (currentDbProfiles || [])
        .map((profile) => profile.gateway_port)
        .filter((port): port is number => typeof port === "number" && Number.isFinite(port))
    );

    for (const p of profiles) {
      const expectedStatus = p.running ? "running" : "stopped";
      if (dbMap.has(p.name)) {
        const dbp = dbMap.get(p.name)!;
        if (dbp.status !== expectedStatus && dbp.status !== "creating") {
          const { error: updateError } = await supabaseAdmin!
            .from("profiles")
            .update({ status: expectedStatus })
            .eq("id", dbp.id);

          if (updateError) {
            throw new Error(`Failed to update synced profile ${p.name}`);
          }
        }
        dbMap.delete(p.name);
      } else {
        // Agent created this profile directly via CLI tool, so we track it now without
        // re-querying the same profile table for every discovered profile.
        const newPort = this.pickAvailablePort(usedPorts);
        usedPorts.add(newPort);
        const { error: insertError } = await supabaseAdmin!.from("profiles").insert({
          instance_id: instanceId,
          user_id: userId,
          name: p.name,
          gateway_port: newPort,
          status: expectedStatus,
        });

        if (insertError) {
          throw new Error(`Failed to track synced profile ${p.name}`);
        }
      }
    }

    // Any remaining in dbMap are deleted from disk
    for (const dbp of dbMap.values()) {
      if (dbp.status === "creating") continue; // Prevent race conditions with createProfile
      const { error: deleteError } = await supabaseAdmin!.from("profiles").delete().eq("id", dbp.id);
      if (deleteError) {
        throw new Error(`Failed to delete stale synced profile ${dbp.name}`);
      }
    }
  }

  static async createProfile(instanceId: string, userId: string, params: { 
    name: string; 
    cloneFrom?: string;
    provider?: string;
    apiKey?: string;
    model?: string;
    avatarUrl?: string;
    linkUserMd?: boolean;
    agentSettings?: AgentSettings;
    honchoSettings?: HonchoSettings;
  }) {
    const normalizedModel = normalizeModelValue(params.model || "", params.provider);
    // 1. Insert into DB (creating status)
    const { data: profile, error } = await supabaseAdmin!
       .from("profiles")
       .insert({
          instance_id: instanceId,
          user_id: userId,
          name: params.name,
          provider: params.provider,
          model: normalizedModel,
          avatar_url: params.avatarUrl,
          system_prompt: params.agentSettings?.systemPrompt,
          gateway_port: await this.allocatePort(instanceId),
          status: "creating"
       }).select().single();
       
    if (error || !profile) throw new Error("Could not create profile record");

    try {
      const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
      const hermesHome = await this.getHermesHomeForInstance(instanceId, userId);
      const containerName = this.buildContainerName(instanceId);
      const safeName = sanitizeDockerName(params.name);

      let cloneFlag = "";
      if (params.cloneFrom && params.cloneFrom !== "default" && params.cloneFrom !== "none") {
          cloneFlag = `--clone --clone-from ${sanitizeDockerName(params.cloneFrom)}`;
      } else if (params.cloneFrom === "default") {
          cloneFlag = `--clone`;
      }

      const createScript = this.buildDockerPythonCommand(
        instanceId,
        `
import pathlib
import subprocess
import sys

safe_name = ${JSON.stringify(safeName)}
clone_flag = ${JSON.stringify(cloneFlag)}

venv_candidates = [
    pathlib.Path("/opt/venv/bin/hermes"),
    pathlib.Path("/opt/hermes/.venv/bin/hermes"),
]

hermes_bin = next((str(path) for path in venv_candidates if path.exists()), None)
if hermes_bin is None:
    hermes_bin = "hermes"

cmd = [hermes_bin, "profile", "create", safe_name]
if clone_flag:
    cmd.extend(clone_flag.split())
cmd.append("--no-alias")

completed = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
if completed.returncode != 0:
    raise SystemExit(completed.returncode)
        `
      );
      
      const res = await sshExec(ip, createScript, { timeoutMs: 30000, proxmoxHostConfig: guestTarget });
      if (!res.ok) throw new Error(res.stderr || res.stdout);

      // When cloning, strip messaging tokens so the new profile doesn't
      // collide with the source profile's Discord/Telegram/Slack bots.
      // This runs ONLY at clone time — startProfileGateway must NOT repeat it.
      const isCloning = !!(params.cloneFrom && params.cloneFrom !== 'none');
      if (isCloning) {
        const stripTokensScript = `docker exec ${containerName} sed -i -E '/^(TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|SLACK_APP_TOKEN|SLACK_BOT_TOKEN)=/d' ${hermesHome}/profiles/${safeName}/.env 2>/dev/null || true`;
        await sshExec(ip, stripTokensScript, { timeoutMs: 10000, proxmoxHostConfig: guestTarget });
      }

      // --- CONFIG INJECTION ---
      const b64 = (str: string) => Buffer.from(str).toString("base64");
      let injectScript = `\nprofile_dir="${hermesHome}/profiles/${safeName}"\n`;

      const hasProviderOverride = !!(params.provider || params.model);
      const hasApiKeyOverride = !!params.apiKey;
      const hasEnvOverrides = !!(hasApiKeyOverride || hasProviderOverride || params.agentSettings?.tavilyApiKey || params.agentSettings?.exaApiKey || params.agentSettings?.browserbaseApiKey || params.agentSettings?.browserUseApiKey);

      if (!isCloning) {
        // Not cloning — write a complete .env from scratch
        const envLines = buildHermesEnvLines({
          containerName,
          apiServerKey: "",
          provider: params.provider || "openrouter",
          apiKey: params.apiKey,
          model: normalizedModel,
          agentSettings: params.agentSettings,
          honchoSettings: params.honchoSettings
        }).join("\\n");
        injectScript += `echo "${b64(envLines)}" | base64 -d > "$profile_dir/.env"\n`;
      } else if (hasEnvOverrides) {
        // Cloning with override — surgically patch the cloned .env
        // so we preserve the cloned API key unless the user explicitly provided one.
        const patchDict: Record<string, string> = buildProviderEnvResetMap();
        if (params.provider) {
          const hermesProvider = PROVIDER_ID_MAP[params.provider] ?? params.provider;
          patchDict['PROVIDER'] = hermesProvider;
          patchDict['LLM_PROVIDER'] = hermesProvider;
          patchDict['HERMES_INFERENCE_PROVIDER'] = hermesProvider;
        }
        if (normalizedModel) {
          patchDict['MODEL'] = normalizedModel;
          patchDict['HERMES_MODEL'] = normalizedModel;
          patchDict['HERMES_SUBAGENT_MODEL'] = normalizedModel;
        }
        const providerOverride = params.provider;
        const shouldPatchProviderEnv =
          !!providerOverride && (hasApiKeyOverride || supportsHermesAuthProvider(providerOverride));
        if (providerOverride && shouldPatchProviderEnv) {
          const providerEnvLines = buildProviderEnv(providerOverride, params.apiKey || "");
          for (const line of providerEnvLines) {
            const eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
              patchDict[line.substring(0, eqIdx)] = line.substring(eqIdx + 1);
            }
          }
        }
        if (hasApiKeyOverride && params.apiKey) {
          patchDict['API_KEY'] = params.apiKey;
          patchDict['LLM_API_KEY'] = params.apiKey;
        }
        
        // Instead of messy quoting, use the helper to build a safe base64 pipeline
        injectScript += ProfileService.buildEnvPatchCommand(`${hermesHome}/profiles/${safeName}/.env`, patchDict);
      }


      const honchoFileContent = buildHonchoConfig(params.honchoSettings) || "{}";

      // Write a profile-level config.yaml so the agent uses the correct
      // model/provider for this profile. Without this, `hermes profile create --clone`
      // copies the MAIN agent's config.yaml which may reference a completely
      // different provider/model (e.g. crof/glm-5.1-precision) that doesn't
      // match the .env we just wrote (e.g. alibaba/qwen3.5-plus).
      // config.yaml takes precedence at runtime, so the mismatch causes 400 errors.
      {
        const dashProvider = params.provider || 'openrouter';
        const hermesProvider = params.provider
          ? (PROVIDER_ID_MAP[params.provider] ?? params.provider)
          : 'openrouter';
        const modelName = normalizedModel || '';
        const configLines: string[] = ['model:'];
        if (modelName) configLines.push(`  default: "${modelName}"`);
        configLines.push(`  provider: "${hermesProvider}"`);

        // Resolve base_url for providers that need one (e.g. crof, openai, gemini).
        // Without this, "custom" provider doesn't know which API endpoint to hit.
        const resolvedBaseUrl = resolveProviderBaseUrl(dashProvider, params.agentSettings?.customLlmBaseUrl);
        if (resolvedBaseUrl) {
          configLines.push(`  base_url: "${resolvedBaseUrl}"`);
        }

        const configContent = configLines.join('\\n');
        injectScript += `echo "${b64(configContent)}" | base64 -d > "$profile_dir/config.yaml"\n`;
      }

      // Append delegation key to config.yaml if an overriding subagent key exists
      if (params.agentSettings?.subagentApiKey) {
         injectScript += `\ncat << 'EOF' >> "$profile_dir/config.yaml"\ndelegation:
  api_key: ${params.agentSettings.subagentApiKey}
EOF\n`;
      }

      if (params.agentSettings?.systemPrompt !== undefined) {
        if (params.agentSettings.systemPrompt === "") {
          injectScript += `rm -f "$profile_dir/SOUL.md" || true\n`;
        } else {
          injectScript += `echo "${b64(params.agentSettings.systemPrompt)}" | base64 -d > "$profile_dir/SOUL.md"\n`;
        }
      }
      injectScript += `echo "${b64(honchoFileContent)}" | base64 -d > "$profile_dir/honcho.json"\n`;

      if (params.linkUserMd) {
        injectScript += `mkdir -p "$profile_dir/memories"\n`;
        injectScript += `rm -f "$profile_dir/memories/USER.md"\n`;
        injectScript += `ln -s "${hermesHome}/memories/USER.md" "$profile_dir/memories/USER.md"\n`;
        injectScript += `touch "$profile_dir/memories/MEMORY.md"\n`;
      } else {
        injectScript += `mkdir -p "$profile_dir/memories"\n`;
        // Use touch to ensure the files physically exist immediately, preventing UI errors
        // when attempting to edit them before the daemon auto-generates them.
        injectScript += `touch "$profile_dir/memories/USER.md" "$profile_dir/memories/MEMORY.md"\n`;
      }

      const b64Inject = b64(injectScript);
      const injectRes = await sshExec(ip, `echo "${b64Inject}" | base64 -d | docker exec -i ${containerName} sh`, { timeoutMs: 30000, proxmoxHostConfig: guestTarget });
      if (!injectRes.ok) {
        log.warn("profile config injection warning", {
          source: LOG_SOURCE,
          failureType: "profile_config_injection_warn",
          instanceId,
          userId,
          profileName: params.name,
          redactedMessage: redactSensitiveCommandOutput(injectRes.stderr || "", 600),
        });
      }

      // Auto-start the gateway so the profile is immediately usable.
      await this.startProfileGateway(instanceId, userId, safeName);
      
      return { ...profile, status: "running" };
    } catch (e) {
      const { error: rollbackError } = await supabaseAdmin!.from("profiles").delete().eq("id", profile.id);
      if (rollbackError) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Profile creation failed: ${reason}. Rollback failed to delete profile record.`);
      }
      throw e;
    }
  }

  static async deleteProfile(instanceId: string, userId: string, name: string) {
    const safeName = sanitizeDockerName(name);
    const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
    const hermesHome = await this.getHermesHomeForInstance(instanceId, userId);
    const containerName = this.buildContainerName(instanceId);
    const profileDir = this.buildProfileDir(hermesHome, safeName);
    
    // 1 & 2. Explicitly stop the process and erase data in one grouped SSH connection
    const cleanupScript = `
${ProfileService.buildGatewayStopScript(containerName, profileDir, safeName, {
  removeProfileDir: true,
})} || true

docker exec ${containerName}-browser sh -c "rm -rf /workspace/profiles/${safeName}" || true
`;
    await sshExec(ip, cleanupScript, { proxmoxHostConfig: guestTarget }).catch(e => {
       log.warn("failed to erase profile from container disk (might be offline)", {
         source: LOG_SOURCE,
         failureType: "profile_disk_erase_failed",
         instanceId,
         userId,
         profileName: name,
       }, e);
    });
    
    // 3. Delete from database
    const { error: deleteError } = await supabaseAdmin!
       .from("profiles")
       .delete()
       .eq("instance_id", instanceId)
       .eq("name", safeName);

    if (deleteError) {
      throw new Error("Failed to delete profile record");
    }

    // 4. Regenerate Caddy proxy routing to remove the route mapping for the deleted profile
    await this.updateAgentCaddyRouting(instanceId, userId).catch((e) => {
      log.warn("failed to reload caddy after deleting profile", {
        source: LOG_SOURCE,
        failureType: "caddy_reload_after_delete_failed",
        instanceId,
        userId,
        profileName: name,
      }, e);
    });
  }

  static async startProfileGateway(instanceId: string, userId: string, name: string) {
    const safeName = sanitizeDockerName(name);
    // Scope by user_id so a profile lookup never returns a row from another
    // tenant's instance even if instanceId is ever guessable. Ownership is
    // also re-checked by getHostIpForInstance below; this is defense-in-depth.
    const { data: profile } = await supabaseAdmin!
       .from("profiles")
       .select("id, gateway_port")
       .eq("instance_id", instanceId)
       .eq("user_id", userId)
       .eq("name", safeName)
       .single();

    if (!profile?.gateway_port) {
      throw new Error("Profile has no allocated gateway port");
    }

    // Note: Gateway key shouldn't be overridden unless needed.
    // The dashboard proxy authenticates with the instance's main key.

    const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
    const hermesHome = await this.getHermesHomeForInstance(instanceId, userId);
    const containerName = this.buildContainerName(instanceId);
    const profileDir = this.buildProfileDir(hermesHome, safeName);

    // Note: Gateway key shouldn't be overridden unless needed, however to ensure the dashboard
    // proxy can authenticate with the same key, we just pass the instance's key.
    // However, we encrypt the API key in the DB. We should use the instance's existing API_SERVER_KEY 
    // which is already in the container's `.env`, so we just let the gateway load it from the `.env` 
    // Wait, if it's cloned, does it clone `.env`? Yes `--clone` copies it. 
    // If not cloned, we pass the main instance API key through from the canonical Hermes home.
     // Let's pass the environment overrides explicitly
    const script = this.buildGatewayStartScript(
      containerName,
      hermesHome,
      profileDir,
      safeName,
      profile.gateway_port
    );
    // We update status immediately on successful launch command
    const res = await sshExec(ip, script, { timeoutMs: 30000, proxmoxHostConfig: guestTarget });
    if (!res.ok) throw new Error(res.stderr || res.stdout);

    // Update Caddy FIRST so the route exists when the first request arrives
    await this.updateAgentCaddyRouting(instanceId, userId);
    const { error: startStatusError } = await supabaseAdmin!
      .from("profiles")
      .update({ status: "running" })
      .eq("id", profile.id);
    if (startStatusError) {
      throw new Error("Failed to mark profile gateway as running");
    }
  }

  static async stopProfileGateway(instanceId: string, userId: string, name: string) {
    const safeName = sanitizeDockerName(name);
    // Mirror startProfileGateway: resolve the profile row (scoped by user_id,
    // defense-in-depth) BEFORE touching the box. Without this check a stop for
    // a profile that owns no gateway port — which is EVERY webfree profile row,
    // since persistWebUIProfileToSupabase never writes gateway_port — still
    // SSH'd in, ran the stop script against a directory that doesn't exist, and
    // then rebuilt the instance's Caddyfile. That last step is the one that
    // took boxes down; see the fail-closed guard in updateAgentCaddyRouting.
    const { data: profile } = await supabaseAdmin!
       .from("profiles")
       .select("id, gateway_port")
       .eq("instance_id", instanceId)
       .eq("user_id", userId)
       .eq("name", safeName)
       .single();

    if (!profile?.gateway_port) {
      throw new Error("Profile has no allocated gateway port");
    }

    const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
    const hermesHome = await this.getHermesHomeForInstance(instanceId, userId);
    const containerName = this.buildContainerName(instanceId);
    const profileDir = this.buildProfileDir(hermesHome, safeName);
    
    // Stop using hermes cli to ensure graceful shutdown and lock release, fallback to kill if manually spawned
    const script = this.buildGatewayStopScript(containerName, profileDir, safeName, {
      removePidFile: true,
    });
    await sshExec(ip, script, { proxmoxHostConfig: guestTarget });
    
    // If it fails, maybe it's already stopped. Update db anyway.
    const { error: stopStatusError } = await supabaseAdmin!
       .from("profiles")
       .update({ status: "stopped" })
       .eq("instance_id", instanceId)
       .eq("name", safeName);

    if (stopStatusError) {
      throw new Error("Failed to mark profile gateway as stopped");
    }
       
    await this.updateAgentCaddyRouting(instanceId, userId);
  }

  /**
   * Helper to allocate the next available port for the container.
   * Container reserves 8642 for default, so profiles use 8643-8660.
   */
  private static async allocatePort(instanceId: string): Promise<number> {
     const { data: profiles } = await supabaseAdmin!
        .from("profiles")
        .select("gateway_port")
        .eq("instance_id", instanceId)
        .order("gateway_port", { ascending: true });

     const usedPorts = new Set(
       (profiles || [])
         .map((profile) => profile.gateway_port)
         .filter((port): port is number => typeof port === "number" && Number.isFinite(port))
     );

     return this.pickAvailablePort(usedPorts);
  }

  /**
   * Rebuilds and reloads the Caddy configuration on the host to reflect current profile routes.
   */
  static async updateAgentCaddyRouting(instanceId: string, userId: string) {
    // Ownership is validated here (throws for a foreign instance), so it must
    // stay ahead of every early return below.
    const { ip, guestTarget } = await this.getGuestSshForInstance(instanceId, userId);
    const containerName = this.buildContainerName(instanceId);

    const { data: instance } = await supabaseAdmin!
       .from("hermes_instances")
       .select("subdomain, gateway_url, config, backend")
       .eq("id", instanceId)
       .single();

    if (!instance) throw new Error("Instance not found");

    // FAIL CLOSED. The profile lane must NEVER regenerate a webfree box's
    // Caddyfile. buildAgentCaddyfile below emits the LEGACY upstreams
    // (`agent-<id>:8642` + `agent-<id>-sidecar:9090`); a webfree box runs
    // `agent-<id>-gateway`, `agent-<id>-official-dashboard` and
    // `agent-<id>-dashboard-sidecar` instead (webui-instance-builder), so every
    // route 502s and the public /webchat + /dash shells vanish. The webfree
    // Caddyfile is owned by buildWebUICaddyfile and nothing else may write it.
    //
    // A null / unrecognised `backend` is treated as webfree too. Every
    // InstanceBackend value ("gateway" | "webui") is already webfree, the column
    // is not reliably populated on older rows, and the two mistakes are not
    // symmetric: guessing "legacy" on a webfree box is a full outage (permanent
    // when there's no fqdn to health-probe), while guessing "webfree" on a
    // legacy box merely skips a route rebuild. Webfree boxes have no
    // per-profile gateway ports to route anyway — WebUI handles profiles
    // internally (see webui-instance-builder).
    const backend = typeof instance.backend === "string" ? instance.backend : null;
    const runsLegacyCaddyStack = backend !== null && !isWebfreeBackend(backend);
    if (!runsLegacyCaddyStack) {
      log.info("skipped profile Caddy routing rebuild on webfree instance", {
        source: LOG_SOURCE,
        instanceId,
        userId,
        backend: backend ?? "<null>",
      });
      return;
    }

    const { data: profiles } = await supabaseAdmin!
       .from("profiles")
       .select("name, gateway_port")
       .eq("instance_id", instanceId)
       .not("gateway_port", "is", null);

    const profileRoutes = (profiles || []).map(p => ({ name: p.name, port: p.gateway_port! }));

    // We can extract a2a from config if it exists
    const a2aSettings = (instance.config as Record<string, unknown>)?.a2a as A2ASettings | undefined;

    // Prefer the saved gateway host so route rebuilds stay aligned with the live instance URL.
    let fqdn = "localhost";
    if (typeof instance.gateway_url === "string" && instance.gateway_url.trim()) {
      try {
        fqdn = new URL(instance.gateway_url).hostname;
      } catch {
        // Fall through to env-based reconstruction below.
      }
    }
    if (fqdn === "localhost") {
      const dnsDomain = process.env.NEXT_PUBLIC_DNS_DOMAIN_DEPLOY;
      if (dnsDomain && instance.subdomain) {
        fqdn = `${instance.subdomain}.${dnsDomain}`;
      }
    }

    // FAIL CLOSED on the health probe's precondition. The reload script only
    // snapshots + rolls back the old Caddyfile when it has a probeable public
    // hostname; with no fqdn it writes the new Caddyfile, skips the probe,
    // discards the rollback snapshot and reports OK. A bad rewrite would be
    // permanent AND silent. If we can't identify the box's public hostname we
    // have no business rewriting its public Caddyfile.
    if (fqdn === "localhost" || !CADDY_FQDN_ALLOWLIST.test(fqdn)) {
      throw new Error("Refusing to rebuild Caddy routing without a probeable public hostname");
    }

    // Dynamic import to avoid circular dependencies
    const { buildAgentCaddyfile, agentPortsForBackend } = await import("@/lib/services/hetzner-instance-service");

    // Backend determines which port preset Caddy reverse-proxies to:
    // legacy gateway agents bind 8642 (main) + 9090 (sidecar), WebUI
    // agents bind 8787 (main) + 8788 (sidecar). Picking the wrong
    // preset is what produced the all-endpoints-502 outage when the
    // WebUI image bumped past the legacy port assumptions.
    const ports = agentPortsForBackend(typeof instance.backend === "string" ? instance.backend : null);
    const newCaddyfile = buildAgentCaddyfile(fqdn, containerName, a2aSettings, profileRoutes, ports);

    const script = buildCaddyReloadWithHealthProbeScript({
      instanceId,
      caddyfile: newCaddyfile,
      probeFqdn: fqdn,
    });

    const res = await sshExec(ip, script, { proxmoxHostConfig: guestTarget });
    // Audit every Caddy reload (success or failure) to ops-events. The
    // 2026-04-30 outage left the fleet in a quietly-broken state for
    // hours because we had no record of what changed in any one
    // Caddyfile. The hash + run state lets ops correlate "chat broke
    // around X" with "Caddyfile was rewritten at X" without SSH'ing
    // into the host. The Caddyfile bytes themselves never enter the
    // event — only its sha256 — so secrets and per-instance bearer
    // tokens stay off the audit trail.
    const caddyfileHash = createHash("sha256").update(newCaddyfile).digest("hex");
    const stdoutTail = redactSensitiveCommandOutput(res.stdout || "", 600);
    const stderrTail = redactSensitiveCommandOutput(res.stderr || "", 600);
    void reportOpsEvent({
      source: "profile-service.update-agent-caddy-routing",
      severity: res.ok ? "info" : "error",
      title: res.ok
        ? "Caddy routing reloaded"
        : "Caddy routing reload failed",
      message: res.ok
        ? `Caddyfile rewritten + reloaded for instance ${instanceId} (fqdn=${fqdn}, backend=${instance.backend ?? "<null>"})`
        : `Caddyfile reload failed for instance ${instanceId} — host script exited non-zero, see metadata for redacted stdout/stderr`,
      instanceId,
      userId,
      metadata: {
        fqdn,
        backend: instance.backend ?? null,
        caddyfileSha256: caddyfileHash,
        caddyfileBytes: newCaddyfile.length,
        agentPort: ports.agent,
        sidecarPort: ports.sidecar,
        profileRouteCount: profileRoutes.length,
        scriptOk: res.ok,
        stdoutTail,
        stderrTail,
      },
    });

    if (!res.ok) {
       log.error("failed to reload Caddy routing for profiles", new Error("caddy reload failed"), {
         source: LOG_SOURCE,
         failureType: "caddy_reload_failed",
         instanceId,
         userId,
         caddyfileSha256: caddyfileHash,
         redactedStderr: stderrTail,
         redactedStdout: stdoutTail,
       });
       throw new Error("Failed to reload routing layer");
    }
  }
}

/**
 * Build the host-side bash script that:
 *   1. Snapshots the current per-instance Caddyfile (if any)
 *   2. Writes the new Caddyfile
 *   3. Runs `caddy validate` then `caddy reload`
 *   4. Health-probes the public gateway from inside the host
 *   5. Rolls back to the snapshot if any step fails
 *
 * Why the rollback exists: previously updateAgentCaddyRouting was a
 * one-way write — `validate` + `reload` would succeed for a syntactically
 * valid Caddyfile that happened to point at the wrong reverse_proxy
 * port, or at a hostname Caddy can't get a cert for. The Caddyfile
 * looked accepted, but the actual gateway started returning 502s and
 * TLS handshake errors on every request. The 2026-04-30 Hetzner outage
 * was that exact shape: a redeploy generated a Caddyfile whose port
 * mapping didn't match the new agent image's ports + whose site label
 * targeted a hermesos.cloud subdomain with no DNS A record, and Caddy
 * "successfully" reloaded into a broken state. Health-probing closes
 * the loop: if the public gateway can't actually serve a request after
 * the reload, the previous Caddyfile is restored and Caddy is reloaded
 * back to the known-good config.
 */
function buildCaddyReloadWithHealthProbeScript(input: {
  instanceId: string;
  caddyfile: string;
  /** The hostname Caddy should serve for this instance, e.g. `203-0-113-11.sslip.io`.
   *  Pass null for localhost / dev — the probe is skipped in that case
   *  because we have no public hostname to point curl at.
   *
   *  NOTE: skipping the probe ALSO skips the rollback, so a bad Caddyfile
   *  written this way is permanent and still reports OK. updateAgentCaddyRouting
   *  therefore refuses to call in without a valid fqdn; the null branch survives
   *  only for direct/dev use. */
  probeFqdn: string | null;
}): string {
  const escapedCaddyfile = input.caddyfile.replace(/'/g, "'\\''");
  // The fqdn flows into shell variable assignment + curl flags, so be
  // strict about what we accept. Allow only the characters that show up
  // in real per-instance hostnames: alphanumerics, dot, hyphen.
  const probeFqdn = input.probeFqdn && CADDY_FQDN_ALLOWLIST.test(input.probeFqdn)
    ? input.probeFqdn
    : "";
  const probeBlock = probeFqdn
    ? `
# Health probe — give Caddy + the agent backend up to ~10s to settle,
# then verify the public site responds with anything that isn't a 5xx
# or a connection/TLS error. --resolve bypasses DNS so this works even
# when the agent's hostname isn't (yet) in public DNS — we only care
# about Caddy + the reverse_proxy backend, not name resolution. We
# accept any 2xx/3xx/4xx as healthy: 4xx ("/" not found, /api/health
# missing) still proves Caddy → backend round-tripped, which is the
# whole point of this probe.
HEALTH_FQDN='${probeFqdn}'
HEALTH_OK=0
HEALTH_STATUS=000
for attempt in 1 2 3 4 5; do
  HEALTH_STATUS=$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 3 --resolve "\${HEALTH_FQDN}:443:127.0.0.1" "https://\${HEALTH_FQDN}/" 2>/dev/null || echo '000')
  if [ "$HEALTH_STATUS" != "000" ] && [ "$HEALTH_STATUS" -lt 500 ]; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

if [ "$HEALTH_OK" != "1" ]; then
  echo "HEALTH_PROBE_FAILED status=$HEALTH_STATUS"
  if [ -f "$INST_DIR/Caddyfile.before-reload" ]; then
    mv "$INST_DIR/Caddyfile.before-reload" "$INST_DIR/Caddyfile"
    docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  fi
  exit 1
fi
`
    : `
# Skipping health probe — no public fqdn to probe (localhost / dev).
`;

  return `
set -u
INST_DIR=/opt/hermes/instances/${input.instanceId}
mkdir -p "$INST_DIR"
cd "$INST_DIR"

# Snapshot the current Caddyfile so we can roll back if anything below
# fails. Using a deterministic name (no timestamp) so the rollback path
# is unambiguous; cleared on success at the bottom of the script.
if [ -f Caddyfile ]; then
  cp Caddyfile Caddyfile.before-reload
fi

cat > Caddyfile.new << 'CADDYEOF'
${escapedCaddyfile}
CADDYEOF
mv Caddyfile.new Caddyfile

cd /opt/hermes
if ! docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "VALIDATE_FAILED"
  if [ -f "$INST_DIR/Caddyfile.before-reload" ]; then
    mv "$INST_DIR/Caddyfile.before-reload" "$INST_DIR/Caddyfile"
  else
    rm -f "$INST_DIR/Caddyfile"
  fi
  exit 1
fi

if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "RELOAD_FAILED"
  if [ -f "$INST_DIR/Caddyfile.before-reload" ]; then
    mv "$INST_DIR/Caddyfile.before-reload" "$INST_DIR/Caddyfile"
    docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  fi
  exit 1
fi
${probeBlock}
# Success — discard the rollback snapshot
rm -f "$INST_DIR/Caddyfile.before-reload"
echo "OK${probeFqdn ? " status=$HEALTH_STATUS" : ""}"
`;
}

export const __test__ = { buildCaddyReloadWithHealthProbeScript };
