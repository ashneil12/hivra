/** @jest-environment node */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubGuestVm,
  type StubProxmoxGuestHost,
  type StubRunResult,
} from "@/test-utils/stub-proxmox-guest-host";

import { buildProxmoxProvisionScript } from "../proxmox/script-builders";

/**
 * A fresh Hermes provision's Phase 2 streams the deploy script (hermes.env with
 * the LLM key and WebUI bearer, the Bankr config) to the new VM's private IP.
 * These tests run the generated Phase 2 on a sandboxed host where a neighbour
 * can answer SSH at that IP with its own host key, and check the deploy only
 * reaches the sshd whose key the new VMID's guest agent attests.
 */

const VMID = 201;
const GUEST_IP = "10.250.20.51";
const INSTANCE_ID = "inst-phase2-identity";
// Placeholder, not a real key: stands in for the secrets the deploy script carries.
const DEPLOY_SECRET = "placeholder-llm-key-not-real";
const DEPLOY_SCRIPT = `#!/usr/bin/env bash\nprintf 'OPENAI_API_KEY=${DEPLOY_SECRET}\\n' > /opt/hermes/hermes.env\n`;
const BOOTSTRAP_MARKER = "phase2-fixture-bootstrap";

const PROVISION_PARAMS = {
  instanceId: INSTANCE_ID,
  vmName: "hermes-phase2-identity",
  templateId: 9000,
  vmidStart: 200,
  vmidEnd: 250,
  ipLastOctetStart: 50,
  privateSubnetPrefix: "10.250.20",
  privateCidr: 24,
  privateGateway: "10.250.20.1",
  nameserver: "1.1.1.1",
  cores: 1,
  memoryMb: 2048,
  deployScript: DEPLOY_SCRIPT,
  vmSshUser: "hermes",
  vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
  gatewayHost: "inst-phase2.203-0-113-10.sslip.io",
  caddySitesDir: "/etc/caddy/hermes.d",
  apiServerKey: "a".repeat(64),
};

// Host commands Phase 2 calls that the sandbox must not reach for real.
const HOST_COMMANDS = {
  curl: "printf 200",
  caddy: "exit 0",
  systemctl: "exit 1",
  lvs: "exit 0",
  lvremove: "exit 0",
};

