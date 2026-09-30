import { PLANNED_HOSTED_MACHINE_NAMES, plannedHostedMachines } from "../hosted-ladder";
import { ACTIVE_PLAN_KEYS, PLANS } from "../plans";

describe("hosted ladder", () => {
  it("marks only the sizes above today's plans as planned for billing", () => {
    expect(plannedHostedMachines().map((machine) => machine.name)).toEqual([...PLANNED_HOSTED_MACHINE_NAMES]);
    expect(plannedHostedMachines().map((machine) => [machine.cpu, machine.ram, machine.price])).toEqual([
      ["8", "16 GB", "$49"],
      ["12", "32 GB", "$99"],
    ]);
  });

  it("never shares a name with a plan billing sells", () => {
    const soldNames = ACTIVE_PLAN_KEYS.map((key) => PLANS[key].name);
    for (const machine of plannedHostedMachines()) {
      expect(soldNames).not.toContain(machine.name);
    }
  });
});
