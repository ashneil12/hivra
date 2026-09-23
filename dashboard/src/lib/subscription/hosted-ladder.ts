// Owner-approved relaunch offer. This is public-site copy, not the billing or
// allocation contract. Managed capacity and billing require separate acceptance.
//
// Nothing here is for sale yet: checkout only knows the plans in PLANS /
// ACTIVE_PLAN_KEYS. The public pricing section shows this ladder as a preview,
// and the billing page shows only the sizes above today's plans, labelled as
// planned. Keep both surfaces reading from this one list.
export const HOSTED_MACHINES = [
  { name: "Starter", price: "$9.99", ram: "4 GB", cpu: "2", storage: "40 GB", computers: "1", windows: false, support: "Standard", body: "One machine, always awake. Enough for an agent that works while you don't." },
  { name: "Pro", price: "$19.99", ram: "8 GB", cpu: "4", storage: "160 GB", computers: "3", windows: true, support: "Standard", body: "Three machines means the coding agent, the research agent and the half-finished experiment all get their own room.", popular: true },
  { name: "Studio", price: "$49", ram: "16 GB", cpu: "8", storage: "320 GB", computers: "Unlimited", windows: true, support: "Priority", body: "Spin one up for a project on Monday. Delete it on Friday. Nobody has to order hardware." },
  { name: "Max", price: "$99", ram: "32 GB", cpu: "12", storage: "640 GB", computers: "Unlimited", windows: true, support: "Priority", body: "For when the job is genuinely big." },
] as const;

export type HostedMachine = (typeof HOSTED_MACHINES)[number];
export type HostedMachineName = HostedMachine["name"];

/**
 * Ladder sizes larger than anything billing sells today. The billing page
 * shows only these as "planned": the smaller public names (Starter, Pro)
 * would collide with billing's own "Pro" plan, which is a different size.
 */
export const PLANNED_HOSTED_MACHINE_NAMES = ["Studio", "Max"] as const satisfies readonly HostedMachineName[];

export function plannedHostedMachines(): HostedMachine[] {
  return HOSTED_MACHINES.filter((machine) =>
    (PLANNED_HOSTED_MACHINE_NAMES as readonly string[]).includes(machine.name)
  );
}
