/** @jest-environment node */
import { NextRequest } from "next/server";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST } from "../route";

// Force off and Force restart, and a Stop that tells the truth about how it
// ended. Force off takes the Stop lease and Force restart the Restart lease,
// under the same ownership prelude, desktop invalidation and receipts; a My
// cloud computer is sent to its provider's console. Stop and Restart now say
// when the computer didn't shut down in time and Hivra switched it off.

const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockReadiness = jest.fn();
const mockRateLimit = jest.fn();
const mockRevoke = jest.fn();
const mockLogEvent = jest.fn();
const mockMatchPrepared = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(async () => ({ data: mockRow, error: null })),
      maybeSingle: jest.fn(async () => ({ data: { priority: 0 }, error: null })),
    }),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: () => ({ env: { PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21", PROXMOX_VMID_START: "1090", PROXMOX_IP_LAST_OCTET_START: "90" } }),
  runProxmoxHostScript: (...args: unknown[]) => mockRun(...args),
  buildAgentContainerCgroupScript: () => "",
}));
jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class ProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return { ProxmoxExecutionContextError, resolveSelfManagedProxmoxExecutionContext: jest.fn() };
});
jest.mock("@/lib/hivra/managed-provisioner-readiness", () => ({ checkManagedHivraHostReadiness: (...args: unknown[]) => mockReadiness(...args) }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...args) }));
jest.mock("@/lib/proxmox/wake-admission", () => ({ checkHostWakeCapacity: async () => ({ ok: true, freeMb: 32_768 }) }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: async () => ({ ok: true }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: (...args: unknown[]) => mockRevoke(...args) }));
jest.mock("@/lib/hivra/provider-agent-power", () => ({ advanceProviderAgentPower: jest.fn() }));
jest.mock("@/lib/hivra/provider-agent-power-store", () => ({ claimProviderAgentPowerOperation: jest.fn(async () => true) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  ...jest.requireActual("@/lib/hivra/prepared-canary-computers"),
  matchPreparedCanaryComputer: (...args: unknown[]) => mockMatchPrepared(...args),
}));

const managed = {
  id: "agent-1", user_id: "owner", name: "Desk", type: "linux-desktop", computer_profile: "ubuntu-desktop",
  status: "running", desired_state: "running", cpu: 2, ram: 4, vmid: 1113, ip: "10.250.21.63", proxmox_host: "fixturenode11",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", managed_provisioner_channel: "default",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, chat_url: "https://box-agent-1.example.test", api_token: "fixture-bearer",
};
const FORCE_RECEIPT = "HIVRA_FORCE_STOPPED vmid=1113";

