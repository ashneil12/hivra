import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTACHED_HELPERS, ATTACHED_POLICY_VERSION, attachedMemoryMaxMb, buildAttachedServiceUnits } from "../attachment-service-units";
import { ATTACH_GRANT_POLICY_SHA256, ATTACHED_SERVICE_POLICY_V2_SHA256 } from "../attach-review";
import { ATTACHED_AGENT_PROGRAM_SHA256 } from "../attached-agent-host";

// The attached agent's systemd units (design 5.3, 5.4; threats T5, T7, T9, T21,
// T22, T31). Every path root creates or binds is a root-owned location; the
// ~/Hivra view is bound only with the grant; there is no DISPLAY, browser or
// sudo in this release; and the policy digest is the SHA-256 of this module.

const INSTALLATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = {
  installationId: INSTALLATION,
  account: "hva_" + INSTALLATION.replaceAll("-", "").slice(0, 24),
  uid: 65010, gid: 65010,
  home: `/var/lib/hivra/agent-homes/${INSTALLATION}`,
  executable: `/opt/hivra/agent-installations/${INSTALLATION}/codex`,
  grants: { workspace: true },
  memoryMaxMb: 2048,
};
const byName = (units: ReturnType<typeof buildAttachedServiceUnits>["units"], name: string) => units.find((u) => u.name === name)!;

it("renders the agent unit inside its own network namespace with no browser, desktop or sudo", () => {
  const { units, agentUnit } = buildAttachedServiceUnits(base);
  const agent = byName(units, agentUnit).content;
  expect(agent).toContain(`User=${base.account}\nGroup=${base.account}\n`);
  expect(agent).toContain(`NetworkNamespacePath=/run/netns/hivra-${INSTALLATION.replaceAll("-", "").slice(0, 12)}`);
  expect(agent).toContain("NoNewPrivileges=yes");
  expect(agent).toContain("CapabilityBoundingSet=\nAmbientCapabilities=\n");
  expect(agent).toContain("ProtectHome=yes");
  expect(agent).toContain("ExecStart=/usr/local/bin/node /opt/bux/hivra-chat/server.js");
  expect(agent).toContain(`Environment=HIVRA_ATTACHED_INSTALLATION_ID=${INSTALLATION}`);
  expect(agent).toContain("MemoryMax=2048M");
  expect(agent).toContain("CPUWeight=50");
  expect(agent).toContain("TasksMax=512");
  // No DISPLAY, no CDP, no sudo, no app-server socket in this release.
  expect(agent).not.toMatch(/DISPLAY|CDP|9222|sudo|app-server|ttyd/);
  // ProtectHome hides /home; only the agent's own home and its read-only
  // starting folder are bound back in.
  expect(agent).toContain(`BindPaths=${base.home}`);
  expect(agent).toContain(`BindReadOnlyPaths=/var/lib/hivra/agent-views/${INSTALLATION}:/var/lib/hivra/agent-views/${INSTALLATION}:norbind`);
});

it("binds the ~/Hivra view and grants ReadWritePaths only when the workspace grant is on (T31)", () => {
  const on = byName(buildAttachedServiceUnits(base).units, base.account && `hivra-attached-${INSTALLATION}.service`).content;
  const view = `/var/lib/hivra/agent-views/${INSTALLATION}/Hivra`;
  expect(on).toContain(`BindPaths=${view}:${view}:norbind`);
  const off = byName(buildAttachedServiceUnits({ ...base, grants: { workspace: false } }).units, `hivra-attached-${INSTALLATION}.service`).content;
  expect(off).not.toContain(`${view}:${view}`);
  // Every bind destination is under a root-owned location, never the agent's home path directly.
  for (const line of on.split("\n").filter((l) => l.startsWith("BindPaths=") || l.startsWith("BindReadOnlyPaths="))) {
    const dest = line.split("=")[1].split(":")[1] ?? line.split("=")[1];
    expect(dest.startsWith("/var/lib/hivra/") || dest.startsWith("/etc/hivra/") || dest === "/etc/resolv.conf").toBe(true);
  }
});

