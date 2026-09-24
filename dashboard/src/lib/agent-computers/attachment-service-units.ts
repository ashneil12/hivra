import { createHash } from "node:crypto";

// Attached agent service policy v2 (design 5.3 and 5.4). The SHA-256 of THIS
// FILE's bytes is the reviewed policy the database accepts for an activation
// (ATTACHED_CODEX_SERVICE_POLICY_SHA256 and its migration gate). Any edit here
// is a new policy: it needs a new database gate and a new Python rendering in
// preflight-attached-codex-activation.py, which a test keeps byte-equal.
//
// Every path root creates or uses for an attachment is in a root-owned
// location or a tmpfs systemd creates for the unit, never in the agent's home
// (5.3.1). The agent runs in its own network namespace; the ~/Hivra view is
// bound in only with the workspace grant. There is no DISPLAY, no browser and
// no sudo in this release: those grants are not available yet (5.2).

export const ATTACHED_POLICY_VERSION = 2 as const;

/** The pinned root helpers the units run, installed by the activation step. */
export const ATTACHED_HELPERS = Object.freeze([
  Object.freeze({ file: "attached-workspace.py", path: "/usr/local/lib/hivra/attached-workspace",
    sha256: "af4c7568b237e0716ad8fc6f767bb85ee85b4fc68c8d85636b7ffa51ace3d1d3" }),
  Object.freeze({ file: "attached-network.py", path: "/usr/local/lib/hivra/attached-network",
    sha256: "08d97e5b62e86bc0339f8e2b0d38d83c966faef816fe5c4c2dd0587beccbe129" }),
  Object.freeze({ file: "attached-dns-relay.py", path: "/usr/local/lib/hivra/attached-dns-relay",
    sha256: "5fd6b334ffe66d9ecdaed1011f9f9f659cf6be1498a8c36b66b5723ff67d5bdf" }),
]);

export interface AttachedServiceInput {
  installationId: string;
  account: string;
  uid: number;
  gid: number;
  home: string;
  executable: string;
  grants: { workspace: boolean };
  /** The smaller of 2 GB and half the computer's memory, in MB. */
  memoryMaxMb: number;
}