function send(body: Record<string, unknown>, sameOrigin = true) {
  const headers: Record<string, string> = { Host: "hivra.cloud", "Content-Type": "application/json" };
  if (sameOrigin) Object.assign(headers, { Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" });
  return POST(new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/action", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "agent-1" }) });
}
const rpcNames = () => mockRpc.mock.calls.map(([name]) => name);
const claimArgs = () => mockRpc.mock.calls.find(([name]) => name === "claim_hivra_agent_operation")?.[1];
const script = () => String(mockRun.mock.calls[0]?.[0] ?? "");

beforeEach(() => {
  jest.clearAllMocks();
  mockRow = { ...managed };
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockReadiness.mockResolvedValue({ ok: true });
  mockRateLimit.mockReturnValue(null);
  mockRevoke.mockResolvedValue({ ok: true, revoked: true });
  mockMatchPrepared.mockReturnValue(null);
  mockRpc.mockResolvedValue({ data: true, error: null });
  mockRun.mockResolvedValue({ ok: true, stdout: `${FORCE_RECEIPT}\n`, stderr: "" });
});

describe("force_stop", () => {
  it("switches a Hivra Cloud computer off at once under the Stop lease and ownership checks", async () => {
    const response = await send({ action: "force_stop" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { status: "stopped", forced: true } });
    expect(claimArgs()).toMatchObject({ p_operation_kind: "stop", p_desired_state: "stopped" });
    expect(rpcNames()).toEqual(["claim_hivra_agent_operation", "complete_hivra_agent_operation"]);
    const body = script();
    expect(body).toContain("flock -w 60 8");
    expect(body).toContain(`EXPECTED_BINDING_TAG='hivra-bind-${"b".repeat(32)}'`);
    expect(body).toContain('qm stop "$VMID" --overrule-shutdown 1 --timeout 30');
    expect(body).not.toContain("qm shutdown");
    expect(body).not.toContain("hivra-start-on-host.sh");
    expect(spawnSync("bash", ["-n"], { input: body, encoding: "utf8" })).toMatchObject({ status: 0 });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "force_stopped" }));
  });

  it("invalidates the desktop before switching off, and sends nothing when that fails", async () => {
    await send({ action: "force_stop" });
    expect(mockRevoke.mock.invocationCallOrder[0]).toBeLessThan(mockRun.mock.invocationCallOrder[0]);
    mockRun.mockClear();
    mockRevoke.mockResolvedValueOnce({ ok: false, status: 503 });
    expect((await send({ action: "force_stop" })).status).toBe(503);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("works on a stale host, like Stop: it doesn't call the start helper", async () => {
    mockReadiness.mockResolvedValue({ ok: false, status: 503, message: "stale host", error: "version" });
    expect((await send({ action: "force_stop" })).status).toBe(200);
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  it("needs a same-origin request", async () => {
    expect((await send({ action: "force_stop" }, false)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("has its own rate limit, checked before the lease", async () => {
    mockRateLimit.mockImplementation((_request: unknown, options: { routeKey: string }) =>
      options.routeKey === "hivra_agent_force_power" ? new Response(null, { status: 429 }) : null);
    expect((await send({ action: "force_stop" })).status).toBe(429);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ routeKey: "hivra_agent_force_power", limit: 6, windowMs: 600_000 }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("waits for another change (such as an in-place update) instead of breaking its lease", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });
    const response = await send({ action: "force_stop" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("Hivra is still finishing another change to this computer. Wait for it to finish, then try again.");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ["the host fails", { ok: false, stdout: "", stderr: "VMID 1113 did not switch off (status=running)", error: "Remote bash exited with code 1" }],
    ["the receipt is missing", { ok: true, stdout: "", stderr: "" }],
    ["the receipt names another computer", { ok: true, stdout: "HIVRA_FORCE_STOPPED vmid=1114\n", stderr: "" }],
  ])("keeps the lease for the reconciler when %s", async (_case, result) => {
    mockRun.mockResolvedValue(result);
    expect((await send({ action: "force_stop" })).status).toBe(502);
    expect(rpcNames()).toContain("record_hivra_agent_operation_failure");
    expect(rpcNames()).not.toContain("complete_hivra_agent_operation");
    expect(rpcNames()).not.toContain("release_hivra_agent_operation");
  });

  it("sends a My cloud computer to its provider's console before any lease or provider call", async () => {
    mockRow = { ...managed, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null };
    for (const action of ["force_stop", "force_restart"]) {
      const response = await send({ action });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/use your provider's console to force it off/i);
    }
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ["a Linux Sandbox", { computer_substrate: "gvisor", computer_profile: "linux-terminal", deployment_mode: "self-managed", vmid: null }],
    ["a DigitalOcean session", { type: "codex", computer_profile: null, computer_substrate: "do-managed-session", deployment_mode: "self-managed", vmid: null }],
  ])("is refused for %s", async (_case, fields) => {
    mockRow = { ...managed, ...fields };
    expect((await send({ action: "force_stop" })).status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("force_restart", () => {
  it("switches off at once, then starts through the helper under the Restart lease", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: `${FORCE_RECEIPT}\nkicked\n`, stderr: "" });
    const response = await send({ action: "force_restart" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { status: "provisioning", forced: true } });
    expect(mockReadiness).toHaveBeenCalledWith(expect.objectContaining({ purpose: "lifecycle" }));
    expect(claimArgs()).toMatchObject({ p_operation_kind: "restart", p_desired_state: "running" });
    expect(rpcNames()).toContain("continue_hivra_agent_operation");
    const body = script();
    expect(body.indexOf("--overrule-shutdown 1")).toBeLessThan(body.indexOf("hivra-start-on-host.sh"));
    expect(body).not.toContain("qm shutdown");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "force_restarted" }));
  });

  it("needs a ready host, since it runs the start helper", async () => {
    mockReadiness.mockResolvedValue({ ok: false, status: 503, message: "Update this host first.", error: "version" });
    expect((await send({ action: "force_restart" })).status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("keeps the lease when the switch-off isn't confirmed", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "kicked\n", stderr: "" });
    expect((await send({ action: "force_restart" })).status).toBe(502);
    expect(rpcNames()).toContain("record_hivra_agent_operation_failure");
    expect(rpcNames()).not.toContain("continue_hivra_agent_operation");
  });
});

describe("prepared computers", () => {
  const slot = { host: "fixturenode11", node: "fixturenode11", vmid: 2098, ip: "10.250.21.98", claim: "33333333-3333-4333-8333-333333333333" };
  beforeEach(() => {
    mockRow = { ...managed, computer_profile: "windows", managed_provisioner_channel: "canary", vmid: 2098, ip: slot.ip, cpu: 4, ram: 8 };
    mockMatchPrepared.mockReturnValue({ profile: "windows", slot });
  });

  it("forces a prepared Windows computer off through its own adapter and receipt", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_LIFECYCLE windows force_stop stopped\n", stderr: "" });
    const response = await send({ action: "force_stop" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { status: "stopped", forced: true } });
    expect(claimArgs()).toMatchObject({ p_operation_kind: "stop", p_desired_state: "stopped" });
    const body = script();
    expect(body).toContain("--onboot 0");
    expect(body).toContain('qm stop "$VMID" --overrule-shutdown 1 --timeout 30');
    expect(body).not.toContain("qm shutdown");
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "force_stopped" }));
  });

  it("forces a prepared computer to restart and keeps it starting on boot", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_LIFECYCLE windows force_restart running\n", stderr: "" });
    const response = await send({ action: "force_restart" });
    expect(await response.json()).toEqual({ success: true, data: { status: "running", forced: true } });
    expect(claimArgs()).toMatchObject({ p_operation_kind: "restart" });
    expect(script()).toContain("--onboot 1");
  });

  it("keeps the lease without the adapter's exact receipt", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_LIFECYCLE windows stop stopped\n", stderr: "" });
    expect((await send({ action: "force_stop" })).status).toBe(502);
    expect(rpcNames()).toContain("record_hivra_agent_operation_failure");
  });

  it("says when a prepared Stop had to switch the computer off after 60 seconds", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_STOP_MODE forced 60 60\nHIVRA_PREPARED_LIFECYCLE windows stop stopped\n", stderr: "" });
    expect(await (await send({ action: "stop" })).json()).toEqual({ success: true, data: { status: "stopped", forced: true, waitedSeconds: 60 } });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "stopped", detail: { forced: true, reason: "shutdown_timeout" } }));
  });

  it("gives no wait for a prepared Stop whose shutdown failed sooner", async () => {
    mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_STOP_MODE forced 3 60\nHIVRA_PREPARED_LIFECYCLE windows stop stopped\n", stderr: "" });
    expect(await (await send({ action: "stop" })).json()).toEqual({ success: true, data: { status: "stopped", forced: true } });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "stopped", detail: { forced: true, reason: "shutdown_failed" } }));
  });
});