function phase2Body(script: string): string {
  const match = script.match(/<<'PHASE2_BOOTSTRAP'\n([\s\S]*?)\nPHASE2_BOOTSTRAP\n/);
  if (!match) throw new Error("Phase 2 heredoc not found in the provision script");
  return match[1];
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

let host: StubProxmoxGuestHost;

beforeEach(() => {
  host = createStubProxmoxGuestHost();
});

afterEach(() => {
  host.cleanup();
});

/** Run the generated Phase 2 the way Phase 1's nohup line starts it. */
function runPhase2(options: { vms: StubGuestVm[]; serverHostKey: string }): StubRunResult {
  const { root } = host;
  const payloadDir = `${root}/run/hermes-proxmox-phase2-${VMID}`;
  const body = phase2Body(buildProxmoxProvisionScript(PROVISION_PARAMS))
    .replaceAll("/run/hermes-vm-claims", `${root}/run/hermes-vm-claims`)
    .replaceAll("/run/hermes-proxmox-phase2-", `${root}/run/hermes-proxmox-phase2-`);
  const launch = [
    `export INSTANCE_ID='${INSTANCE_ID}' VMID='${VMID}' PRIVATE_IP='${GUEST_IP}'`,
    `export SITE_FILE='${root}/run/site.caddy' SSH_KNOWN_HOSTS_FILE='${root}/run/known-hosts-${VMID}'`,
    `export VM_SSH_USER='hermes' VM_SSH_KEY_PATH='${host.vmKeyPath}' PHASE2_PAYLOAD_DIR='${payloadDir}'`,
    `export DEPLOY_B64_FILE='${payloadDir}/deploy.b64' BOOTSTRAP_B64_FILE='${payloadDir}/bootstrap.b64'`,
    `export API_SERVER_KEY='${"a".repeat(64)}' READINESS_ATTEMPTS=3 READINESS_INTERVAL_SECONDS=2`,
    `mkdir -p '${root}/run/hermes-vm-claims' "$PHASE2_PAYLOAD_DIR"`,
    `printf '%s' "$INSTANCE_ID" > '${root}/run/hermes-vm-claims/${VMID}.claim'`,
    `printf '%s' '${b64(`#!/usr/bin/env bash\necho ${BOOTSTRAP_MARKER}\n`)}' > "$BOOTSTRAP_B64_FILE"`,
    `printf '%s' '${b64(DEPLOY_SCRIPT)}' > "$DEPLOY_B64_FILE"`,
    `touch "$SITE_FILE"`,
  ].join("\n");
  return host.run(`${launch}\n${body}\n`, { ...options, commands: HOST_COMMANDS });
}

/** Staged payloads and pinned known_hosts left on the host after Phase 2 exits. */
const leftovers = () =>
  fs
    .readdirSync(`${host.root}/run`)
    .filter((entry) => entry.startsWith("hivra-guest-ssh-identity.") || entry.startsWith("hermes-proxmox-phase2-"));

const genuineVm = (overrides: Partial<StubGuestVm> = {}): StubGuestVm => ({ vmid: VMID, ip: GUEST_IP, ...overrides });

const scriptStreams = (result: StubRunResult) =>
  result.sshArgs.filter((args) => args[args.length - 1] === "sudo bash -s");

const optionValues = (args: string[], name: string) =>
  args.flatMap((arg, index) => (args[index - 1] === "-o" && arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []));

describe("fresh Proxmox provision Phase 2 guest identity", () => {
  it("never streams the deploy secrets to a neighbour answering SSH at the new VM's ip", () => {
    const result = runPhase2({ vms: [genuineVm()], serverHostKey: SPOOFED_GUEST_HOST_KEY });

    expect(result.delivered).not.toContain(DEPLOY_SECRET);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `VMID-bound SSH refused: the SSH server at ${GUEST_IP} did not present VM ${VMID}'s attested SSH host key; nothing was sent to the guest`
    );
    // The half-provisioned VM is torn down like any other Phase 2 failure,
    // and the staged secrets and pinned known_hosts are removed.
    expect(result.qmCalls).toContain(`destroy ${VMID} --purge 1`);
    expect(leftovers()).toEqual([]);
  });

  it("delivers the deploy over SSH pinned to the host key the VMID's guest agent attests", () => {
    const result = runPhase2({ vms: [genuineVm()], serverHostKey: GENUINE_GUEST_HOST_KEY });

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.delivered).toContain(DEPLOY_SECRET);
    expect(result.qmCalls).not.toContain(`destroy ${VMID} --purge 1`);
    expect(leftovers()).toEqual([]);

    const streams = scriptStreams(result);
    expect(streams).toHaveLength(2);
    const [bootstrap, deploy] = streams;
    // The deploy is pinned: strict checking against a one-entry known_hosts
    // holding the attested key, under the VMID's alias.
    expect(optionValues(deploy, "StrictHostKeyChecking")).toEqual(["yes"]);
    expect(optionValues(deploy, "HostKeyAlias")).toEqual([`hivra-vmid-${VMID}`]);
    expect(optionValues(deploy, "GlobalKnownHostsFile")).toEqual(["/dev/null"]);
    expect(deploy).toContain(`hermes@${GUEST_IP}`);
    // The bootstrap runs before the guest agent exists and carries only the
    // fixed public bootstrap script.
    expect(optionValues(bootstrap, "StrictHostKeyChecking")).toEqual(["accept-new"]);

    // Nothing after the bootstrap uses an unpinned connection.
    const bootstrapIndex = result.sshArgs.indexOf(bootstrap);
    for (const args of result.sshArgs.slice(bootstrapIndex + 1)) {
      expect(optionValues(args, "StrictHostKeyChecking")).toEqual(["yes"]);
    }
    // The post-readiness disk cleanup is one of those pinned calls.
    expect(result.sshCalls.some((call) => call.includes("hermes-disk-cleanup"))).toBe(true);
  });

  it("refuses and tears the VM down when the guest agent never answers", () => {
    const result = runPhase2({ vms: [genuineVm({ agentUp: false })], serverHostKey: GENUINE_GUEST_HOST_KEY });

    expect(result.delivered).not.toContain(DEPLOY_SECRET);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `VMID-bound SSH refused: QEMU Guest Agent in VM ${VMID} did not answer, so its SSH host key can't be attested`
    );
    expect(result.qmCalls).toContain(`destroy ${VMID} --purge 1`);
  });

  it("refuses when the VM has no guest agent channel to attest through", () => {
    const result = runPhase2({ vms: [genuineVm({ agent: null })], serverHostKey: GENUINE_GUEST_HOST_KEY });

    expect(result.delivered).not.toContain(DEPLOY_SECRET);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `VMID-bound SSH refused: VM ${VMID} has no QEMU Guest Agent channel, so its SSH host key can't be attested`
    );
    expect(result.qmCalls).toContain(`destroy ${VMID} --purge 1`);
  });

  it("tears the VM down when the host key can't be read, not only when the pin fails", () => {
    // A failure inside the attestation itself must still run Phase 2's
    // teardown and payload cleanup, not just the prelude's own cleanup.
    const result = runPhase2({
      vms: [genuineVm({ attestedHostKeyLine: "ssh-rsa AAAAB3NzaC1yc2E root@guest" })],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

    expect(result.delivered).not.toContain(DEPLOY_SECRET);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`VMID-bound SSH refused: VM ${VMID} did not attest a valid Ed25519 SSH host key`);
    expect(result.qmCalls).toContain(`destroy ${VMID} --purge 1`);
    expect(leftovers()).toEqual([]);
  });

  it("gives the clone a guest agent channel before it first boots", () => {
    const script = buildProxmoxProvisionScript(PROVISION_PARAMS);
    const clone = script.indexOf('qm clone "$TEMPLATE_ID" "$VMID"');
    const agentChannel = script.indexOf('qm set "$VMID" --agent "enabled=1');
    const start = script.indexOf('qm start "$VMID"');

    expect(clone).toBeGreaterThan(0);
    expect(agentChannel).toBeGreaterThan(clone);
    expect(start).toBeGreaterThan(agentChannel);
    // Phase 2 is the only place the deploy is streamed, after the pin.
    const phase2 = phase2Body(script);
    expect(phase2.indexOf('run_guest_script deploy "$DEPLOY_B64_FILE" "${GUEST_SSH[@]}"')).toBeGreaterThan(
      phase2.indexOf("qm guest exec")
    );
    expect(script.split('"$DEPLOY_B64_FILE"').length - 1).toBe(1);
  });

  it.each(["webui", "gateway"] as const)("keeps every shell layer of the %s provision script parseable", (backend) => {
    const script = buildProxmoxProvisionScript({ ...PROVISION_PARAMS, backend });
    const locked = script.match(/<<'HERMES_PROXMOX_LOCKED'\n([\s\S]*?)\nHERMES_PROXMOX_LOCKED\n/)?.[1] ?? "";
    expect(locked).toContain("qm start");
    for (const layer of [script, locked, phase2Body(script)]) {
      const syntax = spawnSync("bash", ["-n"], { input: layer, encoding: "utf8" });
      expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    }
  });
});
