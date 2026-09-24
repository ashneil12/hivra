// Copy for /pricing, read from checkout's plans so the page moves with billing.
//
// /pricing states only what can be bought today: free self-hosting and the two
// hosted sizes checkout sells, by price and size. The owner's proposed ladder
// (lib/subscription/hosted-ladder.ts) stays a labelled preview on the homepage;
// its planned perks are not shipped, so they are never repeated here. Plans are
// described by price and size, never by name, because checkout's names collide
// with the ladder's (see lib/blog/plan-facts.ts).

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { PLANS } from "@/lib/subscription/plans";

export const PRICING_TITLE = "Pricing: self-host free, hosted from $9.99";
export const PRICING_DESCRIPTION = `Self-host Hivra for free, or let Hivra run the computer from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. ${MONEY_BACK_GUARANTEE}.`;

export const SELF_HOST_SOURCE_URL = "https://github.com/ashneil12/hivra";

export interface HostedSize {
  planKey: "operator" | "fleet";
  price: string;
  cpu: number;
  ramGb: number;
  body: string;
  /** Carries this paid plan through checkout (lib/public-start.ts allows it). */
  href: string;
}

function hostedSize(planKey: HostedSize["planKey"], price: string, body: string): HostedSize {
  const plan = PLANS[planKey];
  return { planKey, price, cpu: plan.totalCpu, ramGb: plan.totalRam / 1024, body, href: `/get-started?plan=${planKey}` };
}

export const HOSTED_SIZES: HostedSize[] = [
  hostedSize("operator", ENTRY_PLAN_PRICE, "Hivra runs the computer for you. It stays on and is not paused for inactivity."),
  hostedSize("fleet", LARGER_PLAN_PRICE, "The same, with twice the CPU and memory for bigger builds and heavier workloads."),
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "How much does Hivra cost?",
    a: `Self-hosting the platform is free. If you want Hivra to run the computer for you, paid plans are ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`,
  },
  {
    q: "Can I self-host Hivra for free?",
    a: "Yes. Hivra's source is public under the Apache-2.0 license at github.com/ashneil12/hivra, and self-hosting is available as a preview for a single operator. You provide the server and pay for it, and for model usage, yourself.",
  },
  {
    q: "Is a hosted computer paused when I am not using it?",
    a: "No. Paid plans stay on and are not paused for inactivity, and the computer keeps its files, sessions and login.",
  },
  {
    q: "Can I use my own model key or login?",
    a: "Yes. Bring your own model API key, or sign in with your own account for Claude Code and Codex. Usage on your own key or login is billed by the model provider.",
  },
  {
    q: "Is there a money-back guarantee?",
    a: `Yes. Paid plans come with a ${MONEY_BACK_GUARANTEE}.`,
  },
];
