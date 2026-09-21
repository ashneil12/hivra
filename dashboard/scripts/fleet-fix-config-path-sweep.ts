/**
 * Fleet sweep: drop the pinned HERMES_CONFIG_PATH env var from every WebUI
 * agent container that still carries it.
 *
 * The env var was hard-coded in the old compose template, which short-circuited
 * WebUI's per-profile config path lookup — sub-agent model edits silently
 * rewrote the default profile's config.yaml instead of the sub-agent's.
 *
 * Existing containers carry the env var baked into their environ; the dashboard
 * fix only applies to *new* deploys. This script remediates the running fleet.
 *
 * Default mode is dry-run. Pass `--apply` to actually mutate compose files and
 * recreate containers.
 *
 * Usage:
 *   # Dry-run report
 *   npm run ops:fix-config-path-sweep
 *
 *   # Apply (per-host: backup compose, drop env line, docker compose up -d,
 *   # wait for healthy)
 *   npm run ops:fix-config-path-sweep -- --apply
 *
 *   # Single host (debug)
 *   npm run ops:fix-config-path-sweep -- --ip 203.0.113.10 --apply
 */

import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";

loadEnvConfig(process.cwd());

type OutputFormat = "markdown" | "json";

interface Args {
  format: OutputFormat;
  apply: boolean;
  concurrency: number;
  ipFilter: string | null;
  instanceFilter: string | null;
}

interface HetznerServer {
  name: string;
  status: string;
  public_net?: {
    ipv4?: {
      ip?: string | null;
    } | null;
  } | null;
}

interface InstanceRow {
  id: string;
  name: string | null;
  status: string;
  ipv4_address: string | null;
}

interface AgentResult {
  instanceId: string;
  containerName: string;
  health: string | null;
  envVarPresent: boolean;
  composePath: string | null;
  composeHadLine: boolean;
  action: "skipped-not-affected" | "skipped-unhealthy" | "skipped-no-compose" | "would-fix" | "fixed" | "failed";
  error?: string;
  postRecreateHealth?: string | null;
}

interface HostResult {
  host: string;
  ip: string;
  status: string;
  sshOk: boolean;
  sshError?: string;
  agents: AgentResult[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    format: "markdown",
    apply: false,
    concurrency: 3,
    ipFilter: null,
    instanceFilter: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      args.format = "json";
      continue;
    }

    if (arg === "--apply") {
      args.apply = true;
      continue;
    }