export interface AttachedUnitFile { name: string; path: string; content: string; sha256: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** min(2 GB, half the computer's memory), whole MB, at least 512 MB. */
export function attachedMemoryMaxMb(computerRamGb: number): number {
  const half = Math.floor((Number(computerRamGb) * 1024) / 2);
  return Math.max(512, Math.min(2048, Number.isFinite(half) ? half : 512));
}

function checked(input: AttachedServiceInput): AttachedServiceInput {
  const id = input?.installationId;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid installation identity.");
  const hex24 = id.replaceAll("-", "").slice(0, 24);
  if (input.account !== `hva_${hex24}` || input.home !== `/var/lib/hivra/agent-homes/${id}`
    || input.executable !== `/opt/hivra/agent-installations/${id}/codex`
    || !Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 4294967294
    || !Number.isSafeInteger(input.gid) || input.gid < 1 || input.gid > 4294967294
    || typeof input.grants?.workspace !== "boolean" || Object.keys(input.grants).length !== 1
    || !Number.isSafeInteger(input.memoryMaxMb) || input.memoryMaxMb < 512 || input.memoryMaxMb > 2048) {
    throw new Error("The attached service needs the exact staged account, home and executable.");
  }
  return input;
}

/** Lines shared by the agent unit and its probe unit, so the network the
 * enforcement probe tests is the network the agent gets. */
function sandbox(id: string, sid: string): string[] {
  return [
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    `NetworkNamespacePath=/run/netns/hivra-${sid}`,
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "TemporaryFileSystem=/var/lib/hivra:ro /etc/hivra:ro /var/log",
    `BindReadOnlyPaths=/etc/hivra/attachments/${id}`,
    `BindReadOnlyPaths=/etc/hivra/attachments/${id}/resolv.conf:/etc/resolv.conf`,
    "InaccessiblePaths=/run/dbus/system_bus_socket -/opt/hivra/remote-desktop",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "SystemCallArchitectures=native",
    "SystemCallFilter=@system-service",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "IPAddressAllow=localhost",
    "IPAddressDeny=link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 198.18.0.0/15 fc00::/7",
  ];
}

/**
 * Every unit and drop-in for one attachment, rendered from its approved
 * grants. Pure: writes nothing and grants no activation.
 */
export function buildAttachedServiceUnits(raw: AttachedServiceInput) {
  const input = checked(raw);
  const id = input.installationId;
  const hex = id.replaceAll("-", "");
  const sid = hex.slice(0, 12);
  const group = `hvc_${hex.slice(0, 24)}`;
  const name = `hivra-attached-${id}`;
  const view = `/var/lib/hivra/agent-views/${id}`;
  const install = `/opt/hivra/agent-installations/${id}`;
  const lines = (...values: string[]) => `${values.join("\n")}\n`;
  const units: Array<{ name: string; path: string; content: string }> = [
    { name: `${name}.socket`, path: `/etc/systemd/system/${name}.socket`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex chat socket ${id}`,
      "",
      "[Socket]",
      `ListenStream=/run/hivra-attached/${id}.sock`,
      "SocketUser=root",
      `SocketGroup=${group}`,
      "SocketMode=0660",
      "DirectoryMode=0711",
      "RemoveOnStop=yes",
      "Accept=no",
      `Service=${name}.service`,
      "",
      "[Install]",
      "WantedBy=sockets.target",
    ) },
    { name: `${name}.service`, path: `/etc/systemd/system/${name}.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex ${id}`,
      `Requires=${name}-workspace.service ${name}-network.service ${name}-dns.socket ${name}.socket`,
      `After=${name}-workspace.service ${name}-network.service ${name}-dns.socket ${name}.socket`,
      "StartLimitIntervalSec=300",
      "StartLimitBurst=5",
      "",
      "[Service]",
      "Type=simple",
      `User=${input.account}`,
      `Group=${input.account}`,
      `Sockets=${name}.socket`,
      `WorkingDirectory=${input.home}`,
      `Environment=HOME=${input.home}`,
      `Environment=CODEX_HOME=${input.home}/.codex`,
      `Environment=CODEX_BIN=${input.executable}`,
      "Environment=HIVRA_AGENT_KIND=codex",
      `Environment=HIVRA_ATTACHED_INSTALLATION_ID=${id}`,
      `Environment=HIVRA_AGENT_WORKDIR=${view}`,
      `Environment=HIVRA_API_TOKEN_FILE=/etc/hivra/attachments/${id}/instance-token`,
      `Environment=PATH=${install}:/usr/local/bin:/usr/bin:/bin`,
      `ExecStartPre=/usr/local/lib/hivra/attached-workspace verify ${id}`,
      `ExecStartPre=/usr/local/lib/hivra/attached-network verify ${id}`,
      "ExecStart=/usr/local/bin/node /opt/bux/hivra-chat/server.js",
      "UMask=0077",
      "Restart=on-failure",
      "RestartSec=5",
      "KillMode=control-group",
      "TimeoutStopSec=15",
      ...sandbox(id, sid),
      `BindPaths=${input.home}`,
      `BindReadOnlyPaths=${view}:${view}:norbind`,
      ...(input.grants.workspace ? [`BindPaths=${view}/Hivra:${view}/Hivra:norbind`] : []),
      `ReadWritePaths=${input.home}`,
      `MemoryMax=${input.memoryMaxMb}M`,
      "CPUWeight=50",
      "IOWeight=50",
      "TasksMax=512",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ) },
    { name: `${name}-probe.service`, path: `/etc/systemd/system/${name}-probe.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex network enforcement probe ${id}`,
      `Requires=${name}-network.service ${name}-dns.socket`,
      `After=${name}-network.service ${name}-dns.socket`,
      "",
      "[Service]",
      "Type=oneshot",
      `User=${input.account}`,
      `Group=${input.account}`,
      `ExecStart=/usr/local/lib/hivra/attached-network probe ${id}`,
      "TimeoutStartSec=60",
      ...sandbox(id, sid),
    ) },
    { name: `${name}-workspace.service`, path: `/etc/systemd/system/${name}-workspace.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex workspace view ${id}`,
      "After=local-fs.target",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      `ExecStart=/usr/local/lib/hivra/attached-workspace mount ${id}`,
      `ExecStop=/usr/local/lib/hivra/attached-workspace unmount ${id}`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ) },
    { name: `${name}-network.service`, path: `/etc/systemd/system/${name}-network.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex network ${id}`,
      "Wants=network-online.target",
      "After=network-online.target docker.service",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      `ExecStart=/usr/local/lib/hivra/attached-network up ${id}`,
      `ExecStop=/usr/local/lib/hivra/attached-network down ${id}`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ) },
    { name: `${name}-dns.socket`, path: `/etc/systemd/system/${name}-dns.socket`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex DNS ${id}`,
      `Requires=${name}-network.service`,
      `After=${name}-network.service`,
      "",
      "[Socket]",
      `NetworkNamespacePath=/run/netns/hivra-${sid}`,
      "ListenDatagram=127.0.0.53:53",
      "ListenStream=127.0.0.53:53",
      "FreeBind=yes",
      "IPAddressDeny=any",
      "IPAddressAllow=127.0.0.0/8",
      `Service=${name}-dns.service`,
      "",
      "[Install]",
      "WantedBy=sockets.target",
    ) },
    { name: `${name}-dns.service`, path: `/etc/systemd/system/${name}-dns.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex DNS relay ${id}`,
      `Requires=${name}-dns.socket`,
      `After=${name}-dns.socket`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStartPre=+/usr/local/lib/hivra/attached-network relay-guard ${id}`,
      "ExecStart=/usr/local/lib/hivra/attached-dns-relay",
      `ExecStopPost=+/usr/local/lib/hivra/attached-network relay-unguard ${id}`,
      "DynamicUser=yes",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "PrivateDevices=yes",
      "PrivateIPC=yes",
      "ProtectProc=invisible",
      "ProcSubset=pid",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "ProtectControlGroups=yes",
      "ProtectClock=yes",
      "ProtectHostname=yes",
      "RestrictSUIDSGID=yes",
      "RestrictNamespaces=yes",
      "RestrictRealtime=yes",
      "LockPersonality=yes",
      "SystemCallArchitectures=native",
      "SystemCallFilter=@system-service",
      "RestrictAddressFamilies=AF_INET",
      "IPAddressDeny=any",
      "IPAddressAllow=127.0.0.53/32",
      "MemoryMax=64M",
      "TasksMax=32",
    ) },
    { name: `${name}-watchdog.service`, path: `/etc/systemd/system/${name}-watchdog.service`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex protection watchdog ${id}`,
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=/usr/local/lib/hivra/attached-network watchdog ${id}`,
    ) },
    { name: `${name}-watchdog.timer`, path: `/etc/systemd/system/${name}-watchdog.timer`, content: lines(
      "[Unit]",
      `Description=Hivra attached Codex protection watchdog ${id}`,
      "",
      "[Timer]",
      "OnBootSec=90",
      "OnUnitActiveSec=60",
      "AccuracySec=10",
      "",
      "[Install]",
      "WantedBy=timers.target",
    ) },
    { name: `bux-hivra-chat.service.d/${name}.conf`, path: `/etc/systemd/system/bux-hivra-chat.service.d/${name}.conf`, content: lines(
      "[Service]",
      `SupplementaryGroups=${group}`,
    ) },
  ];
  const files: AttachedUnitFile[] = units.map((unit) => ({ ...unit, sha256: sha256(unit.content) }));
  const definition = JSON.stringify({ version: ATTACHED_POLICY_VERSION, installationId: id, grants: { workspace: input.grants.workspace },
    memoryMaxMb: input.memoryMaxMb, units: files.map((file) => [file.path, file.sha256]),
    helpers: ATTACHED_HELPERS.map((helper) => [helper.path, helper.sha256]) });
  return {
    units: files,
    group,
    socketPath: `/run/hivra-attached/${id}.sock`,
    agentUnit: `${name}.service`,
    sha256: sha256(definition),
  };
}
export type AttachedServiceDefinition = ReturnType<typeof buildAttachedServiceUnits>;
