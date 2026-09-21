jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { spawnSync } from "node:child_process";
import { resolveHivraAgentExecutionContext, type HivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "../guest-installation";
import {
  buildOmarchyGuardianHostScript,
  executeOmarchyGuardianAction,
  executeOmarchyGuardianRenewalAction,
  type OmarchyGuardianAction,
  type OmarchyGuardianGrant,
  type OmarchyGuardianRenewal,
  parseOmarchyGuardianResult,
} from "../omarchy-native-guardian-host";

const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ID = "44444444-4444-4444-8444-444444444444";
const BOOT_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "user_fixture";

const grant: OmarchyGuardianGrant = {
  protocol: "hivra-omarchy-guardian-grant-v2",
  binding: { computerId: COMPUTER_ID, operationId: OPERATION_ID, vmid: 2099,
    ownerUid: 1000, guestPrivateIpv4: "10.240.20.99", waylandDisplay: "wayland-1" },
  ownerId: USER_ID,
  capabilityGeneration: "66666666-6666-4666-8666-666666666666",
  observedRevision: "a".repeat(64),
  sessionId: SESSION_ID,
  leaseId: LEASE_ID,
  clientId: "77777777-7777-4777-8777-777777777777",
  clientCertificatePem: "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
  clientCertificateSha256: "b".repeat(64),
  guestBootId: BOOT_ID,
  expiresAtUnixMs: 1_788_847_440_000,
  deadlineBoottimeNs: 200_000_000_000,
  continuousDeadlineBoottimeNs: 43_000_000_000_000,
  runtimeMaxUsec: 90_000_000,
  sunshineSha256: "c".repeat(64),
  guardianSha256: "d".repeat(64),
  ownershipSha256: "e".repeat(64),
  preparedSha256: "f".repeat(64),
  unitSha256: "0".repeat(64),
};

const agent: RemoteDesktopAgentRow = {
  id: COMPUTER_ID, user_id: USER_ID, type: "linux-desktop", computer_profile: "omarchy",
  status: "running", desired_state: "running", operation_id: null, operation_kind: null,
  vmid: 2099, ip: "10.240.20.99", chat_url: "https://fixture.invalid",
  infrastructure_binding_token_hash: "9".repeat(64),
  infrastructure_binding_token_enforced: true,
};

const context: HivraAgentExecutionContext = {
  kind: "managed" as const,
  host: "fixture",
  provisionerChannel: "canary" as const,
  infrastructureBindingTagEnforced: true,
  infrastructureBindingTag: "hivra-bind-" + "9".repeat(32),
  env: { TEST_HOST: "owned" },
  paths: { provisionerDirectory: "/fixture/provisioner", logDirectory: "/fixture/logs",
    provisionLogPrefix: "hivra-prov-", startLogPrefix: "hivra-start-",
    storage: "fixture-storage", vmSshKeyPath: null },
};

const results = {
  activate: { sessionId: SESSION_ID, leaseId: LEASE_ID, activation: "started", desktopReady: false },
  "observe-ready": {
    sessionId: SESSION_ID, leaseId: LEASE_ID, guestBootId: BOOT_ID,
    capabilityGeneration: grant.capabilityGeneration, observedRevision: grant.observedRevision,
    serverId: COMPUTER_ID, guestPrivateIpv4: grant.binding.guestPrivateIpv4,
    serverCertificatePem: "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
    serverCertificateSha256: "8".repeat(64), pairingVerified: true, desktopReady: true,
  },
  revoke: { leaseId: LEASE_ID, sessionId: SESSION_ID, reason: "control-plane-revoked",
    revocation: "requested", releasePending: true, desktopReady: false },
  "observe-stop": { leaseId: LEASE_ID, sessionId: SESSION_ID, guestBootId: BOOT_ID,
    invocationId: "1".repeat(32), ownedProcessBoundaryStopped: true,
    releasePending: true, desktopReady: false },
  "release-stop": { leaseId: LEASE_ID, sessionId: SESSION_ID, guestBootId: BOOT_ID,
    invocationId: "1".repeat(32), ownedProcessBoundaryStopped: true,
    releasePending: false, controllerReleased: true, desktopReady: false },
} as const;

const renewal: OmarchyGuardianRenewal = {
  protocol: "hivra-omarchy-guardian-renewal-v1",
  sessionId: SESSION_ID, leaseId: LEASE_ID,
  capabilityGeneration: grant.capabilityGeneration, guestBootId: BOOT_ID,
  renewalId: "88888888-8888-4888-8888-888888888888", renewalCount: 1,
  deadlineBoottimeNs: 400_000_000_000,
  continuousDeadlineBoottimeNs: grant.continuousDeadlineBoottimeNs,
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
});