// Regression: Stop fell back to switching the computer off after 50 seconds
// without saying so, and Manage told the owner it had shut down cleanly.
describe("a truthful Stop and Restart", () => {
  it.each([
    ["stop", "HIVRA_STOP_MODE forced 50 50", { status: "stopped", forced: true, waitedSeconds: 50 }, "shutdown_timeout"],
    // `date +%s` steps in whole seconds, so a full wait can read one short.
    ["stop", "HIVRA_STOP_MODE forced 49 50", { status: "stopped", forced: true, waitedSeconds: 50 }, "shutdown_timeout"],
    ["stop", "HIVRA_STOP_MODE forced 2 50", { status: "stopped", forced: true }, "shutdown_failed"],
    // A switch-off without a wait it can check is still a switch-off.
    ["stop", "HIVRA_STOP_MODE forced", { status: "stopped", forced: true }, "shutdown_failed"],
    ["stop", "HIVRA_STOP_MODE graceful", { status: "stopped" }, null],
    ["stop", "HIVRA_STOP_MODE already", { status: "stopped" }, null],
    ["restart", "HIVRA_STOP_MODE forced 40 40", { status: "provisioning", forced: true, waitedSeconds: 40 }, "shutdown_timeout"],
    ["restart", "HIVRA_STOP_MODE forced 0 40", { status: "provisioning", forced: true }, "shutdown_failed"],
    ["restart", "HIVRA_STOP_MODE graceful", { status: "provisioning" }, null],
  ])("%s answers with how the computer went off (%s)", async (action, line, data, reason) => {
    mockRun.mockResolvedValue({ ok: true, stdout: `stopped 1113\n${line}\nkicked\n`, stderr: "" });
    const response = await send({ action });
    expect(await response.json()).toEqual({ success: true, data });
    const event = mockLogEvent.mock.calls.map(([call]) => call).find((call) => call.event === (action === "stop" ? "stopped" : "restarted"));
    expect(event?.detail).toEqual(reason ? { forced: true, reason } : undefined);
  });

  // The host part of the Stop script, run with a stub qm and a stub clock
  // that qm shutdown moves on: it reports "forced" with the wait measured on
  // the host exactly when the shutdown didn't finish and qm stop switched it
  // off, and the route turns that into what the owner is told. Regression:
  // the script printed its 50 s budget for any failed shutdown, so a shutdown
  // that failed at once was reported as "didn't shut down within 50 seconds".
  it.each([
    ["shuts down in time", "0", 12, "graceful", { status: "stopped" }],
    ["doesn't shut down in time", "1", 50, "forced 50 50", { status: "stopped", forced: true, waitedSeconds: 50 }],
    ["fails to shut down at once", "1", 1, "forced 1 50", { status: "stopped", forced: true }],
  ] as const)("the stop script says so when the computer %s", async (_case, shutdownExit, seconds, mode, data) => {
    mockRun.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    await send({ action: "stop" });
    const body = script();
    const hostPart = body.slice(body.indexOf("VMID=1113\nSTOP_MODE=already"));
    const work = mkdtempSync(path.join(tmpdir(), "hivra-stop-"));
    try {
      const state = path.join(work, "state");
      const clock = path.join(work, "clock");
      writeFileSync(state, "running");
      writeFileSync(clock, "1000");
      const qm = path.join(work, "qm");
      writeFileSync(qm, `#!/bin/bash
case "$1" in
  status) echo "status: $(cat ${JSON.stringify(state)})" ;;
  shutdown) echo $(( $(cat ${JSON.stringify(clock)}) + ${seconds} )) > ${JSON.stringify(clock)}; [ "${shutdownExit}" = 0 ] && echo stopped > ${JSON.stringify(state)}; exit ${shutdownExit} ;;
  stop) echo stopped > ${JSON.stringify(state)}; echo "stop $*" >> ${JSON.stringify(path.join(work, "log"))} ;;
esac`);
      const date = path.join(work, "date");
      writeFileSync(date, `#!/bin/bash
[ "$1" = "+%s" ] || exit 64
cat ${JSON.stringify(clock)}`);
      chmodSync(qm, 0o755);
      chmodSync(date, 0o755);
      const result = spawnSync("bash", ["-euo", "pipefail", "-s"], { input: hostPart, encoding: "utf8", env: { PATH: `${work}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`stopped 1113\nHIVRA_STOP_MODE ${mode}\n`);
      if (mode === "graceful") expect(() => readFileSync(path.join(work, "log"))).toThrow();

      // What the owner is told for that host output.
      mockRun.mockResolvedValue({ ok: true, stdout: result.stdout, stderr: "" });
      expect(await (await send({ action: "stop" })).json()).toEqual({ success: true, data });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
