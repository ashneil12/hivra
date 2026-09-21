import { resizeBudget } from "../resize-budget";
import type { HivraAgent, PlanInfo } from "../agent-api";

const agent: HivraAgent = { id: "ours", type: "codex", name: "TEST", deployment_mode: "hivra-managed", status: "running", cpu: 2, ram: 4 };
const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 3, usedCpu: 22, usedRam: 124 } };

describe("resizeBudget", () => {
  it("counts combined Hermes/Hivra usage and recredits only the selected managed computer", () => {
    expect(resizeBudget(agent, plan)).toMatchObject({ ready: true, showPool: true, otherCpu: 20, otherRam: 120, cpu: 4, ram: 8 });
  });
  it.each(["stopped", "provisioning"] as const)("retains the %s computer's existing allocation", status => {
    expect(resizeBudget({ ...agent, status }, plan)).toMatchObject({ cpu: 4, ram: 8 });
  });
  it("does not recredit an error row that is excluded from managed totals", () => {
    expect(resizeBudget({ ...agent, status: "error" }, plan)).toMatchObject({ otherCpu: 22, otherRam: 124, cpu: 2, ram: 4 });
  });
  it.each([null, { ...plan, usage: undefined }, { ...plan, usage: { agentCount: 1, usedCpu: 0, usedRam: 0 } }, { ...plan, poolCpu: NaN }])("keeps unknown or inconsistent capacity closed", unknownPlan => {
    expect(resizeBudget(agent, unknownPlan)).toMatchObject({ ready: false, showPool: false, cpu: 0, ram: 0 });
  });
  it.each([null, { ...plan, poolCpu: 0.5, poolRam: 1, usage: { agentCount: 8, usedCpu: 24, usedRam: 128 } }])("does not impose managed allowances on self-managed computers", managedPlan => {
    expect(resizeBudget({ ...agent, deployment_mode: "self-managed" }, managedPlan)).toMatchObject({ selfManaged: true, ready: true, showPool: false, cpu: 8, ram: 24 });
  });
  it("keeps slot-only Aeon independent from the compute pool without recrediting its allocation", () => {
    expect(resizeBudget({ ...agent, type: "aeon" }, { ...plan, usage: { agentCount: 7, usedCpu: 24, usedRam: 128 } })).toMatchObject({ ready: true, fixedSize: true, showPool: false, otherCpu: 24, otherRam: 128, cpu: 0.5, ram: 1 });
  });
});
