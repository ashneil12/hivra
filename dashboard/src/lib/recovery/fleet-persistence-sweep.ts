type FleetPersistenceSeverity = "info" | "warn" | "error";

export interface FleetInstanceRow {
  id: string;
  name: string | null;
  status: string | null;
  ipv4_address: string | null;
}

export interface FleetHostProbe {
  host: string;
  ip: string;
  status: string;
  sshOk: boolean;
  sshError?: string;
  agents: FleetAgentProbe[];
}

export interface FleetAgentProbe {
  instanceId: string;
  containerName: string;
  containerStatus: string | null;
  webStatus?: string | null;
  restartPolicy?: string | null;
  sessionsMounted: boolean;
  sessionsMountType?: string | null;
  sessionsMountName?: string | null;
  profilesMounted: boolean;
  profilesMountType?: string | null;
  profilesMountName?: string | null;
  dbExists?: boolean;
  sqliteIntegrity?: string | null;
  sessionRows?: number;
  messageRows?: number;
  assistantRows?: number;
  blankAssistantRows?: number;
  blankAssistantUuidRows?: number;
}

interface FleetPersistenceFinding {
  severity: FleetPersistenceSeverity;
  code:
    | "host-ssh-failed"
    | "instance-missing-ip"
    | "instance-ip-mismatch"
    | "instance-container-missing"
    | "container-unhealthy"
    | "sessions-volume-missing"
    | "profiles-volume-missing"
    | "sqlite-missing"
    | "sqlite-integrity-failed"
    | "blank-assistant-uuid-rows";
  message: string;
  instanceId?: string;
  instanceName?: string | null;
  host?: string;
  ip?: string;
  count?: number;
}

export interface FleetPersistenceReport {
  generatedAt: string;
  summary: {
    hosts: number;
    sshOk: number;
    agents: number;
    activeInstances: number;
    matchedActiveInstances: number;
    sqliteOk: number;
    findings: number;
    errors: number;
    warnings: number;
  };
  findings: FleetPersistenceFinding[];
  hosts: FleetHostProbe[];
}

export function extractInstanceIdFromAgentContainer(containerName: string): string | null {
  const match = /^agent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(containerName);
  return match ? match[1] : null;
}

function isActiveInstance(instance: FleetInstanceRow): boolean {
  return instance.status === "running";
}

function isRunningHost(host: FleetHostProbe): boolean {
  return host.status === "running";
}

function isSafeNamedVolume(mounted: boolean, type?: string | null): boolean {
  return mounted && type === "volume";
}

function displayInstance(instance: FleetInstanceRow): string {
  return instance.name ? `${instance.name} (${instance.id})` : instance.id;
}