    if (arg === "--concurrency") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("Missing value for `--concurrency`");
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
        throw new Error("`--concurrency` must be a number from 1 to 20");
      }
      args.concurrency = Math.trunc(parsed);
      index += 1;
      continue;
    }

    if (arg === "--ip") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("Missing value for `--ip`");
      args.ipFilter = raw;
      index += 1;
      continue;
    }

    if (arg === "--instance") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("Missing value for `--instance`");
      args.instanceFilter = raw;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function fetchHetznerServers(): Promise<HetznerServer[]> {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) {
    throw new Error("HETZNER_API_TOKEN is not configured");
  }

  const servers: HetznerServer[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.hetzner.cloud/v1/servers?per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Hetzner API failed (${response.status}): ${await response.text()}`);
    }

    const payload = await response.json();
    servers.push(...(payload.servers || []));
    if (!payload.meta?.pagination?.next_page) break;
  }

  return servers;
}

async function fetchActiveInstances(): Promise<InstanceRow[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase admin credentials are not configured");
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("hermes_instances")
    .select("id,name,status,ipv4_address")
    .neq("status", "deleted");

  if (error) {
    throw new Error(`Failed to fetch Hermes instances: ${error.message}`);
  }

  return (data || []) as InstanceRow[];
}

/**
 * Remote script — runs on the VPS via SSH. Pure read in probe mode; mutates
 * only when APPLY=1.
 *
 * Behavior per agent container:
 *   1. Skip non-WebUI containers (no HERMES_CONFIG_PATH in env → already fine).
 *   2. Skip containers that aren't healthy/running (don't kick a dying box).
 *   3. Locate compose dir via /opt/hermes/instances/<id>.
 *   4. Backup compose (.bak.<timestamp>), strip the line, `docker compose up -d`.
 *   5. Wait up to 90s for healthy state. Report final status.
 *
 * Output is a single JSON object on the last stdout line.
 */
const REMOTE_SCRIPT = String.raw`
python3 - <<'PY'
import json, os, shutil, subprocess, time

APPLY = os.environ.get("APPLY") == "1"

def run(cmd, timeout=20, capture=True):
    return subprocess.run(
        cmd,
        shell=isinstance(cmd, str),
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
        timeout=timeout,
    )

def docker_inspect(name):
    res = run(["docker", "inspect", name], timeout=15)
    if res.returncode != 0:
        return None
    try:
        return json.loads(res.stdout)[0]
    except (json.JSONDecodeError, IndexError):
        return None

def container_health(info):
    state = info.get("State") or {}
    health = (state.get("Health") or {}).get("Status")
    if health:
        return health
    return state.get("Status")

def env_has_var(info, name):
    env_list = (info.get("Config") or {}).get("Env") or []
    prefix = name + "="
    return any(line.startswith(prefix) for line in env_list)

def find_compose_dir(instance_id):
    candidate = f"/opt/hermes/instances/{instance_id}"
    if os.path.isfile(os.path.join(candidate, "docker-compose.yml")):
        return candidate
    return None

def has_config_path_line(compose_path):
    try:
        with open(compose_path, "r", encoding="utf-8") as f:
            return any("HERMES_CONFIG_PATH=" in line for line in f)
    except OSError:
        return False

def strip_config_path_line(compose_path):
    backup = compose_path + ".bak." + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    shutil.copy2(compose_path, backup)
    with open(compose_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    kept = [line for line in lines if "HERMES_CONFIG_PATH=" not in line]
    with open(compose_path, "w", encoding="utf-8") as f:
        f.writelines(kept)
    return backup

def docker_compose_up(compose_dir):
    return subprocess.run(
        "docker compose up -d",
        shell=True,
        cwd=compose_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
    )

def wait_for_healthy(name, deadline_secs=120):
    end = time.time() + deadline_secs
    last = None
    while time.time() < end:
        info = docker_inspect(name)
        if info is None:
            time.sleep(2)
            continue
        last = container_health(info)
        if last == "healthy" or last == "running":
            # If a healthcheck is configured we want "healthy"; if none we
            # accept "running". Look up whether one is configured.
            has_health = bool((info.get("Config") or {}).get("Healthcheck"))
            if has_health and last != "healthy":
                time.sleep(3)
                continue
            return last
        if last in ("exited", "dead"):
            return last
        time.sleep(3)
    return last

out = {"agents": []}

ps = run(["docker", "ps", "--format", "{{.Names}}"], timeout=15)
if ps.returncode != 0:
    out["dockerError"] = (ps.stderr or ps.stdout).strip()[:500]
    print(json.dumps(out, sort_keys=True))
    raise SystemExit

container_names = [n for n in ps.stdout.splitlines() if n.startswith("agent-")]

for name in container_names:
    if name.endswith(("-web", "-sidecar", "-camofox", "-acp", "-mcp")):
        continue

    instance_id = name[len("agent-"):]
    item = {
        "instanceId": instance_id,
        "containerName": name,
        "health": None,
        "envVarPresent": False,
        "composePath": None,
        "composeHadLine": False,
        "action": "skipped-not-affected",
    }

    info = docker_inspect(name)
    if info is None:
        item["action"] = "failed"
        item["error"] = "docker inspect failed"
        out["agents"].append(item)
        continue

    item["health"] = container_health(info)
    item["envVarPresent"] = env_has_var(info, "HERMES_CONFIG_PATH")

    if not item["envVarPresent"]:
        # Already on the new template, or non-WebUI backend.
        out["agents"].append(item)
        continue

    compose_dir = find_compose_dir(instance_id)
    if compose_dir is None:
        item["action"] = "skipped-no-compose"
        item["error"] = f"no docker-compose.yml under /opt/hermes/instances/{instance_id}"
        out["agents"].append(item)
        continue

    compose_path = os.path.join(compose_dir, "docker-compose.yml")
    item["composePath"] = compose_path
    item["composeHadLine"] = has_config_path_line(compose_path)

    if item["health"] not in ("healthy", "running"):
        item["action"] = "skipped-unhealthy"
        item["error"] = f"container health is {item['health']!r}; refusing to recreate"
        out["agents"].append(item)
        continue

    if not APPLY:
        item["action"] = "would-fix"
        out["agents"].append(item)
        continue

    try:
        if item["composeHadLine"]:
            strip_config_path_line(compose_path)
        # Some existing containers were not created under the current compose
        # project label (e.g. legacy direct docker run, or compose run from a
        # different cwd). For those, compose up -d tries to *create* a new
        # container and collides on the fixed container_name. Remove the
        # existing container first so the recreate is clean. Named volumes
        # are external to the container and survive removal, so chat history,
        # sessions DB, and profile config persist across this step.
        run(["docker", "stop", "-t", "10", name], timeout=30)
        run(["docker", "rm", "-f", name], timeout=30)
        compose_res = docker_compose_up(compose_dir)
        if compose_res.returncode != 0:
            item["action"] = "failed"
            item["error"] = (compose_res.stderr or compose_res.stdout).strip()[:600]
            out["agents"].append(item)
            continue
        final = wait_for_healthy(name, deadline_secs=150)
        item["postRecreateHealth"] = final
        if final == "healthy" or final == "running":
            item["action"] = "fixed"
        else:
            item["action"] = "failed"
            item["error"] = f"container did not return to healthy after recreate (last={final!r})"
    except Exception as exc:
        item["action"] = "failed"
        item["error"] = repr(exc)[:600]

    out["agents"].append(item)

print(json.dumps(out, sort_keys=True))
PY
`;

function toAgentResult(raw: Record<string, unknown>): AgentResult {
  return {
    instanceId: typeof raw.instanceId === "string" ? raw.instanceId : "",
    containerName: typeof raw.containerName === "string" ? raw.containerName : "",
    health: typeof raw.health === "string" ? raw.health : null,
    envVarPresent: raw.envVarPresent === true,
    composePath: typeof raw.composePath === "string" ? raw.composePath : null,
    composeHadLine: raw.composeHadLine === true,
    action: (raw.action as AgentResult["action"]) || "skipped-not-affected",
    error: typeof raw.error === "string" ? raw.error : undefined,
    postRecreateHealth: typeof raw.postRecreateHealth === "string" ? raw.postRecreateHealth : undefined,
  };
}

async function probeHost(server: HetznerServer, apply: boolean): Promise<HostResult> {
  const ip = server.public_net?.ipv4?.ip || "";
  const host: HostResult = {
    host: server.name,
    ip,
    status: server.status,
    sshOk: false,
    agents: [],
  };

  if (server.status !== "running" || !ip) {
    return host;
  }

  type SshModule = typeof import("../src/lib/hetzner/ssh");
  const importedSshModule = await import("../src/lib/hetzner/ssh") as SshModule & { default?: SshModule };
  const sshModule = importedSshModule.default ?? importedSshModule;

  // `export` so the var crosses the heredoc boundary on the remote shell —
  // bare `APPLY=1\npython3 …` would set the var only for the (empty) line, not
  // for python.
  const remoteCommand = `export APPLY=${apply ? 1 : 0}\n${REMOTE_SCRIPT}`;

  try {
    const result = await sshModule.sshExec(ip, remoteCommand, { timeoutMs: 240_000 });
    if (!result.ok) {
      host.sshError = result.error || result.stderr || "ssh failed";
      return host;
    }
    const lastLine = (result.stdout || "").trim().split("\n").pop() || "{}";
    const parsed = JSON.parse(lastLine) as { agents?: Record<string, unknown>[]; dockerError?: string };
    if (parsed.dockerError) {
      host.sshError = `docker error: ${parsed.dockerError}`;
    }
    host.sshOk = true;
    host.agents = (parsed.agents || []).map(toAgentResult);
  } catch (error) {
    host.sshError = error instanceof Error ? error.message : String(error);
  }

  return host;
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const slice = items.slice(index, index + concurrency);
    const sliceResults = await Promise.all(slice.map(mapper));
    results.push(...sliceResults);
  }
  return results;
}

function summarize(hosts: HostResult[]) {
  let totalAgents = 0;
  let needsFix = 0;
  let fixed = 0;
  let failed = 0;
  let skippedUnhealthy = 0;

  for (const host of hosts) {
    for (const agent of host.agents) {
      totalAgents += 1;
      if (agent.action === "would-fix") needsFix += 1;
      if (agent.action === "fixed") fixed += 1;
      if (agent.action === "failed") failed += 1;
      if (agent.action === "skipped-unhealthy") skippedUnhealthy += 1;
    }
  }

  const sshErrors = hosts.filter((h) => h.sshError).length;

  return { totalHosts: hosts.length, totalAgents, needsFix, fixed, failed, skippedUnhealthy, sshErrors };
}

function formatMarkdown(hosts: HostResult[], apply: boolean): string {
  const summary = summarize(hosts);
  const lines: string[] = [];
  lines.push(`# Fleet HERMES_CONFIG_PATH sweep — ${apply ? "APPLY" : "DRY RUN"}`);
  lines.push("");
  lines.push(`Hosts probed: **${summary.totalHosts}**  •  Agent containers: **${summary.totalAgents}**`);
  lines.push(
    `Needs fix: **${summary.needsFix}**  •  Fixed: **${summary.fixed}**  •  Failed: **${summary.failed}**  •  Skipped (unhealthy): **${summary.skippedUnhealthy}**  •  SSH errors: **${summary.sshErrors}**`,
  );
  lines.push("");

  for (const host of hosts) {
    if (!host.sshError && host.agents.length === 0) continue;

    lines.push(`## ${host.host} — ${host.ip}`);
    if (host.sshError) {
      lines.push(`- **SSH error**: \`${host.sshError}\``);
    }
    for (const agent of host.agents) {
      const tag = `[${agent.action}]`;
      const detail = agent.error ? ` — ${agent.error}` : "";
      const post = agent.postRecreateHealth ? ` (post-recreate: ${agent.postRecreateHealth})` : "";
      lines.push(
        `- ${tag} \`${agent.containerName}\` health=${agent.health ?? "?"} env=${agent.envVarPresent}${post}${detail}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const [hetznerServers, instances] = await Promise.all([
    fetchHetznerServers(),
    fetchActiveInstances(),
  ]);

  const hetznerIps = new Set(
    hetznerServers
      .map((server) => server.public_net?.ipv4?.ip || "")
      .filter((ip) => ip.length > 0),
  );

  // Stitch in any active instances that have an IP we don't see on Hetzner
  // (legacy non-Hetzner hosts, or projects on a different Hetzner account).
  const syntheticInstanceServers: HetznerServer[] = instances
    .filter((instance) => instance.status === "running")
    .filter((instance) => Boolean(instance.ipv4_address) && !hetznerIps.has(instance.ipv4_address as string))
    .map((instance) => ({
      name: `instance-${instance.id}`,
      status: "running",
      public_net: { ipv4: { ip: instance.ipv4_address } },
    }));

  let allServers = [...hetznerServers, ...syntheticInstanceServers];

  if (args.ipFilter) {
    allServers = allServers.filter((s) => s.public_net?.ipv4?.ip === args.ipFilter);
    if (allServers.length === 0) {
      throw new Error(`No host found matching --ip ${args.ipFilter}`);
    }
  }

  if (args.instanceFilter) {
    const instance = instances.find((i) => i.id === args.instanceFilter);
    if (!instance?.ipv4_address) {
      throw new Error(`Instance ${args.instanceFilter} not found or has no IP`);
    }
    allServers = allServers.filter((s) => s.public_net?.ipv4?.ip === instance.ipv4_address);
  }

  if (args.apply) {
    console.error(`!! APPLY mode — will mutate compose files and recreate containers on ${allServers.length} host(s)`);
    console.error(`!! Concurrency: ${args.concurrency}.  Cancel within 5s to abort.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const hosts = await mapLimit(allServers, args.concurrency, (server) => probeHost(server, args.apply));

  if (args.format === "json") {
    console.log(JSON.stringify({ summary: summarize(hosts), hosts, apply: args.apply }, null, 2));
  } else {
    console.log(formatMarkdown(hosts, args.apply));
  }

  const { failed, sshErrors } = summarize(hosts);
  if (failed > 0 || sshErrors > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fleet HERMES_CONFIG_PATH sweep failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
