import { isHostedInstanceStartBlockedForLapse, isStartBlockedForLapse, ownerHasNoPaidPlan } from "../lapse-gate";
import { hasTokenTierInGrace, resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn(), hasTokenTierInGrace: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const resolve = resolveEffectiveSubscription as jest.Mock;
const inTokenGrace = hasTokenTierInGrace as jest.Mock;
const cloud = { user_id: "owner", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", deployment_target_id: null, infrastructure_connection_id: null };
const free = { plan: "free", source: "free", status: "active" };
const paid = { plan: "operator", source: "stripe", status: "active" };

const original = process.env.HIVRA_LAPSE_ENFORCE_LIVE;
beforeEach(() => { jest.clearAllMocks(); process.env.HIVRA_LAPSE_ENFORCE_LIVE = "true"; resolve.mockResolvedValue(null); inTokenGrace.mockResolvedValue(false); });
afterAll(() => { if (original === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; else process.env.HIVRA_LAPSE_ENFORCE_LIVE = original; });

describe("ownerHasNoPaidPlan", () => {
  it("is true for no entitlement and for the Free account only", async () => {
    expect(await ownerHasNoPaidPlan("owner")).toBe(true);
    resolve.mockResolvedValue(free);
    expect(await ownerHasNoPaidPlan("owner")).toBe(true);
  });
  it("is true for a trial on any plan or source: Hivra has no trials", async () => {
    resolve.mockResolvedValue({ plan: "operator", source: "stripe", status: "trialing" });
    expect(await ownerHasNoPaidPlan("owner")).toBe(true);
    resolve.mockResolvedValue({ plan: "fleet", source: "apple_iap", status: "trialing" });
    expect(await ownerHasNoPaidPlan("owner")).toBe(true);
  });
  it("is false for a token tier inside its 24 hour grace, with or without a Free row", async () => {
    inTokenGrace.mockResolvedValue(true);
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
    resolve.mockResolvedValue(free);
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
  });
  it("does not look for a token grace once the owner has a paid entitlement", async () => {
    resolve.mockResolvedValue(paid);
    await ownerHasNoPaidPlan("owner");
    expect(inTokenGrace).not.toHaveBeenCalled();
  });
  it("is false when the token grace cannot be read", async () => {
    inTokenGrace.mockRejectedValue(new Error("down"));
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
  });
  it("asks the resolver to throw on a failed read", async () => {
    await ownerHasNoPaidPlan("owner");
    expect(resolve).toHaveBeenCalledWith("owner", { throwOnQueryError: true });
  });
  it("is false for any paid entitlement and when the check fails", async () => {
    resolve.mockResolvedValue(paid);
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
    resolve.mockRejectedValue(new Error("down"));
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
  });
});

describe("isStartBlockedForLapse", () => {
  it.each(["start", "restart", "force_restart", "resize"])("blocks %s for a Hivra Cloud computer whose owner has no paid plan", async (action) => {
    expect(await isStartBlockedForLapse(cloud, action)).toBe(true);
  });

  it.each(["stop", "force_stop", "snapshot", "restore", "rename", "update_runtime", "delete"])("never gates %s", async (action) => {
    expect(await isStartBlockedForLapse(cloud, action)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not gate an entitled owner", async () => {
    resolve.mockResolvedValue(paid);
    expect(await isStartBlockedForLapse(cloud, "start")).toBe(false);
  });

  it("does not gate while the switch is off", async () => {
    delete process.env.HIVRA_LAPSE_ENFORCE_LIVE;
    expect(await isStartBlockedForLapse(cloud, "start")).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["a self-managed computer on the owner's server", { deployment_mode: "self-managed", deployment_target_id: "t", infrastructure_connection_id: "i" }],
    ["a computer with an infrastructure connection", { infrastructure_connection_id: "i" }],
    ["a provider VM", { computer_substrate: "provider-vm", deployment_mode: "self-managed" }],
    ["a Linux sandbox", { computer_substrate: "gvisor", deployment_mode: "self-managed" }],
    ["a DigitalOcean session", { computer_substrate: "do-managed-session", deployment_mode: "self-managed" }],
  ])("does not gate %s", async (_name, fields) => {
    expect(await isStartBlockedForLapse({ ...cloud, ...fields }, "start")).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("isHostedInstanceStartBlockedForLapse (older lane)", () => {
  it("refuses Start for an owner on the Free account only", async () => {
    resolve.mockResolvedValue(free);
    expect(await isHostedInstanceStartBlockedForLapse("owner", "start")).toBe(true);
  });
  it("lets a paying owner start", async () => {
    resolve.mockResolvedValue(paid);
    expect(await isHostedInstanceStartBlockedForLapse("owner", "start")).toBe(false);
  });
  it("never gates stop or any other action", async () => {
    for (const action of ["stop", "reboot", "restart_gateway", "update", "redeploy"]) {
      expect(await isHostedInstanceStartBlockedForLapse("owner", action)).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
  it("lets everything through while the switch is off", async () => {
    delete process.env.HIVRA_LAPSE_ENFORCE_LIVE;
    expect(await isHostedInstanceStartBlockedForLapse("owner", "start")).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("lets the owner start when the plan cannot be read", async () => {
    resolve.mockRejectedValue(new Error("database unavailable"));
    expect(await isHostedInstanceStartBlockedForLapse("owner", "start")).toBe(false);
  });
});
