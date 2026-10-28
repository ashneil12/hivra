/** @jest-environment node */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

import { resizeProxmoxVm } from "../proxmox-instance-service";

/**
 * A resize pushes the new cgroup ceiling into the agent containers over SSH to
 * the VM's private IP, as root. These tests run the generated host script on a
 * sandboxed host where a neighbour can answer SSH at that IP with its own host
 * key, and check the push only reaches the sshd whose key the VMID's guest
 * agent attests, while the resize itself still succeeds.
 */

const VMID = 1148;
const GUEST_IP = "10.250.20.51";
const INSTANCE_ID = "3f0c9a52-6d1e-4b7a-9c2f-8e5d4a1b0c3d";

let host: StubProxmoxGuestHost;
let keyDir: string;

beforeEach(() => {
  host = createStubProxmoxGuestHost();
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "resize-key-"));
  fs.writeFileSync(path.join(keyDir, "vm-orchestrator"), "not a real key\n");
});

afterEach(() => {
  host.cleanup();
  fs.rmSync(keyDir, { recursive: true, force: true });
});

async function resizeScript(): Promise<string> {
  const scripts: string[] = [];
  await resizeProxmoxVm(
    { vmid: VMID, expectedInstanceId: INSTANCE_ID, cpuLimit: 1, memoryMb: 2048 },
    {
      env: {
        PROXMOX_VM_SSH_KEY_PATH: path.join(keyDir, "vm-orchestrator"),
        PROXMOX_VM_SSH_USER: "hermes",
      },
      runHostScript: async (script) => {
        scripts.push(script);
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  );
  return scripts[0];
}

const vm = { vmid: VMID, ip: GUEST_IP, name: `hermes-atlas-${INSTANCE_ID.slice(0, 8)}` };

describe("resize container-cap push", () => {
  it("reaches the guest whose host key its guest agent attests", async () => {
    const result = host.run(await resizeScript(), { vms: [vm], serverHostKey: GENUINE_GUEST_HOST_KEY });
    expect(result.status).toBe(0);
    expect(result.sshCalls).toHaveLength(1);
    expect(result.delivered).toContain("docker update");
    expect(result.qmCalls.some((call) => call.startsWith(`set ${VMID} --cpulimit`))).toBe(true);
  });

  it("sends nothing to a neighbour answering at the same IP, and the resize still succeeds", async () => {
    const result = host.run(await resizeScript(), { vms: [vm], serverHostKey: SPOOFED_GUEST_HOST_KEY });
    expect(result.status).toBe(0);
    expect(result.delivered).toBe("");
    expect(result.sshArgs.flat()).not.toContain("StrictHostKeyChecking=accept-new");
    expect(result.stderr).toContain("container caps (pre-reboot) not reapplied");
  });
});