it.each(Object.keys(results) as Exclude<OmarchyGuardianAction, "renew" | "observe-renew">[])("builds one bounded VMID-bound %s dispatch", async action => {
  const script = buildOmarchyGuardianHostScript(action, grant, context.infrastructureBindingTag);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
  expect(script).toContain(`VMID=${grant.binding.vmid}`);
  expect(script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
  expect(script).toContain("/usr/local/libexec/hivra/omarchy-native-supervisor.py");
  expect(script).toContain("/usr/local/libexec/hivra/omarchy-sunshine-ownership.py");
  expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"'))
    .toBeLessThan(script.lastIndexOf("run_vmid_bound_guest_exec_stdin"));
  expect(script).not.toContain("ssh ");
  expect(Buffer.byteLength(script)).toBeLessThan(80_000);

  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({
    ok: true, stdout: JSON.stringify(results[action]), stderr: "",
  });
  expect(await executeOmarchyGuardianAction(USER_ID, action, grant, agent)).toEqual({
    ok: true, action, result: results[action],
  });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
});

it.each(["renew", "observe-renew"] as const)("binds %s to the exact renewal envelope", async action => {
  const result = { sessionId: SESSION_ID, leaseId: LEASE_ID, guestBootId: BOOT_ID,
    renewalId: renewal.renewalId, renewalCount: 1, deadlineBoottimeNs: renewal.deadlineBoottimeNs,
    continuousDeadlineBoottimeNs: renewal.continuousDeadlineBoottimeNs,
    renewal: action === "renew" ? "accepted" : "applied", desktopReady: true };
  const script = buildOmarchyGuardianHostScript(action, grant, context.infrastructureBindingTag, renewal);
  expect(script).toContain(JSON.stringify({ grant, renewal }).slice(0, 32));
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(result), stderr: "" });
  await expect(executeOmarchyGuardianRenewalAction(
    USER_ID, action, grant, renewal, agent,
  )).resolves.toEqual({ ok: true, action, result });
});

it("rejects changed target authority before dispatch", async () => {
  for (const changed of [
    { ...agent, user_id: "other" },
    { ...agent, computer_profile: "ubuntu-desktop" },
    { ...agent, status: "stopped" },
    { ...agent, operation_id: OPERATION_ID },
    { ...agent, vmid: 2098 },
    { ...agent, ip: "10.240.20.98" },
    { ...agent, infrastructure_binding_token_hash: null },
  ]) {
    expect(await executeOmarchyGuardianAction(USER_ID, "activate", grant, changed)).toEqual({
      ok: false, code: "invalid_target",
    });
  }
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("rejects missing binding authority and never retries uncertain transport", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({
    ...context, infrastructureBindingTagEnforced: false,
  });
  expect(await executeOmarchyGuardianAction(USER_ID, "activate", grant, agent)).toEqual({
    ok: false, code: "authority_unavailable",
  });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();

  jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private details"));
  expect(await executeOmarchyGuardianAction(USER_ID, "activate", grant, agent)).toEqual({
    ok: false, code: "transport_failed",
  });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
});

it("requires exact result identity and shape", () => {
  expect(parseOmarchyGuardianResult("activate", JSON.stringify(results.activate), grant)).toEqual(results.activate);
  for (const value of [
    { ...results.activate, sessionId: OPERATION_ID },
    { ...results.activate, desktopReady: true },
    { ...results.activate, extra: true },
  ]) expect(parseOmarchyGuardianResult("activate", JSON.stringify(value), grant)).toBeNull();
  expect(parseOmarchyGuardianResult("observe-stop", JSON.stringify({
    ...results["observe-stop"], guestBootId: OPERATION_ID,
  }), grant)).toBeNull();
  expect(parseOmarchyGuardianResult("revoke", JSON.stringify({
    ...results.revoke, releasePending: false,
  }), grant)).toMatchObject({ releasePending: false });
  for (const changed of [
    { capabilityGeneration: OPERATION_ID },
    { observedRevision: "7".repeat(64) },
    { serverId: OPERATION_ID },
    { guestPrivateIpv4: "10.240.20.98" },
  ]) expect(parseOmarchyGuardianResult("observe-ready", JSON.stringify({
    ...results["observe-ready"], ...changed,
  }), grant)).toBeNull();
  expect(parseOmarchyGuardianResult("activate", "private garbage", grant)).toBeNull();
});

it("snapshots the target and grant before awaiting authority", async () => {
  let resolve!: (value: HivraAgentExecutionContext) => void;
  jest.mocked(resolveHivraAgentExecutionContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({
    ok: true, stdout: JSON.stringify(results.activate), stderr: "",
  });
  const mutableAgent = structuredClone(agent);
  const mutableGrant = structuredClone(grant);
  const pending = executeOmarchyGuardianAction(USER_ID, "activate", mutableGrant, mutableAgent);
  mutableAgent.vmid = 2098;
  mutableGrant.binding.vmid = 2098;
  resolve(context);
  expect(await pending).toEqual({ ok: true, action: "activate", result: results.activate });
  expect(runProxmoxHostScript).toHaveBeenCalledWith(
    expect.stringContaining("VMID=2099"),
    context.env,
    expect.objectContaining({ maxOutputBytes: 32_768 }),
  );
});
