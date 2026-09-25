/** @jest-environment node */

// Payload budgets: every shipped payload that crosses a host or guest
// transport, built for real and measured against that transport's limit.
//
// PR #143 fixed a ~150 KB attach bundle that sat inside one host argument,
// over Linux's 131,071-byte limit. No test compared a real payload with its
// transport's limit. Here each payload must stay within budgetFraction (75%) of its
// limit, and its exact size is recorded in transport-payload-budgets.json so
// any growth shows up in review. host-transport-size-limits.test.ts proves the
// limits in that file are the transports' real behaviour.
//
// After changing a payload on purpose, refresh the numbers and commit them:
//   UPDATE_TRANSPORT_BUDGETS=1 npx jest src/lib/services/__tests__/transport-payload-budgets.test.ts

jest.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { attachedAccessPacket, attachedActivatePacket, attachedObservePacket, attachedRemovePacket,
  attachedStatePacket } from "@/lib/agent-computers/attached-agent-packet";
import { buildAttachedAgentHostScript, type AttachedAgentAction } from "@/lib/agent-computers/attached-agent-host";
import { buildAttachmentHostActionScript, type AttachmentGuestAction } from "@/lib/agent-computers/attachment-host-action";
import { buildAttachmentHostObservationScript, HOST_ARGUMENT_MAX_BYTES } from "@/lib/agent-computers/attachment-host-observation";
import { buildBankrSkillsGuestScript, buildBankrSkillsHostScript, collectBankrSkillFiles } from "@/lib/hivra/bankr-skills-seed";
import { buildProviderAgentSeedScript } from "@/lib/hivra/provider-agent-seed";
import { buildHivraTailscaleConnectProgram, connectHivraTailscale, DEFAULT_TAILSCALE_LOGIN_SERVER,
  type HivraPrivateAccessAgentRow } from "@/lib/hivra/tailscale-private-access";
