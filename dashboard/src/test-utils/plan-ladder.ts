import type { PlanLadderConfig } from "@/lib/subscription/plan-ladder";

const entry = {
  name: "Pro",
  monthlyCents: 1299,
  monthlyPriceId: "price_testPro",
  yearlyCents: 9900,
  yearlyPriceId: "price_testProYear",
  agents: 4,
  alwaysOn: 2,
  agentCpu: 2,
  agentRamMb: 4096,
  aiAllowanceCents: 500,
  features: [],
};

export const testPlanLadder = {
  plans: {
    operator: entry,
    fleet: { ...entry, name: "Power", monthlyPriceId: "price_testPower", yearlyPriceId: "price_testPowerYear" },
    command: { ...entry, name: "Command", monthlyPriceId: "price_testCommand", yearlyPriceId: "price_testCommandYear" },
  },
  freeName: "Free",
} satisfies PlanLadderConfig;
