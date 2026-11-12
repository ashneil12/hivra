// Catalog entry for the AI agent running cost calculator. Type-only import from ../tool-catalog,
// because tool-catalog imports the entries and a value import would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import { ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE, formatPlanSize } from "@/lib/blog/plan-facts";
import {
  RUNNING_COST_DEFAULTS,
  RUNNING_COST_FACTS,
  USAGE_PRESETS,
  buildSummary,
  computeRunningCost,
  formatUsd,
  type RunningCostInput,
} from "./agent-running-cost";

/** The three worked examples. Their `command` is what the tool prints for these inputs. */
export const RUNNING_COST_EXAMPLE_INPUTS: Record<"freeLaptop" | "vps" | "vpsWithTime", RunningCostInput> = {
  freeLaptop: {
    ...RUNNING_COST_DEFAULTS,
    server: "laptop",
    model: "openrouter:google/gemma-4-31b-it:free",
    usage: "light",
  },
  vps: { ...RUNNING_COST_DEFAULTS, server: "vultr1gb" },
  vpsWithTime: { ...RUNNING_COST_DEFAULTS, countTime: true },
};

const typical = computeRunningCost(RUNNING_COST_DEFAULTS);
const light = computeRunningCost({ ...RUNNING_COST_DEFAULTS, usage: "light" });
const heavy = computeRunningCost({ ...RUNNING_COST_DEFAULTS, usage: "heavy" });
const withTime = computeRunningCost(RUNNING_COST_EXAMPLE_INPUTS.vpsWithTime);
const onHivra = computeRunningCost({ ...RUNNING_COST_DEFAULTS, server: "hivra-entry" });
const limits = RUNNING_COST_FACTS.freeModelLimits;