export function buildFleetPersistenceReport(input: {
  hosts: FleetHostProbe[];
  instances: FleetInstanceRow[];
  generatedAt?: string;
}): FleetPersistenceReport {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const activeInstances = input.instances.filter(isActiveInstance);
  const activeById = new Map(activeInstances.map((instance) => [instance.id, instance]));
  const agentByInstanceId = new Map<string, { host: FleetHostProbe; agent: FleetAgentProbe }>();
  const findings: FleetPersistenceFinding[] = [];

  for (const host of input.hosts) {
    if (isRunningHost(host) && !host.sshOk) {
      findings.push({
        severity: "error",
        code: "host-ssh-failed",
        message: `Could not SSH into ${host.host} (${host.ip}): ${host.sshError || "unknown error"}`,
        host: host.host,
        ip: host.ip,
      });
      continue;
    }

    for (const agent of host.agents) {
      agentByInstanceId.set(agent.instanceId, { host, agent });
    }
  }

  for (const instance of activeInstances) {
    const match = agentByInstanceId.get(instance.id);

    if (!match) {
      findings.push({
        severity: "error",
        code: "instance-container-missing",
        message: `No live agent container was found for ${displayInstance(instance)}.`,
        instanceId: instance.id,
        instanceName: instance.name,
        ip: instance.ipv4_address || undefined,
      });
      continue;
    }

    if (!instance.ipv4_address) {
      findings.push({
        severity: "warn",
        code: "instance-missing-ip",
        message: `${displayInstance(instance)} is missing ipv4_address in Supabase; discovered ${match.host.ip} from Hetzner.`,
        instanceId: instance.id,
        instanceName: instance.name,
        host: match.host.host,
        ip: match.host.ip,
      });
    } else if (instance.ipv4_address !== match.host.ip) {
      findings.push({
        severity: "warn",
        code: "instance-ip-mismatch",
        message: `${displayInstance(instance)} has Supabase IP ${instance.ipv4_address}, but the live container is on ${match.host.ip}.`,
        instanceId: instance.id,
        instanceName: instance.name,
        host: match.host.host,
        ip: match.host.ip,
      });
    }
  }

  for (const { host, agent } of agentByInstanceId.values()) {
    const instance = activeById.get(agent.instanceId);
    const instanceName = instance?.name || null;
    const base = instance ? displayInstance(instance) : agent.instanceId;

    if (agent.containerStatus && agent.containerStatus !== "running") {
      findings.push({
        severity: "error",
        code: "container-unhealthy",
        message: `${base} main container is ${agent.containerStatus}.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if (agent.webStatus && agent.webStatus !== "running") {
      findings.push({
        severity: "warn",
        code: "container-unhealthy",
        message: `${base} web container is ${agent.webStatus}.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if (!isSafeNamedVolume(agent.sessionsMounted, agent.sessionsMountType)) {
      findings.push({
        severity: "error",
        code: "sessions-volume-missing",
        message: `${base} sessions are not mounted on a Docker named volume.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if (!isSafeNamedVolume(agent.profilesMounted, agent.profilesMountType)) {
      findings.push({
        severity: "error",
        code: "profiles-volume-missing",
        message: `${base} profiles are not mounted on a Docker named volume.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if (agent.dbExists === false) {
      findings.push({
        severity: "warn",
        code: "sqlite-missing",
        message: `${base} has no state.db yet in its sessions volume.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if (agent.dbExists && agent.sqliteIntegrity !== "ok") {
      findings.push({
        severity: "error",
        code: "sqlite-integrity-failed",
        message: `${base} SQLite integrity check returned ${agent.sqliteIntegrity || "unknown"}.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
      });
    }

    if ((agent.blankAssistantUuidRows || 0) > 0) {
      findings.push({
        severity: "warn",
        code: "blank-assistant-uuid-rows",
        message: `${base} has ${agent.blankAssistantUuidRows} blank assistant placeholder row(s) with UUID message IDs.`,
        instanceId: agent.instanceId,
        instanceName,
        host: host.host,
        ip: host.ip,
        count: agent.blankAssistantUuidRows,
      });
    }
  }

  const agents = Array.from(agentByInstanceId.values()).map((entry) => entry.agent);
  const matchedActiveInstances = activeInstances.filter((instance) => agentByInstanceId.has(instance.id)).length;

  return {
    generatedAt,
    summary: {
      hosts: input.hosts.length,
      sshOk: input.hosts.filter((host) => host.sshOk).length,
      agents: agents.length,
      activeInstances: activeInstances.length,
      matchedActiveInstances,
      sqliteOk: agents.filter((agent) => agent.sqliteIntegrity === "ok").length,
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warn").length,
    },
    findings,
    hosts: input.hosts,
  };
}

export function formatFleetPersistenceMarkdownReport(report: FleetPersistenceReport): string {
  const lines = [
    "# Hermes Fleet Persistence Sweep",
    `Generated: ${report.generatedAt}`,
    `Hosts checked: ${report.summary.hosts}`,
    `SSH reachable: ${report.summary.sshOk}`,
    `Agent containers: ${report.summary.agents}`,
    `Active instances matched: ${report.summary.matchedActiveInstances}/${report.summary.activeInstances}`,
    `SQLite integrity OK: ${report.summary.sqliteOk}`,
    `Findings: ${report.summary.findings} (${report.summary.errors} error, ${report.summary.warnings} warn)`,
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("No fleet persistence findings.");
    return lines.join("\n");
  }

  lines.push("Findings:");
  for (const finding of report.findings) {
    lines.push(
      `- [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`
    );
  }

  return lines.join("\n");
}