import { MAX_USER_DATA_BYTES, renderFirstBootCloudInit } from "@/lib/infrastructure/first-boot-cloud-init";
import { createFirstBootChallenge, FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { MAX_PROVIDER_GUEST_SEED_BYTES } from "@/lib/infrastructure/first-boot-ssh";
import { buildRemoteDesktopCapabilityInspectionScript } from "@/lib/remote-computers/capability-inspection";
import { DESKTOP_PREPARE_GUEST_PROGRAM } from "@/lib/remote-computers/desktop-prepare-guest";
import { DESKTOP_PREPARE_GUEST_OBSERVER } from "@/lib/remote-computers/desktop-prepare-recovery";
import { buildRemoteDesktopGuestInstallScript } from "@/lib/remote-computers/guest-installation";
import { buildPreparedOmarchyNativeCapabilityInspectionScript } from "@/lib/remote-computers/omarchy-native-capability";
import { buildOmarchyNativePreparationHostScript,
  loadOmarchyNativeGuardianBundle } from "@/lib/remote-computers/omarchy-native-preparation-host";
import { buildPreparedWindowsRdpCapabilityInspectionScript } from "@/lib/remote-computers/windows-rdp-capability";
import { buildWindowsRdpPreparationHostScript } from "@/lib/remote-computers/windows-rdp-preparation-host";
import { MAX_SUDO_TRANSPORT_SCRIPT_BYTES } from "../proxmox-sudo-transport";
import { byteLength, hostStepArgument, readTransportBudgets, shellWordsFrom, writeTransportBudgets,
  type RecordedMeasure, type TransportLimitId } from "./host-transport.fixtures";

type Measured = Record<string, Record<string, { limit: TransportLimitId; bytes: number; compressed: boolean }>>;
/** gzip output differs by zlib build (macOS and Linux Node differ), so a
 * compressed payload may move this much from its recorded size. */
const COMPRESSED_TOLERANCE = 0.01;

const TARGET = {
  operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
  bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64" as const,
};
const INSTALLATION = "44444444-4444-4444-8444-444444444444";
const BOOT = "55555555-5555-4555-8555-555555555555";
const ACTIVATION = "66666666-6666-4666-8666-666666666666";
const TOKEN = "a".repeat(64);
const BINDING_TAG = "hivra-bind-" + "9".repeat(32);

/** The guest program argument of an attach step, read out of its step body. */
const stepGuestProgram = (script: string) =>
  shellWordsFrom(hostStepArgument(script), "dispatch_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ")[5];
/** What Windows gets as one command line from `qm guest exec … powershell.exe …`. */
const windowsCommandLine = (script: string, command: string) => shellWordsFrom(script, command).slice(1).join(" ");

/** The attach steps' packets, built as attachment-worker builds them. */
function attachedPackets(): Record<AttachedAgentAction, Record<string, unknown>> {
  const input = {
    operationId: TARGET.operationId, installationId: INSTALLATION, bootId: BOOT, uid: 61001, gid: 61001, agentName: "Codex",
    computer: { name: "MY_UBUNTU_DESKTOP", cpu: 2, ramGb: 4, deploymentMode: "hivra-managed", deployment_mode: "hivra-managed",
      computer_substrate: "proxmox-kvm" },
    grants: { workspace: true }, contractRevision: 1,
  };
  return {
    activate: attachedActivatePacket({ ...input, activationId: ACTIVATION, instanceToken: TOKEN, hostAddresses: ["203.0.113.7"] }).packet,
    access: attachedAccessPacket({ ...input, contractRevision: 2, instanceToken: TOKEN, previousGrants: { workspace: false } }).packet,
    remove: attachedRemovePacket(input).packet,
    state: attachedStatePacket({ ...input, instanceToken: TOKEN }).packet,
    observe: attachedObservePacket({ operationId: input.operationId, activationId: ACTIVATION, installationId: INSTALLATION,
      bootId: BOOT, serviceDefinitionSha256: "d".repeat(64), instanceToken: TOKEN }).packet,
  };
}

async function measureShippedPayloads(): Promise<Measured> {
  const measured: Measured = {};
  const put = (payload: string, measure: string, limit: TransportLimitId, value: string, compressed = false) => {
    (measured[payload] ??= {})[measure] = { limit, bytes: byteLength(value), compressed };
  };

  // Attach steps after staging: runProxmoxHostScriptWithStdin, then a guest
  // program handed to the VM's guest agent with the bundle as its stdin.
  for (const [action, packet] of Object.entries(attachedPackets()) as Array<[AttachedAgentAction, Record<string, unknown>]>) {
    const step = buildAttachedAgentHostScript(action, TARGET, packet);
    put(`attached-agent/${action}`, "script", "host-script-with-stdin.script", step.script);
    put(`attached-agent/${action}`, "stepArgument", "linux-argument", hostStepArgument(step.script));
    put(`attached-agent/${action}`, "guestProgram", "linux-argument", stepGuestProgram(step.script));
    put(`attached-agent/${action}`, "stdin", "guest-exec-stdin", step.stdin);
  }
  // Staging (fetch, stage, observe): the same transport with the codex bundle.
  const expected = { identity: { operationId: TARGET.operationId, dispatchId: "77777777-7777-4777-8777-777777777777",
    installationId: INSTALLATION, bindingId: "88888888-8888-4888-8888-888888888888", computerId: TARGET.computerId,
    sourceId: TARGET.sourceId, architecture: TARGET.architecture }, bootId: BOOT };
  for (const action of ["fetch", "stage", "observe"] as AttachmentGuestAction[]) {
    const step = buildAttachmentHostActionScript(action, TARGET, expected);
    put(`attachment-staging/${action}`, "script", "host-script-with-stdin.script", step.script);
    put(`attachment-staging/${action}`, "stepArgument", "linux-argument", hostStepArgument(step.script));
    put(`attachment-staging/${action}`, "guestProgram", "linux-argument", stepGuestProgram(step.script));
    put(`attachment-staging/${action}`, "stdin", "guest-exec-stdin", step.stdin);
  }
  // The read-only observation: runProxmoxHostScript (bash -s).
  const observation = buildAttachmentHostObservationScript(TARGET);
  put("attachment-observation", "script", "sudo-transport-script", observation);
  put("attachment-observation", "stepArgument", "linux-argument", hostStepArgument(observation));
  put("attachment-observation", "guestProgram", "linux-argument",
    shellWordsFrom(hostStepArgument(observation), "run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c ")[5]);

  // Ubuntu Desktop install: each runtime source file goes to the guest as one
  // base64 argument, and the prepare program as one argument to python3.
  const install = buildRemoteDesktopGuestInstallScript({ vmid: TARGET.vmid, guestIp: TARGET.guestIp, operationId: TARGET.operationId,
    provisionerDirectory: "/opt/hivra/provisioner", infrastructureBindingTag: BINDING_TAG, computerId: TARGET.computerId,
    controlOrigin: "https://control.example.test", publicOrigin: "https://desk.example.test" });
  put("remote-desktop-install", "script", "sudo-transport-script", install);
  for (const file of ["broker.cjs", "install-guest.py", "server.cjs"]) {
    expect(install).toContain(`transfer_guest_source ${file} `);
    const source = readFileSync(path.join(process.cwd(), "provisioner", "remote-desktop", file));
    put("remote-desktop-install", `${file} argument`, "linux-argument", source.toString("base64"));
  }
  put("remote-desktop-install", "prepareProgram", "linux-argument", DESKTOP_PREPARE_GUEST_PROGRAM);
  put("remote-desktop-prepare-recovery", "guestProgram", "linux-argument", DESKTOP_PREPARE_GUEST_OBSERVER);

  // Capability inspections: the guest program travels base64 as one argument.
  const inspection = buildRemoteDesktopCapabilityInspectionScript({ vmid: TARGET.vmid, guestIp: TARGET.guestIp,
    infrastructureBindingTag: BINDING_TAG });
  put("remote-desktop-capability", "script", "sudo-transport-script", inspection);
  put("remote-desktop-capability", "guestArgument", "linux-argument", shellWordsFrom(inspection,
    "run_vmid_bound_guest_exec /bin/bash -c 'printf \"%s\" \"$1\" | /usr/bin/base64 --decode | /usr/bin/python3 -I -B -' hivra ")[5]);
  const omarchyInspection = buildPreparedOmarchyNativeCapabilityInspectionScript({ computerId: TARGET.computerId, vmid: TARGET.vmid,
    guestIp: TARGET.guestIp, publicIpv4: "198.51.100.11", infrastructureBindingTag: BINDING_TAG });
  put("omarchy-capability", "script", "sudo-transport-script", omarchyInspection);
  put("omarchy-capability", "guestArgument", "linux-argument", shellWordsFrom(omarchyInspection,
    "run_vmid_bound_guest_exec /bin/bash -c 'printf \"%s\" \"$1\" | /usr/bin/base64 --decode | /usr/bin/python3 -I -B - \"$2\"' hivra ")[5]);

  // Omarchy preparation: the guardian bundle on the guest agent's stdin.
  const omarchy = buildOmarchyNativePreparationHostScript({ computerId: TARGET.computerId, operationId: TARGET.operationId,
    vmid: TARGET.vmid, guestPrivateIpv4: TARGET.guestIp }, BINDING_TAG, await loadOmarchyNativeGuardianBundle());
  put("omarchy-preparation", "script", "sudo-transport-script", omarchy);
  put("omarchy-preparation", "stdin", "guest-exec-stdin", shellWordsFrom(omarchy, "printf '%s' '{\"request\":")[2]);
  put("omarchy-preparation", "guestProgram", "linux-argument",
    shellWordsFrom(omarchy, "run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -S -c ")[6]);

  // Windows: the program is a PowerShell -EncodedCommand argument inside one
  // Windows command line.
  const windowsPreparation = buildWindowsRdpPreparationHostScript({ computerId: TARGET.computerId, operationId: TARGET.operationId,
    vmid: TARGET.vmid, guestPrivateIpv4: TARGET.guestIp, gatewaySourceCidrs: ["10.241.0.1/32"] }, BINDING_TAG);
  put("windows-rdp-preparation", "script", "sudo-transport-script", windowsPreparation);
  put("windows-rdp-preparation", "commandLine", "windows-command-line",
    windowsCommandLine(windowsPreparation, "run_vmid_bound_guest_exec powershell.exe "));
  const windowsInspection = buildPreparedWindowsRdpCapabilityInspectionScript({ computerId: TARGET.computerId, vmid: TARGET.vmid,
    guestIp: TARGET.guestIp, infrastructureBindingTag: BINDING_TAG });
  put("windows-rdp-capability", "script", "sudo-transport-script", windowsInspection);
  put("windows-rdp-capability", "stdin", "guest-exec-stdin",
    shellWordsFrom(windowsInspection, "HIVRA_WINDOWS_INSPECTION_PHASE=guest_exec\nprintf '%s' ")[2]);
  put("windows-rdp-capability", "commandLine", "windows-command-line",
    windowsCommandLine(windowsInspection, "run_vmid_bound_guest_exec_stdin powershell.exe "));

  // Private network: the connect program crosses host SSH to the guest as one
  // login command.
  const withStdin = jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "measured" });
  const agent: HivraPrivateAccessAgentRow = { id: TARGET.sourceId, user_id: "owner", type: "linux-desktop",
    computer_profile: "ubuntu-desktop", status: "running", desired_state: "running", operation_id: null, operation_kind: null,
    vmid: TARGET.vmid, ip: TARGET.guestIp, computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    proxmox_host: "node-b", infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true,
    managed_provisioner_channel: "canary" };
  await connectHivraTailscale(agent, "fixture-auth-key", DEFAULT_TAILSCALE_LOGIN_SERVER, {
    resolveContext: jest.fn().mockResolvedValue({ kind: "managed", host: "node-b", env: {}, provisionerChannel: "canary",
      infrastructureBindingTag: BINDING_TAG, infrastructureBindingTagEnforced: true,
      paths: { provisionerDirectory: "/opt/hivra/provisioner", logDirectory: "/var/log", provisionLogPrefix: "hivra-prov-",
        startLogPrefix: "hivra-start-", storage: "local-lvm", vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" } }),
    runHostScript: jest.fn().mockResolvedValue({ ok: true, stdout: 'HIVRA_TAILSCALE_STATUS {"BackendState":"NeedsLogin"}\n', stderr: "" }),
    runHostScriptWithStdin: withStdin,
  } as never).catch(() => undefined);
  const tailscale = String(withStdin.mock.calls[0]?.[0] ?? "");
  expect(tailscale).toContain(Buffer.from(buildHivraTailscaleConnectProgram(DEFAULT_TAILSCALE_LOGIN_SERVER)).toString("base64"));
  put("tailscale-connect", "script", "host-script-with-stdin.script", tailscale);
  put("tailscale-connect", "guestLoginCommand", "linux-argument",
    shellWordsFrom(tailscale, "\"${GUEST_SSH[@]}\" 'sudo -n /usr/bin/python3 -c ")[1]);

  // The curated Bankr skill suite: a host script (sudo transport on a user's
  // own server) on Proxmox, and one gzip part of the provider-VM guest seed.
  const skills = collectBankrSkillFiles();
  expect(skills.length).toBeGreaterThan(0);
  const bankrGuest = buildBankrSkillsGuestScript(".agents/skills", skills);
  put("bankr-skills", "proxmoxHostScript", "sudo-transport-script", buildBankrSkillsHostScript(TARGET.guestIp, bankrGuest));
  put("bankr-skills", "providerSeedScript", "provider-guest-seed",
    buildProviderAgentSeedScript([{ part: "bankr-skills", script: bankrGuest }]), true);

  // A provider server's first-boot user_data.
  const now = new Date("2026-09-25T12:00:00.000Z");
  const binding = { userId: "fixture_owner", connectionId: "11111111-1111-4111-8111-111111111111", connectionRevision: 2,
    orderId: "22222222-2222-4222-8222-222222222222", attemptId: "33333333-3333-4333-8333-333333333333",
    quoteFingerprint: "a".repeat(64), recipeVersion: FIRST_BOOT_RECIPE_VERSION };
  const publicKey = "ssh-ed25519 " + Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
    Buffer.alloc(32, 1)]).toString("base64");
  put("first-boot", "userData", "cloud-init-user-data", await renderFirstBootCloudInit({ ...createFirstBootChallenge(binding, now),
    currentBinding: binding, publicKeyOpenSsh: publicKey + " hivra-capacity", callbackOrigin: "https://hivra.example", now }));
  return measured;
}