export const AGENT_RUNNING_COST_ENTRY: ToolEntry = {
  slug: "ai-agent-running-cost-calculator",
  name: "AI Agent Running Cost Calculator",
  h1: "What does it cost to run an OpenClaw or Hermes agent each month?",
  subhead: "Add up the server, the model tokens and, if you want, your own time. See when DIY or a free model is the cheaper answer.",
  metaTitle: "OpenClaw and Hermes Running Cost Calculator",
  browserTitle: "OpenClaw and Hermes Running Cost Calculator | Hivra",
  metaDescription:
    "Estimate what one always-on agent costs a month: the server, the model tokens and your time. For OpenClaw, Hermes or any agent. Free, in your browser.",
  intro: {
    lede: "The software is free. Running it is not. OpenClaw and Hermes Agent are both MIT-licensed, and neither charges you to use it. The bill comes from the machine it runs on and the model it talks to.",
    body: [
      "This calculator splits one always-on agent into three parts: the server, the model tokens and, if you choose to count it, your own time. Pick a laptop you already own, a VPS or a Hivra computer. Pick a model from Hivra's managed inference list or OpenRouter's list prices, including its free models. Then pick how busy the agent is.",
      "The model line is usually the big one. A server is a flat monthly price. Tokens scale with how much the agent does, and an agent that reads files and calls tools moves far more of them than a chat window does. The usage presets are our assumptions, labelled as such. Change them to match your own.",
    ],
    note: "Nothing you enter leaves your browser. The result is an estimate from list prices, not a quote. Your provider's own bill is the one that counts.",
  },
  faqs: [
    {
      q: "Is OpenClaw free?",
      a: "The software is. OpenClaw is open source under the MIT licence, and its own README says it has no paid tier, hosted service or token. Running it still costs money: you pay a model provider for tokens and you need a machine to run it on, even if that machine is a laptop you already own. This calculator adds those two bills up.",
    },
    {
      q: "How much does OpenClaw cost to run each month?",
      a: `It depends on the model and how busy the agent is. On our typical usage assumption (${USAGE_PRESETS.typical.plain}), DeepSeek V4.1 Flash from Hivra's managed inference list costs about ${formatUsd(typical.tokensUsd)} a month in tokens. Add a ${formatUsd(typical.serverUsd)} Hetzner CX23 and the total is about ${formatUsd(typical.totalUsd)}. Light use is about ${formatUsd(light.totalUsd)} and heavy use about ${formatUsd(heavy.totalUsd)} on the same server and model. A free model on a laptop you own is $0 in dollars.`,
    },
    {
      q: "How much does Hermes Agent cost?",
      a: "Hermes Agent is open source under the MIT licence, so the software costs nothing. You choose the model provider, including OpenRouter, OpenAI or your own endpoint, and you pay that provider for tokens. Nous Research also offers an optional Nous Portal subscription that covers models and tools under one plan. We have not verified its price, so check Nous Research's own page before you plan around it. Hermes's own README suggests a $5 VPS as one place to run it.",
    },
    {
      q: "Is Hermes Agent pricing different on Hivra?",
      a: `Hivra charges for the computer, not the software: ${formatPlanSize("entry")}, or ${formatPlanSize("larger")}. Hermes on Hivra is the official Hermes Agent, installed from its own installer. Hermes on Hivra uses Hivra's managed inference by default, or your own Venice key. There is a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "What is the cheapest way to run an AI agent all month?",
      a: `A laptop you already own is the cheapest machine, and a free model takes the token bill to $0. The catch is that a laptop sleeps, and OpenRouter limits its free models to ${limits.requestsPerMinute} requests a minute and ${limits.requestsPerDayUnder10Credits} a day, or ${limits.requestsPerDayWith10Credits.toLocaleString("en-US")} a day after you buy 10 credits. The next step up is a small VPS: ${formatUsd(RUNNING_COST_FACTS.vps.rows.vultr1gb.monthlyUsd)} a month for 1 GB at Vultr's list price. That is cheaper than any managed option, so if you enjoy running servers, do it yourself.`,
    },
    {
      q: "Why is my token bill higher than I expected?",
      a: "One message to an agent is not one model call. The agent re-reads its instructions and the conversation, runs tools and reads their output, and each of those steps sends tokens. A short chat can move tens of thousands. Our presets assume 20,000, 40,000 and 80,000 tokens per message for light, typical and heavy use. They are assumptions, so use the custom fields if you have measured your own.",
    },
    {
      q: "Can I run an agent on a free model?",
      a: `You can, for light use. OpenRouter lists free models, and the calculator prices them at $0. Free models are limited to ${limits.requestsPerMinute} requests a minute and ${limits.requestsPerDayUnder10Credits} a day, or ${limits.requestsPerDayWith10Credits.toLocaleString("en-US")} a day after you buy 10 credits, and one agent message can use several requests. They can also change or be withdrawn. For an agent you depend on, a cheap paid model is usually the safer choice.`,
    },
    {
      q: "When is a VPS cheaper than Hivra?",
      a: `Almost always, in dollars. A same-size VPS lists from ${formatUsd(RUNNING_COST_FACTS.vps.rows.hetznerCx23.monthlyUsd)} a month, against ${formatUsd(onHivra.serverUsd)} for Hivra's entry computer (${ENTRY_PLAN_SIZE}). You pay Hivra for the install and upkeep you skip. Turn on the time option: every hour you spend is billed at your own rate. The tool starts from a guess of ${formatUsd(RUNNING_COST_DEFAULTS.hourlyRate)} an hour, and the hours are ours too, so replace both with yours.`,
    },
  ],
  relatedLinks: [
    { href: "/tools/ai-agent-hosting-cost-calculator", label: "AI agent hosting cost calculator" },
    { href: "/tools/agent-survival-check", label: "Agent survival check" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "agent-running-cost",
  primaryKeyword: "openclaw cost",
  vendors: ["OpenClaw", "Nous Research", "OpenRouter", "Hetzner", "DigitalOcean", "Vultr", "AWS"],
  method: {
    heading: "How this estimate is built",
    lastVerified: RUNNING_COST_FACTS.lastVerified,
    paragraphs: [
      {
        text: "Monthly total = server + model tokens + your time. The server is a flat monthly price. Tokens are messages a day, times tokens per message, times 30 days, split 85% input and 15% output, then priced at the model's per-million rates. Your time is hours a month times your hourly rate, and is off until you turn it on. A Hivra computer counts as 0 hours, which is a simplification: you still configure the agent.",
      },
      {
        text: "The software is free. OpenClaw's README lists an MIT licence and says it has no paid tier, hosted service or token. Hermes Agent's README lists an MIT licence and offers an optional Nous Portal subscription. We have not verified that subscription's price.",
        sources: [
          { label: "OpenClaw on GitHub", url: RUNNING_COST_FACTS.agents.openclaw.source },
          { label: "Hermes Agent on GitHub", url: RUNNING_COST_FACTS.agents.hermes.source },
        ],
      },
      {
        text: `Model prices come from two lists. Hivra's managed inference list was updated on ${RUNNING_COST_FACTS.models.hivraCatalogUpdatedAt}. OpenRouter prices are list prices from a copy taken on ${RUNNING_COST_FACTS.models.openRouterSnapshotDate}, before any provider discount, and cover models that accept tool calls. Neither list models prompt caching, so a model that caches repeated input will cost less than shown. Prices change, so check the provider before you commit.`,
        sources: [
          { label: "OpenRouter models", url: RUNNING_COST_FACTS.models.sources[0] },
          { label: "OpenRouter rate limits", url: RUNNING_COST_FACTS.models.sources[1] },
        ],
      },
      {
        text: "VPS prices are the providers' list prices in USD with a public IPv4 address, before tax, copied from our hosting cost calculator and last checked in September 2026. Hetzner's own page now shows the CX23 in euros as unavailable, so treat that figure as indicative. A laptop is $0 here and electricity is not counted.",
        sources: [
          { label: "Hetzner cost-optimized cloud", url: RUNNING_COST_FACTS.vps.sources[1] },
          { label: "DigitalOcean Droplets pricing", url: RUNNING_COST_FACTS.vps.sources[2] },
          { label: "AWS Lightsail pricing", url: RUNNING_COST_FACTS.vps.sources[4] },
        ],
      },
      {
        text: "The usage presets are our assumptions, not measurements: light is 10 messages a day at 20,000 tokens each, typical is 40 at 40,000 and heavy is 150 at 80,000. Agents re-send context and tool output on every step, which is why a message costs far more tokens than its text suggests. Use the custom option for your own numbers.",
      },
    ],
  },
  examples: [
    {
      title: "A laptop you own and a free model",
      inputs: "A laptop you already own, Google Gemma 4 31B (free, OpenRouter), light usage, time not counted.",
      command: buildSummary(RUNNING_COST_EXAMPLE_INPUTS.freeLaptop),
      result: "The cheapest setup there is, and it is limited. The laptop sleeps, and the free model is rate limited. Good for learning, weak for anything you rely on.",
    },
    {
      title: "A small VPS and a cheap paid model",
      inputs: "Vultr 1 GB VPS, DeepSeek V4.1 Flash, typical usage, time not counted.",
      command: buildSummary(RUNNING_COST_EXAMPLE_INPUTS.vps),
      result: "Tokens, not the server, are most of the bill. Moving to a bigger server would barely change the total. A cheaper model would.",
    },
    {
      title: "The same setup with your time counted",
      inputs: `Hetzner CX23 VPS, DeepSeek V4.1 Flash, typical usage, time counted at the tool's starting values (${formatUsd(RUNNING_COST_DEFAULTS.hourlyRate)} an hour).`,
      command: buildSummary(RUNNING_COST_EXAMPLE_INPUTS.vpsWithTime),
      result: `Counting your hours changes the answer: ${formatUsd(withTime.timeUsd)} of the ${formatUsd(withTime.totalUsd)} is your time. If your hours are free, ignore that line. If not, a managed computer at ${formatUsd(onHivra.totalUsd)} with the same model looks different.`,
    },
  ],
};
