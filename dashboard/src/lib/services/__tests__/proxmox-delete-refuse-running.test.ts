/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

import { buildProxmoxDeleteScript } from "@/lib/services/proxmox/script-builders";
import { deleteProxmoxInstance } from "@/lib/services/proxmox-instance-service";

import {
  GENUINE_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

const INSTANCE_ID = "00000000-0000-4000-8000-000000001036";
const VMID = 201;
const GATEWAY_HOST = "abc.example.com";
const REFUSED_MARKER = "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED 201";

function deleteScript(refuseIfRunning?: boolean, caddySitesDir = "/etc/caddy/hermes.d") {
  return buildProxmoxDeleteScript({
    vmid: VMID,
    expectedInstanceId: INSTANCE_ID,
    gatewayHost: GATEWAY_HOST,
    caddySitesDir,
    ...(refuseIfRunning === undefined ? {} : { refuseIfRunning }),
  });
}

describe("dormant reclaim destroy refuses a running guest", () => {
  let host: StubProxmoxGuestHost;
  let sitesDir: string;

  beforeAll(() => {
    host = createStubProxmoxGuestHost();
    // The delete script only proceeds when this instance's Caddy site file
    // names the instance, so the sandbox needs one.
    sitesDir = path.join(host.root, "caddy.d");
    fs.mkdirSync(sitesDir);
    fs.writeFileSync(path.join(sitesDir, `${GATEWAY_HOST}.caddy`), `# ${INSTANCE_ID}\n`);
  });

  afterAll(() => {
    host.cleanup();
  });

  it("exits before any shutdown, stop or destroy when the guest is running", () => {
    // The sweep chose this VM while it was paused; the owner has started it since.
    const result = host.run(deleteScript(true, sitesDir), {
      vms: [
        {
          vmid: VMID,
          ip: "10.250.20.201",
          status: "running",
          name: `hermes-${INSTANCE_ID}`,
        },
      ],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

    expect(result.status).toBe(44);
    expect(result.stderr).toContain(REFUSED_MARKER);
    expect(result.stdout).not.toContain("HERMES_PROXMOX_DELETE_VM_DESTROYED");
    // Nothing was stopped or destroyed, and the Caddy route was left in place.
    expect(result.qmCalls).toEqual([]);
  });

  it("refuses a paused guest on the dormant path, not only a running one", () => {
    // A paused guest is not stopped, so the destroy must not run against it either.
    const result = host.run(deleteScript(true, sitesDir), {
      vms: [
        {
          vmid: VMID,
          ip: "10.250.20.201",
          status: "paused",
          name: `hermes-${INSTANCE_ID}`,
        },
      ],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

    expect(result.status).toBe(44);
    expect(result.stderr).toContain(REFUSED_MARKER);
    expect(result.stderr).toContain("state=paused");
    expect(result.stdout).not.toContain("HERMES_PROXMOX_DELETE_VM_DESTROYED");
    expect(result.qmCalls).toEqual([]);
  });

  it("destroys a guest that is exactly stopped on the dormant path, with no shutdown or hard stop", () => {
    // The happy path the refusal guard must keep: a stopped guest is destroyed.
    fs.writeFileSync(path.join(sitesDir, `${GATEWAY_HOST}.caddy`), `# ${INSTANCE_ID}\n`);
    const result = host.run(deleteScript(true, sitesDir), {
      vms: [
        {
          vmid: VMID,
          ip: "10.250.20.201",
          status: "stopped",
          name: `hermes-${INSTANCE_ID}`,
        },
      ],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`HERMES_PROXMOX_DELETE_VM_DESTROYED ${VMID}`);
    expect(result.stderr).not.toContain(REFUSED_MARKER);
    expect(result.qmCalls).toEqual([`destroy ${VMID} --purge 1`]);
  });

  it("builds the refusal into the dormant script and drops the shutdown and hard stop", () => {
    const script = deleteScript(true);

    expect(script).toContain(REFUSED_MARKER);
    expect(script).toContain("exit 44");
    expect(script).not.toMatch(/qm shutdown /);
    expect(script).not.toMatch(/qm stop /);
    expect(script).toContain(`qm destroy ${VMID} --purge 1`);
  });

  it("keeps the graceful shutdown and hard-stop fallback for user-initiated deletes", () => {
    const script = deleteScript();

    expect(script).not.toContain(REFUSED_MARKER);
    expect(script).toMatch(/qm shutdown 201 --timeout 30/);
    expect(script).toContain("qm stop 201 --skiplock 1");
  });

  it("deleteProxmoxInstance hands the refusal flag to the host script", async () => {
    const scripts: string[] = [];
    const runHostScript = jest.fn(async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    });

    await deleteProxmoxInstance(
      {
        provider: "proxmox",
        node: "fixturenode1",
        vmid: VMID,
        privateIpv4: "10.250.20.201",
        gatewayHost: GATEWAY_HOST,
      },
      { expectedInstanceId: INSTANCE_ID, refuseIfRunning: true, runHostScript, env: {} }
    );

    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(scripts[0]).toContain(REFUSED_MARKER);
  });
});