it("gives the chat socket to the gateway group only, in a root-owned runtime folder (T15)", () => {
  const { units, group } = buildAttachedServiceUnits(base);
  const socket = byName(units, `hivra-attached-${INSTALLATION}.socket`).content;
  expect(group).toMatch(/^hvc_[0-9a-f]{24}$/);
  expect(socket).toContain(`ListenStream=/run/hivra-attached/${INSTALLATION}.sock`);
  expect(socket).toContain("SocketUser=root");
  expect(socket).toContain(`SocketGroup=${group}`);
  expect(socket).toContain("SocketMode=0660");
  expect(socket).toContain("DirectoryMode=0711");
  const dropin = byName(units, `bux-hivra-chat.service.d/hivra-attached-${INSTALLATION}.conf`).content;
  expect(dropin).toContain(`SupplementaryGroups=${group}`);
});

it("binds the DNS relay to 127.0.0.53 only, inside the agent's namespace, with its own IP filters (T36)", () => {
  const { units } = buildAttachedServiceUnits(base);
  const socket = byName(units, `hivra-attached-${INSTALLATION}-dns.socket`).content;
  expect(socket).toContain("ListenDatagram=127.0.0.53:53");
  expect(socket).toContain("ListenStream=127.0.0.53:53");
  expect(socket).toContain("IPAddressDeny=any");
  expect(socket).toContain("IPAddressAllow=127.0.0.0/8");
  expect(socket).toContain(`NetworkNamespacePath=/run/netns/hivra-${INSTALLATION.replaceAll("-", "").slice(0, 12)}`);
  const service = byName(units, `hivra-attached-${INSTALLATION}-dns.service`).content;
  expect(service).toContain("IPAddressDeny=any");
  expect(service).toContain("IPAddressAllow=127.0.0.53/32");
  expect(service).toContain("RestrictAddressFamilies=AF_INET");
  expect(service).toContain("DynamicUser=yes");
});

it("requires the workspace and network units before the agent, and runs the enforcement probe in a matching sandbox (T24)", () => {
  const { units } = buildAttachedServiceUnits(base);
  const agent = byName(units, `hivra-attached-${INSTALLATION}.service`).content;
  expect(agent).toContain(`Requires=hivra-attached-${INSTALLATION}-workspace.service hivra-attached-${INSTALLATION}-network.service hivra-attached-${INSTALLATION}-dns.socket hivra-attached-${INSTALLATION}.socket`);
  expect(agent).toContain(`ExecStartPre=/usr/local/lib/hivra/attached-workspace verify ${INSTALLATION}`);
  expect(agent).toContain(`ExecStartPre=/usr/local/lib/hivra/attached-network verify ${INSTALLATION}`);
  const probe = byName(units, `hivra-attached-${INSTALLATION}-probe.service`).content;
  // The probe runs as the agent in the same namespace and IP filter as the agent.
  expect(probe).toContain(`User=${base.account}`);
  expect(probe).toContain(`NetworkNamespacePath=/run/netns/hivra-${INSTALLATION.replaceAll("-", "").slice(0, 12)}`);
  expect(probe).toContain(`ExecStart=/usr/local/lib/hivra/attached-network probe ${INSTALLATION}`);
  const timer = byName(units, `hivra-attached-${INSTALLATION}-watchdog.timer`).content;
  expect(timer).toContain("OnUnitActiveSec=60");
});

it("caps memory at the smaller of 2 GB and half the computer's memory (T22)", () => {
  expect(attachedMemoryMaxMb(4)).toBe(2048);
  expect(attachedMemoryMaxMb(3)).toBe(1536);
  expect(attachedMemoryMaxMb(1)).toBe(512);
  expect(attachedMemoryMaxMb(64)).toBe(2048);
});

