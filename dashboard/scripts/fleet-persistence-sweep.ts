import { createClient } from "@supabase/supabase-js";
import {
  buildFleetPersistenceReport,
  extractInstanceIdFromAgentContainer,
  formatFleetPersistenceMarkdownReport,
  type FleetAgentProbe,
  type FleetHostProbe,
  type FleetInstanceRow,
} from "../src/lib/recovery/fleet-persistence-sweep";
import { describeErrorWithCauses } from "../src/lib/ops/describe-error-with-causes";
import { loadOpsEnv } from "../src/lib/ops/load-ops-env";

loadOpsEnv(process.cwd());

type OutputFormat = "markdown" | "json";

interface Args {
  format: OutputFormat;
  fixIps: boolean;
  concurrency: number;
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

function parseArgs(argv: string[]): Args {
  const args: Args = {
    format: "markdown",
    fixIps: false,
    concurrency: 6,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      args.format = "json";
      continue;
    }

    if (arg === "--fix-ips") {
      args.fixIps = true;
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

    if (arg === "--format") {
      const raw = argv[index + 1];
      if (raw !== "markdown" && raw !== "json") {
        throw new Error("`--format` must be either `markdown` or `json`");
      }
      args.format = raw;
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

async function fetchActiveInstances(): Promise<FleetInstanceRow[]> {
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

  return (data || []) as FleetInstanceRow[];
}

const REMOTE_PROBE_SCRIPT = String.raw`
python3 - <<'PY'
import json, os, sqlite3, subprocess

def run(cmd):
    return subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)

out = {"agents": []}
ps = run("docker ps -a --format '{{.Names}}|{{.Status}}|{{.Image}}'")
out["dockerOk"] = ps.returncode == 0
if ps.returncode != 0:
    out["dockerError"] = (ps.stderr or ps.stdout).strip()[:500]
    print(json.dumps(out, sort_keys=True))
    raise SystemExit

containers = []
for line in ps.stdout.splitlines():
    parts = line.split("|", 2)
    if len(parts) == 3:
        containers.append({"name": parts[0], "status": parts[1], "image": parts[2]})

names = {c["name"]: c for c in containers}
for c in containers:
    name = c["name"]
    if not name.startswith("agent-"):
        continue
    if name.endswith(("-web", "-sidecar", "-camofox", "-acp", "-mcp")):
        continue

    item = {"containerName": name, "statusText": c["status"]}
    inspected = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    item["inspectOk"] = inspected.returncode == 0
    if inspected.returncode != 0:
        item["inspectError"] = (inspected.stderr or inspected.stdout).strip()[:500]
        out["agents"].append(item)
        continue

    info = json.loads(inspected.stdout)[0]
    mounts = info.get("Mounts") or []
    item["containerStatus"] = (info.get("State") or {}).get("Status")
    item["restartPolicy"] = ((info.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name")
    web = names.get(name + "-web")
    if web:
        web_inspected = subprocess.run(["docker", "inspect", name + "-web"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if web_inspected.returncode == 0:
            web_info = json.loads(web_inspected.stdout)[0]
            item["webStatus"] = (web_info.get("State") or {}).get("Status")

    def find_mount(destinations):
        for mount in mounts:
            if (mount.get("Destination") or "").rstrip("/") in destinations:
                return mount
        return None

    sessions_mount = find_mount([
        "/root/.hermes/sessions",
        "/opt/data/sessions",
        "/home/hermes/.hermes/sessions",
        "/home/hermes/.hermes/sessions",
        "/home/hermes/.hermes",
    ])
    profiles_mount = find_mount([
        "/root/.hermes/profiles",
        "/opt/data/profiles",
        "/home/hermes/.hermes/profiles",
        "/home/hermes/.hermes/profiles",
        "/home/hermes/.hermes",
    ])
    item["sessionsMounted"] = bool(sessions_mount)
    item["sessionsMountType"] = sessions_mount.get("Type") if sessions_mount else None
    item["sessionsMountName"] = sessions_mount.get("Name") if sessions_mount else None
    item["profilesMounted"] = bool(profiles_mount)
    item["profilesMountType"] = profiles_mount.get("Type") if profiles_mount else None
    item["profilesMountName"] = profiles_mount.get("Name") if profiles_mount else None

    if sessions_mount:
        db_path = os.path.join(sessions_mount["Source"], "state.db")
        item["dbExists"] = os.path.exists(db_path)
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True, timeout=5)
                cursor = conn.cursor()
                item["sqliteIntegrity"] = cursor.execute("pragma integrity_check").fetchone()[0]
                tables = {row[0] for row in cursor.execute("select name from sqlite_master where type='table'")}
                if "sessions" in tables:
                    item["sessionRows"] = cursor.execute("select count(*) from sessions").fetchone()[0]
                if "messages" in tables:
                    columns = [row[1] for row in cursor.execute("pragma table_info(messages)")]
                    item["messageRows"] = cursor.execute("select count(*) from messages").fetchone()[0]
                    if "role" in columns:
                        item["assistantRows"] = cursor.execute("select count(*) from messages where role='assistant'").fetchone()[0]
                        if "content" in columns:
                            item["blankAssistantRows"] = cursor.execute("select count(*) from messages where role='assistant' and (content is null or trim(content)='')").fetchone()[0]
                    if all(col in columns for col in ("role", "content", "message_id")):
                        item["blankAssistantUuidRows"] = cursor.execute("select count(*) from messages where role='assistant' and message_id like '%-%' and (content is null or trim(content)='')").fetchone()[0]
                conn.close()
            except Exception as exc:
                item["sqliteIntegrity"] = "error"
                item["sqliteError"] = repr(exc)

    out["agents"].append(item)

print(json.dumps(out, sort_keys=True))
PY
`;

function toAgentProbe(raw: Record<string, unknown>): FleetAgentProbe | null {
  const containerName = typeof raw.containerName === "string" ? raw.containerName : "";
  const instanceId = extractInstanceIdFromAgentContainer(containerName);
  if (!instanceId) return null;

  return {
    instanceId,
    containerName,
    containerStatus: typeof raw.containerStatus === "string" ? raw.containerStatus : null,
    webStatus: typeof raw.webStatus === "string" ? raw.webStatus : null,
    restartPolicy: typeof raw.restartPolicy === "string" ? raw.restartPolicy : null,
    sessionsMounted: raw.sessionsMounted === true,
    sessionsMountType: typeof raw.sessionsMountType === "string" ? raw.sessionsMountType : null,
    sessionsMountName: typeof raw.sessionsMountName === "string" ? raw.sessionsMountName : null,
    profilesMounted: raw.profilesMounted === true,
    profilesMountType: typeof raw.profilesMountType === "string" ? raw.profilesMountType : null,
    profilesMountName: typeof raw.profilesMountName === "string" ? raw.profilesMountName : null,
    dbExists: typeof raw.dbExists === "boolean" ? raw.dbExists : undefined,
    sqliteIntegrity: typeof raw.sqliteIntegrity === "string" ? raw.sqliteIntegrity : null,
    sessionRows: typeof raw.sessionRows === "number" ? raw.sessionRows : undefined,
    messageRows: typeof raw.messageRows === "number" ? raw.messageRows : undefined,
    assistantRows: typeof raw.assistantRows === "number" ? raw.assistantRows : undefined,
    blankAssistantRows: typeof raw.blankAssistantRows === "number" ? raw.blankAssistantRows : undefined,
    blankAssistantUuidRows: typeof raw.blankAssistantUuidRows === "number" ? raw.blankAssistantUuidRows : undefined,
  };
}

async function probeHost(server: HetznerServer): Promise<FleetHostProbe> {
  const ip = server.public_net?.ipv4?.ip || "";
  const host: FleetHostProbe = {
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
  try {
    const result = await sshModule.sshExec(ip, REMOTE_PROBE_SCRIPT, { timeoutMs: 45_000 });
    const line = (result.stdout || "").trim().split("\n").pop() || "{}";
    const parsed = JSON.parse(line) as { agents?: Record<string, unknown>[] };
    host.sshOk = true;
    host.agents = (parsed.agents || [])
      .map(toAgentProbe)
      .filter((agent): agent is FleetAgentProbe => Boolean(agent));
  } catch (error) {
    host.sshError = error instanceof Error ? error.message : String(error);
  }

  return host;
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(mapper)));
  }
  return results;
}

async function fixMissingIps(findings: { instanceId?: string; ip?: string }[]): Promise<number> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase admin credentials are not configured");
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let count = 0;

  for (const finding of findings) {
    if (!finding.instanceId || !finding.ip) continue;
    const { error } = await db
      .from("hermes_instances")
      .update({ ipv4_address: finding.ip })
      .eq("id", finding.instanceId)
      .is("ipv4_address", null);

    if (error) {
      throw new Error(`Failed to update IP for ${finding.instanceId}: ${error.message}`);
    }
    count += 1;
  }

  return count;
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
      .filter((ip) => ip.length > 0)
  );
  const syntheticInstanceServers: HetznerServer[] = instances
    .filter((instance) => instance.status === "running")
    .filter((instance) => Boolean(instance.ipv4_address) && !hetznerIps.has(instance.ipv4_address as string))
    .map((instance) => ({
      name: `instance-${instance.id}`,
      status: "running",
      public_net: {
        ipv4: {
          ip: instance.ipv4_address,
        },
      },
    }));
  const servers = [...hetznerServers, ...syntheticInstanceServers];
  const hosts = await mapLimit(servers, args.concurrency, probeHost);
  const report = buildFleetPersistenceReport({ hosts, instances });

  let fixedIps = 0;
  if (args.fixIps) {
    fixedIps = await fixMissingIps(report.findings.filter((finding) => finding.code === "instance-missing-ip"));
  }

  if (args.format === "json") {
    console.log(JSON.stringify({ ...report, fixedIps }, null, 2));
    return;
  }

  console.log(formatFleetPersistenceMarkdownReport(report));
  if (args.fixIps) {
    console.log(`\nFixed missing Supabase IPs: ${fixedIps}`);
  }

  if (report.summary.errors > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fleet persistence sweep failed:", describeErrorWithCauses(error));
    process.exit(1);
  });
}
