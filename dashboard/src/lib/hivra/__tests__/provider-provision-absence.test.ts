import { observeAbsentProviderDesktopProvision, reconcileAbsentProviderDesktopProvision } from "../provider-provision-absence";
import { loadProviderAgentDeleteContext } from "../provider-agent-delete";
import { firstBootCleanupFixture, cleanupConnection, cleanupOrder } from "@/lib/infrastructure/__tests__/hetzner-cleanup.fixtures";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import { z } from "zod";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Active = Exclude<Awaited<ReturnType<typeof loadProviderAgentDeleteContext>>, { status: "deleted" }>;
function setup() {
  const { order, firstBoot } = firstBootCleanupFixture();
  const input = { userId: "owner", agentId, operationId };
  const agent: Active = { id: agentId, user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop",
    computer_substrate: "provider-vm", deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
    vmid: null, status: "provisioning", desired_state: "deleted", operation_id: operationId, operation_kind: "provision",
    allocation_operation_id: operationId, infrastructure_connection_id: cleanupConnection, infrastructure_connection_revision: 7,
    deployment_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", provider_capacity_order_id: cleanupOrder,
    provider_enrollment_attempt_id: firstBoot.binding.attemptId, provider_server_id: "42" };
  const secret = { connection: { id: cleanupConnection, status: "ready" }, revision: 7, apiToken: "test-only-secret" };
  const getServer = jest.fn(async (id: number): Promise<null> => { expect(id).toBe(42); return null; });
  const deps = {
    load: jest.fn(async (owner: { userId: string; agentId: string }) => {
      z.object({ userId: z.string(), agentId: z.string().uuid() }).strict().parse(owner);
      return structuredClone(agent);
    }), order: jest.fn(async () => order), boot: jest.fn(async () => firstBoot),
    secret: jest.fn(async () => secret as never), client: jest.fn(() => ({ getServer }) as never),
    now: () => new Date("2026-09-05T17:31:46Z"), monotonicNow: jest.fn(() => 100),
  };
  return { input, agent, order, firstBoot, secret, getServer, deps };
}
it("observes only the exact original absent server without granting cleanup or exposing credentials", async () => {
  const h = setup();
  const result = await observeAbsentProviderDesktopProvision(h.input, h.deps);
  expect(result).toMatchObject({ ...h.input, serverId: "42", orderId: cleanupOrder, connectionRevision: 7,
    observedAt: "2026-09-05T17:31:46.000Z" });
  expect(h.getServer).toHaveBeenCalledWith(42);
  expect(h.deps.load).toHaveBeenCalledTimes(2);
  expect(h.deps.load.mock.calls).toEqual([[{ userId: "owner", agentId }], [{ userId: "owner", agentId }]]);
  expect(h.deps.secret).toHaveBeenCalledTimes(2);
  expect(result).not.toHaveProperty("desktopCleanup");
  expect(JSON.stringify(result)).not.toMatch(/test-only-secret|apiToken|privateKey/);
});
it("does not confuse a present server with absence", async () => {
  const h = setup(); h.getServer.mockResolvedValue({ id: 42 } as never);
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).resolves.toBeNull();
});
it.each(["timeout", "unauthorized", "rate_limit", "html404"])("does not convert %s into absence", async code => {
  const h = setup(); h.getServer.mockRejectedValue(new Error(code));
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow(code);
});
it.each(["user_id", "operation_id", "allocation_operation_id", "desired_state", "type", "computer_profile", "operation_kind"])("rejects changed %s before provider access", async field => {
  const h = setup(); Object.assign(h.agent, { [field]: "changed" });
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow("authority changed");
  expect(h.deps.client).not.toHaveBeenCalled();
});
it("rejects mismatched enrollment before loading the provider credential", async () => {
  const h = setup(); h.agent.provider_enrollment_attempt_id = agentId;
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow("enrollment changed");
  expect(h.deps.secret).not.toHaveBeenCalled();
});
it("rejects operation handoff during the provider request", async () => {
  const h = setup(); h.getServer.mockImplementation(async () => { h.agent.operation_id = agentId; return null; });
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow("authority changed");
});
it("rejects connection rotation during the provider request", async () => {
  const h = setup(); h.deps.secret.mockResolvedValueOnce(structuredClone(h.secret) as never);
  h.getServer.mockImplementation(async () => { h.secret.revision++; return null; });
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow("connection changed");
});
it.each([25_100, Number.NaN, 99])("rejects expired or invalid monotonic observations (%s)", async time => {
  const h = setup(); h.getServer.mockImplementation(async () => { h.deps.monotonicNow.mockReturnValue(time); return null; });
  await expect(observeAbsentProviderDesktopProvision(h.input, h.deps)).rejects.toThrow("expired");
});
it("does not attempt a database handoff while the original server exists", async () => {
  const h = setup(), record = jest.fn();
  await expect(reconcileAbsentProviderDesktopProvision(h.input,{observe:async()=>null,record})).resolves.toBe(false);
  expect(record).not.toHaveBeenCalled();
});
it("requires a confirmed database handoff after a new observation", async () => {
  const h = setup();
  const observe = jest.fn(async()=>observeAbsentProviderDesktopProvision(h.input,h.deps));
  const record = jest.fn(async(): Promise<void>=>{ throw new Error("SQL binding changed"); });
  await expect(reconcileAbsentProviderDesktopProvision(h.input,{observe,record})).rejects.toThrow("SQL binding changed");
  expect(observe).toHaveBeenCalledTimes(1);
  record.mockImplementation(async()=>{});
  await expect(reconcileAbsentProviderDesktopProvision(h.input,{observe,record})).resolves.toBe(true);
  expect(observe).toHaveBeenCalledTimes(2);
});
