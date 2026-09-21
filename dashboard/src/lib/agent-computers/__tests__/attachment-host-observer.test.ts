jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { observeAttachmentGuestBoot } from "../attachment-host-observer";

const request = { operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333", architecture: "x86_64" as const };
const agent: RemoteDesktopAgentRow = { id: request.sourceId, user_id: "owner", operation_id: request.operationId,
  operation_kind: "agent_attach", status: "running", desired_state: "running", computer_profile: "ubuntu-desktop",
  computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, vmid: 1234, ip: "10.241.0.44", chat_url: null };
const bindingTag = "hivra-bind-" + "a".repeat(32);
const observation = { version: 1, target: { ...request, vmid: agent.vmid, guestIp: agent.ip, bindingTag },
  bootId: "44444444-4444-4444-8444-444444444444" };
const context: Awaited<ReturnType<typeof resolveHivraAgentExecutionContext>> = {
  kind: "managed", host: "fixture", provisionerChannel: "canary",
  infrastructureBindingTagEnforced: true, infrastructureBindingTag: bindingTag, env: { TEST_HOST: "owned" },
  paths: { provisionerDirectory: "/fixture/provisioner", logDirectory: "/fixture/logs", provisionLogPrefix: "hivra-prov-",
    startLogPrefix: "hivra-start-", storage: "fixture-storage", vmSshKeyPath: null },
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
  jest.mocked(runProxmoxHostScript).mockResolvedValue({ ok: true, stdout: JSON.stringify(observation), stderr: "" });
});

it("uses the resolved host and exact held operation to obtain a bounded observation", async () => {
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: true, observation });
  expect(resolveHivraAgentExecutionContext).toHaveBeenCalledWith("owner", agent);
  expect(runProxmoxHostScript).toHaveBeenCalledWith(expect.stringContaining('qm guest exec "$VMID"'), context.env,
    { timeoutMs: 90_000, maxOutputBytes: 16384 });
});

it("snapshots admitted inputs before awaiting authority so caller mutation cannot retarget execution", async () => {
  let resolve!: (value: typeof context) => void;
  jest.mocked(resolveHivraAgentExecutionContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const mutableAgent = { ...agent };
  const mutableRequest = { ...request };
  const pending = observeAttachmentGuestBoot("owner", mutableAgent, mutableRequest);
  mutableAgent.vmid = 9999;
  mutableAgent.ip = "10.241.0.99";
  mutableAgent.operation_id = observation.bootId;
  mutableAgent.user_id = "other";
  mutableRequest.operationId = observation.bootId;
  mutableRequest.sourceId = observation.bootId;
  mutableRequest.computerId = observation.bootId;
  resolve(context);
  expect(await pending).toEqual({ ok: true, observation });
  expect(runProxmoxHostScript).toHaveBeenCalledWith(expect.stringContaining("VMID=1234"), context.env, expect.any(Object));
  expect(runProxmoxHostScript).not.toHaveBeenCalledWith(expect.stringContaining("VMID=9999"), expect.anything(), expect.anything());
  expect(resolveHivraAgentExecutionContext).toHaveBeenCalledWith("owner", agent);
});

it.each([{ user_id: "other" }, { id: request.computerId }, { operation_id: null }, { operation_kind: "restart" },
  { status: "stopped" }, { desired_state: "deleted" }, { computer_profile: "windows-desktop" },
  { computer_substrate: "docker" }, { infrastructure_binding_token_enforced: false }])("does not resolve or run a disallowed target %j", async change => {
  expect(await observeAttachmentGuestBoot("owner", { ...agent, ...change }, request)).toEqual({ ok: false, code: "invalid_target" });
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("refuses unavailable or unenforced authority without host execution", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockRejectedValueOnce(new Error("private detail"));
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: false, code: "authority_unavailable" });
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({ ...context, infrastructureBindingTagEnforced: false } as typeof context);
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: false, code: "authority_unavailable" });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("preserves transport uncertainty and rejects a foreign receipt without exposing raw output", async () => {
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: false, stdout: "private", stderr: "private" });
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: false, code: "transport_failed" });
  jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private"));
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: false, code: "transport_failed" });
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ...observation, target: { ...observation.target, vmid: 9999 } }), stderr: "" });
  expect(await observeAttachmentGuestBoot("owner", agent, request)).toEqual({ ok: false, code: "invalid_observation" });
});