const percentOf = (bytes: number, cap: number) => Math.round((bytes / cap) * 1000) / 10;

describe("transport payload budgets", () => {
  const budgets = readTransportBudgets();
  let measured: Measured;
  beforeAll(async () => { measured = await measureShippedPayloads(); });

  it("names each limit as its transport enforces it", () => {
    const limits = Object.fromEntries(Object.entries(budgets.limits).map(([id, limit]) => [id, limit.bytes]));
    expect(limits).toEqual({
      // One argument to exec, counting its NUL (MAX_ARG_STRLEN, 32 pages).
      "linux-argument": HOST_ARGUMENT_MAX_BYTES,
      // The largest script whose base64 login command is one argument; proven
      // in host-transport-size-limits.test.ts.
      "host-script-with-stdin.script": 98_259,
      "host-script-with-stdin.stdin": 1024 * 1024,
      // Proxmox's `qm guest exec --pass-stdin` forwards at most 1 MiB.
      "guest-exec-stdin": 1024 * 1024,
      "sudo-transport-script": MAX_SUDO_TRANSPORT_SCRIPT_BYTES,
      "provider-guest-seed": MAX_PROVIDER_GUEST_SEED_BYTES,
      // CreateProcess takes 32,767 characters including the terminating NUL.
      "windows-command-line": 32_767 - 1,
      // Hetzner Cloud's user_data limit: renderFirstBootCloudInit's own check.
      "cloud-init-user-data": MAX_USER_DATA_BYTES,
    });
    expect(MAX_USER_DATA_BYTES).toBe(32 * 1024);
    // A step's stdin crosses the host transport and then the guest agent.
    expect(limits["host-script-with-stdin.stdin"]).toBeGreaterThanOrEqual(limits["guest-exec-stdin"]);
  });

  it("keeps every shipped payload within its budget, with its size recorded for review", () => {
    if (process.env.UPDATE_TRANSPORT_BUDGETS === "1") {
      const payloads: Record<string, Record<string, RecordedMeasure>> = {};
      for (const [payload, measures] of Object.entries(measured).sort(([a], [b]) => a.localeCompare(b))) {
        payloads[payload] = Object.fromEntries(Object.entries(measures).map(([name, { limit, bytes }]) =>
          [name, { bytes, limit, percent: percentOf(bytes, budgets.limits[limit].bytes) }]));
      }
      writeTransportBudgets({ ...budgets, payloads });
      budgets.payloads = payloads;
    }
    const problems: string[] = [];
    const recordedNames = Object.entries(budgets.payloads).flatMap(([payload, measures]) =>
      Object.keys(measures).map(name => `${payload} ${name}`));
    const measuredNames = Object.entries(measured).flatMap(([payload, measures]) =>
      Object.keys(measures).map(name => `${payload} ${name}`));
    for (const name of recordedNames) if (!measuredNames.includes(name)) problems.push(`${name}: recorded but no longer measured`);
    for (const [payload, measures] of Object.entries(measured)) {
      for (const [name, { limit, bytes, compressed }] of Object.entries(measures)) {
        const id = `${payload} ${name}`;
        const cap = budgets.limits[limit].bytes;
        const recorded = budgets.payloads[payload]?.[name];
        if (!recorded) problems.push(`${id}: ${bytes} bytes, not recorded`);
        else if (Math.abs(recorded.bytes - bytes) > (compressed ? Math.ceil(recorded.bytes * COMPRESSED_TOLERANCE) : 0)
          || recorded.limit !== limit || recorded.percent !== percentOf(recorded.bytes, cap)) {
          problems.push(`${id}: recorded ${recorded.bytes} bytes against ${recorded.limit}, now ${bytes} against ${limit}`);
        }
        if (bytes > cap) problems.push(`${id}: ${bytes} bytes is over the ${limit} limit of ${cap}`);
        else if (bytes > budgets.budgetFraction * cap && !budgets.overBudget[id]) {
          problems.push(`${id}: ${bytes} bytes is ${percentOf(bytes, cap)}% of ${limit}, over the ${budgets.budgetFraction * 100}% budget`);
        } else if (bytes <= budgets.budgetFraction * cap && budgets.overBudget[id]) {
          problems.push(`${id}: back within budget, remove it from overBudget`);
        }
      }
    }
    for (const id of Object.keys(budgets.overBudget)) {
      if (!measuredNames.includes(id)) problems.push(`${id}: listed in overBudget but not measured`);
    }
    if (problems.length > 0 && process.env.UPDATE_TRANSPORT_BUDGETS !== "1") {
      problems.push("After an intended change: UPDATE_TRANSPORT_BUDGETS=1 npx jest "
        + "src/lib/services/__tests__/transport-payload-budgets.test.ts, then commit transport-payload-budgets.json");
    }
    expect(problems).toEqual([]);
  });
});