it("pins the helper digests to the reviewed files, and the policy digest to this module (T21)", () => {
  for (const helper of ATTACHED_HELPERS) {
    const bytes = readFileSync(path.join(process.cwd(), "provisioner", helper.file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(helper.sha256);
  }
  const definition = buildAttachedServiceUnits(base);
  // The rendered set changes its digest when grants change (T20/T21).
  const off = buildAttachedServiceUnits({ ...base, grants: { workspace: false } });
  expect(definition.sha256).not.toBe(off.sha256);
  expect(ATTACHED_POLICY_VERSION).toBe(2);
});

it("refuses a mismatched staged account, home or executable", () => {
  for (const bad of [{ account: "root" }, { home: "/root" }, { executable: "/bin/sh" }, { uid: 0 }, { gid: 0 },
    { grants: { workspace: true, desktop: true } as unknown as { workspace: boolean } }, { memoryMaxMb: 4096 }]) {
    expect(() => buildAttachedServiceUnits({ ...base, ...bad })).toThrow();
  }
});

// The guest renders the same units from the approved grants and refuses an
// activation whose digest differs, so the two renderings must stay byte-equal.
function pythonRendering(input: typeof base) {
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("agent", sys.argv[1]); agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
i = json.loads(sys.argv[2])
units, group, sid = agent.render_units(i["installationId"], i["account"], i["home"], i["executable"], i["grants"]["workspace"], i["memoryMaxMb"])
helpers = {k: v for k, v in i["helpers"].items()}
print(json.dumps({"units": [[name, path, content] for name, path, content in units], "group": group,
  "sha256": agent.definition_sha256(i["installationId"], i["grants"]["workspace"], i["memoryMaxMb"], units, helpers)}))
`;
  const helpers = Object.fromEntries(ATTACHED_HELPERS.map((helper) => [
    helper.file === "attached-workspace.py" ? "workspace" : helper.file === "attached-network.py" ? "network" : "relay", helper.sha256]));
  const out = execFileSync("python3", ["-I", "-c", program, path.join(process.cwd(), "provisioner", "attached-agent.py"),
    JSON.stringify({ ...input, helpers })], { encoding: "utf8" });
  return JSON.parse(out) as { units: [string, string, string][]; group: string; sha256: string };
}

it.each([{ workspace: true }, { workspace: false }])("renders byte-equal units in TypeScript and in the guest program (grants %j)", (grants) => {
  const ts = buildAttachedServiceUnits({ ...base, grants, memoryMaxMb: 1536 });
  const py = pythonRendering({ ...base, grants, memoryMaxMb: 1536 });
  expect(py.units.map(([name, unitPath, content]) => ({ name, path: unitPath, content })))
    .toEqual(ts.units.map(({ name, path: unitPath, content }) => ({ name, path: unitPath, content })));
  expect(py.group).toBe(ts.group);
  expect(py.sha256).toBe(ts.sha256);
});

it("pins the service policy the database accepts to this renderer's bytes, and the program to the guest file", () => {
  const renderer = readFileSync(path.join(process.cwd(), "src/lib/agent-computers/attachment-service-units.ts"));
  expect(createHash("sha256").update(renderer).digest("hex")).toBe(ATTACHED_SERVICE_POLICY_V2_SHA256);
  const program = readFileSync(path.join(process.cwd(), "provisioner/attached-agent.py"));
  expect(createHash("sha256").update(program).digest("hex")).toBe(ATTACHED_AGENT_PROGRAM_SHA256);
  const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20260925100200_hivra_agent_attachment_lifecycle.sql"), "utf8");
  expect(migration).toContain(`p_service_policy_sha256 is distinct from '${ATTACHED_SERVICE_POLICY_V2_SHA256}'`);
  expect(migration).toContain(`p_program_sha256 is distinct from '${ATTACHED_AGENT_PROGRAM_SHA256}'`);
  expect(migration).toContain(`p_intent->>'grantPolicySha256' is distinct from '${ATTACH_GRANT_POLICY_SHA256}'`);
});

it("hides the computer's other local sockets and keeps an out-of-memory kill inside one process (T6, T22)", () => {
  const agent = byName(buildAttachedServiceUnits(base).units, `hivra-attached-${INSTALLATION}.service`).content;
  const hidden = agent.split("\n").find((line) => line.startsWith("InaccessiblePaths="))!;
  for (const socketPath of ["/run/dbus/system_bus_socket", "-/run/snapd.socket", "-/run/acpid.socket", "-/run/dhcpcd", "-/run/uuidd",
    "-/run/systemd/resolve/io.systemd.Resolve", "-/run/systemd/io.systemd.ManagedOOM", "-/run/systemd/io.system.ManagedOOM",
    "-/run/systemd/private", "-/opt/hivra/remote-desktop"]) {
    expect(hidden.split("=")[1].split(" ")).toContain(socketPath);
  }
  // resolved's folder stays: /etc/resolv.conf links into it, and the unit binds its own resolver over that file.
  expect(hidden).not.toMatch(/ -\/run\/systemd\/resolve( |$)/);
  expect(agent).toContain("OOMPolicy=continue");
});
