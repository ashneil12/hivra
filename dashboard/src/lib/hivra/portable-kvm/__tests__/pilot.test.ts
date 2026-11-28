import { readPortableKvmPilot, resolvePortableKvmPilotPlacement } from "../pilot";

const deployment = process.env;
const ownerId = "user_fixture";
const agentId = "11111111-1111-4111-8111-111111111111";
const bindingTag = "hivra-bind-" + "a".repeat(32);
const source = { hostId: "qa-source", vmid: 9343, ip: "192.0.2.4", bindingTag };
const destination = { ...source, hostId: "qa-destination", vmid: 9393 };
const agent = { id: agentId, user_id: ownerId, proxmox_host: source.hostId, vmid: source.vmid, ip: source.ip,
  infrastructure_binding_token_enforced: true, infrastructure_binding_token_hash: "a".repeat(64) };
const scope = () => ({ ownerId, agentId, placements: [source, destination], profile: {},
  expiresAt: new Date(Date.now() + 60_000).toISOString() });

beforeEach(() => {
  process.env = { ...deployment, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra" };
});
afterEach(() => { process.env = deployment; });

it("observes operator activation and removal on successive reads of the same request scope", async () => {
  const rpc = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(scope()).mockResolvedValueOnce(null);
  for (const enabled of [false, true, false]) {
    const pilot = await readPortableKvmPilot(rpc, { ownerId, agentId });
    expect(resolvePortableKvmPilotPlacement(ownerId, agent, pilot))
      .toEqual(enabled ? { current: source, alternate: destination } : null);
  }
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenCalledWith("read_hivra_kvm_portable_pilot", { p_owner_id: ownerId, p_agent_id: agentId });
});

it("does not read or select a pilot outside Git Canary", async () => {
  const rpc = jest.fn().mockResolvedValue(scope());
  const pilot = await readPortableKvmPilot(rpc);
  rpc.mockClear();
  process.env.VERCEL_GIT_COMMIT_REF = "main";
  await expect(readPortableKvmPilot(rpc)).resolves.toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  expect(resolvePortableKvmPilotPlacement(ownerId, agent, pilot)).toBeNull();
});

it("refuses expired, cross-owner and incompatible selector data", async () => {
  const rpc = jest.fn().mockResolvedValueOnce({ ...scope(), expiresAt: "2025-01-01T00:00:00Z" })
    .mockResolvedValueOnce(scope()).mockResolvedValueOnce({
      ...scope(), placements: [source, { ...destination, ip: "192.0.2.5" }],
    });
  await expect(readPortableKvmPilot(rpc)).resolves.toBeNull();
  await expect(readPortableKvmPilot(rpc, { ownerId: "user_other" })).rejects.toThrow("Invalid portable KVM runtime pilot");
  await expect(readPortableKvmPilot(rpc)).rejects.toThrow("Invalid portable KVM runtime pilot");
});

it("rechecks the exact current placement and binding before dispatch", async () => {
  const pilot = await readPortableKvmPilot(jest.fn().mockResolvedValue(scope()));
  expect(() => resolvePortableKvmPilotPlacement(ownerId, { ...agent, vmid: 9344 }, pilot))
    .toThrow("not on an exact configured placement");
  expect(() => resolvePortableKvmPilotPlacement(ownerId, { ...agent, infrastructure_binding_token_hash: "b".repeat(64) }, pilot))
    .toThrow("pilot binding has changed");
});
