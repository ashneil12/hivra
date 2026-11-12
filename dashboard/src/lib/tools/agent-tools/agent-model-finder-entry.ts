// Catalog entry for the free and cheap models finder. Type-only import from ../tool-catalog,
// because tool-catalog imports the entries and a value import would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import { MONEY_BACK_GUARANTEE, formatPlanSize } from "@/lib/blog/plan-facts";
import {
  FINDER_DEFAULTS,
  FINDER_ROWS,
  HIVRA_CATALOG_COUNT,
  HIVRA_LEFT_OUT_COUNT,
  MODEL_FINDER_FACTS,
  buildSummary,
  costPerDayUsd,
  formatPrice,
  formatTokenCount,
  tokensPerDay,
  type FinderState,
} from "./agent-model-finder";
import { USAGE_PRESETS } from "./agent-running-cost";

/** The worked examples. Their `command` is what the tool prints for these filters. */
export const MODEL_FINDER_EXAMPLE_STATES: Record<"freeLongContext" | "privateReasoning" | "cheapPaid", FinderState> = {
  freeLongContext: { ...FINDER_DEFAULTS, price: "free", minContext: "200k", usage: "light" },
  privateReasoning: { ...FINDER_DEFAULTS, privateOnly: true, reasoningOnly: true, minContext: "128k" },
  cheapPaid: { ...FINDER_DEFAULTS, price: "paid", where: "openrouter", minContext: "128k", reasoningOnly: true },
};

const limits = MODEL_FINDER_FACTS.freeModels;
const hivraCount = FINDER_ROWS.filter((row) => row.where === "hivra").length;
const openRouterCount = FINDER_ROWS.length - hivraCount;
const freeCount = FINDER_ROWS.filter((row) => row.free).length;
const privateCount = FINDER_ROWS.filter((row) => row.isPrivate).length;
const typicalTokens = tokensPerDay("typical");
const flash = FINDER_ROWS.find((row) => row.key === "hivra:deepseek-v4-1-flash");
const flashDay = flash ? costPerDayUsd(flash, "typical") : 0;

export const AGENT_MODEL_FINDER_ENTRY: ToolEntry = {
  slug: "best-free-models-for-ai-agents",
  name: "Free and Cheap Models for AI Agents",
  h1: "Which free or cheap model can your AI agent run on?",
  subhead: "Filter models that accept tool calls by price, context, privacy and reasoning, and see what one agent-day costs at list price.",
  metaTitle: "Free and Cheap Models for AI Agents, Compared",
  browserTitle: "Free and Cheap Models for AI Agents, Compared | Hivra",
  metaDescription:
    "Compare free and cheap LLM API models that accept tool calls, for OpenClaw, Hermes or any agent. Filter by price, context and privacy, in your browser.",
  intro: {
    lede: `An agent does not just chat. It calls tools, so the model has to support tool calls, and it re-reads a long context on every step. This table lists ${FINDER_ROWS.length} models that accept tool calls, ${freeCount} of them free, with list prices, context windows and an estimated cost for one day of agent work.`,
    body: [
      `Two dated lists feed it: ${hivraCount} models from Hivra's managed inference list and ${openRouterCount} from OpenRouter. Filter to free only, to private models, to a minimum context, to reasoning models or to image input. Sort by input price, output price, context or estimated cost per agent-day. The "Where" column says which list a row came from.`,
      "We do not call any model the best one. Nothing here measures how well a model plans, recovers from a failed tool call or follows instructions, and those are the things that decide whether an agent works. The sorts use numbers we can state: a price, a context size and a token assumption. The method below says how to choose from there.",
    ],
    note: "Free models are rate limited and can change, so check before you build on one. A cheap model that fails tool calls can cost more in retries than it saves. Nothing you enter leaves your browser.",
  },
  faqs: [
    {
      q: "What are the best free models on OpenRouter for an agent?",
      a: `We do not rank them, because nothing here measures quality. This tool lists the ${freeCount} free OpenRouter models that accept tool calls, with their context windows, and you can sort and filter them. Pick on what your agent needs: tool-call support is a given in this list, then context size, reasoning and image input. Then test two or three on a real task. OpenRouter's own free-models page ranks by how many tokens people send, which measures use, not quality.`,
    },
    {
      q: "Is there a free LLM API?",
      a: `Yes, with limits. OpenRouter's free variants, whose IDs end in :free, cost $0. OpenRouter's own page says they are capped at ${limits.requestsPerMinute} requests a minute and ${limits.requestsPerDayBase} a day, rising to ${limits.requestsPerDayAfterCredits.toLocaleString("en-US")} a day after you buy $${limits.creditsUsd} of credits, and failed attempts count toward the daily cap. An agent makes several requests per message, so ${limits.requestsPerDayBase} a day goes quickly. Free is good for learning and light use, not for something you rely on.`,
    },
    {
      q: "What is the best model for Hermes Agent?",
      a: `We cannot name one, and we would distrust a page that did. Hermes Agent works with the provider you choose: its README lists Nous Portal, OpenRouter, OpenAI and your own endpoint, and you switch with the hermes model command. On a Hivra computer, Hermes starts on DeepSeek V4.1 Flash, which is listed here at $${flash ? flash.inputUsdPerM.toFixed(2) : "0.30"} per million input tokens and $${flash ? flash.outputUsdPerM.toFixed(2) : "1.20"} per million output tokens. That is a default, not a verdict. Filter this table by context and tool support, then test on your own tasks.`,
    },
    {
      q: "What is the best model for OpenClaw?",
      a: "There is no measured answer here. OpenClaw's README says models and agent harnesses are plugins you can swap without changing anything else, and it works with hosted and local providers. That makes it cheap to try more than one. Start from the filters: a model that supports tool calls, enough context for your files and tools, and a price you can live with. Run the same task on two or three and keep the one that finishes it without retries.",
    },
    {
      q: "Why not just use the cheapest model?",
      a: `Because a cheap model that fails tool calls costs more than it saves. If a model needs two attempts where another needs one, its real price per finished task is double. At the typical assumption of ${formatTokenCount(typicalTokens)} tokens a day, a model that lists at $0.10 a day but needs every step twice costs the same as one that lists at $0.20 and gets it right the first time. Those two prices are made up to show the arithmetic. Price is a starting filter, not the answer. Test on a real task before you commit.`,
    },
    {
      q: "Can free models disappear or change?",
      a: `Yes, plan for it. OpenRouter's free-models page tells you to set the model to ${limits.routerId} if you do not want to track which free models are currently available, which tells you the set moves. Our list is a copy from ${MODEL_FINDER_FACTS.openRouterSnapshotDate} and will age. Check the model's own page on OpenRouter before you build on it, and keep a paid fallback you have already tested.`,
    },
    {
      q: "Which models here are private?",
      a: `${privateCount} of the ${FINDER_ROWS.length} rows are marked private. That label is the one in Hivra's managed inference catalog, set to private or end-to-end private by the model provider. It is a provider label, not a guarantee we have audited. OpenRouter rows are never marked private here, because we did not record each provider's data policy. If privacy matters, read the provider's own terms.`,
    },
    {
      q: "Are the models on Hivra free?",
      a: `No. Hivra charges for the computer, ${formatPlanSize("entry")} or ${formatPlanSize("larger")}, and the plan does not include AI usage. Models in the Hivra rows are priced at the managed inference list prices in the table. Hermes on Hivra defaults to DeepSeek V4.1 Flash through Hivra's managed inference, or your own Venice key. There is a ${MONEY_BACK_GUARANTEE}. Free here means this tool is free, and the OpenRouter free variants.`,
    },
  ],
  faqCode: ["hermes model", ":free", "openrouter/free"],
  relatedLinks: [
    { href: "/agents/hermes", label: "Run Hermes on Hivra" },
    { href: "/agents/openclaw", label: "Run OpenClaw on Hivra" },
    { href: "/tools/ai-agent-hosting-cost-calculator", label: "AI agent hosting cost calculator" },
    { href: "/tools/agent-survival-check", label: "Agent survival check" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "agent-model-finder",
  primaryKeyword: "free llm api",
  vendors: ["OpenRouter", "Nous Research", "OpenClaw"],
  method: {
    heading: "How this table is built, and how to choose",
    lastVerified: MODEL_FINDER_FACTS.lastVerified,
    paragraphs: [
      {
        text: `Two datasets, each with its own date. Hivra's managed inference list was updated ${MODEL_FINDER_FACTS.hivraCatalogUpdatedAt}, with prices stored in micro-USD per million tokens and shown here in USD. OpenRouter prices are list prices from a copy taken ${MODEL_FINDER_FACTS.openRouterSnapshotDate}, before any provider discount or credit fee, for models that accept tool calls and return text. Prices change, so check the provider before you commit.`,
        sources: [{ label: "OpenRouter models", url: MODEL_FINDER_FACTS.sources[0] }],
      },
      {
        text: `Only models that accept tool calls are shown, because an agent needs them. Hivra's catalog does not record that, so we read the model provider's public models list on ${MODEL_FINDER_FACTS.lastVerified} for tool-call, reasoning and image flags. ${HIVRA_LEFT_OUT_COUNT} of the ${HIVRA_CATALOG_COUNT} Hivra models are left out because that list did not confirm tool calls for them or did not return them. That is a gap in our check, not a verdict on those models.`,
        sources: [{ label: "Provider models list", url: MODEL_FINDER_FACTS.capabilitySource }],
      },
      {
        text: `Estimated cost per agent-day = tokens a day, split 85% input and 15% output, times the model's per-million prices. The token counts are our assumptions, not measurements: light is ${USAGE_PRESETS.light.plain}, typical is ${USAGE_PRESETS.typical.plain} and heavy is ${USAGE_PRESETS.heavy.plain}. Agents re-send instructions and tool output on every step, so one message moves far more tokens than its text. Prompt caching is not modelled, so a model that caches repeated input will cost less than shown, and one that retries will cost more.`,
      },
      {
        text: `Free models. OpenRouter's free-models page says free variants (IDs ending in :free) are capped at ${limits.requestsPerMinute} requests a minute and ${limits.requestsPerDayBase} a day, or ${limits.requestsPerDayAfterCredits.toLocaleString("en-US")} a day once you have bought $${limits.creditsUsd} of credits, and that failed attempts count. It also says other $0 models skip those caps but can hit their own limits. We could not find a promise from OpenRouter that a free model stays free, so treat each one as something that can change.`,
        sources: [
          { label: "OpenRouter free models", url: limits.source },
          { label: "OpenRouter rate limits", url: limits.limitsSource },
        ],
      },
      {
        text: "How to choose. First, make sure the model supports tool calls: every row here does. Second, check the context window against what your agent reads, such as long files, many tools and a long history. Third, decide if you need reasoning or image input and filter for them. Fourth, decide whether privacy matters and read the provider's terms, since the private label is only a label. Fifth, sort by estimated cost and take two or three candidates, not one. Sixth, run the same real task on each and count retries and failures. The one that finishes the task without retries is cheaper than a lower list price that does not.",
      },
      {
        text: "On the agents. Hermes Agent's README says you can use any model provider and switch with the hermes model command. OpenClaw's README says its models are plugins you can swap. We could not verify a minimum context window or a recommended model from either project, so the context filter is yours to set, and nothing here is a Hermes or OpenClaw recommendation.",
        sources: [
          { label: "Hermes Agent on GitHub", url: MODEL_FINDER_FACTS.sources[4] },
          { label: "OpenClaw on GitHub", url: MODEL_FINDER_FACTS.sources[5] },
        ],
      },
    ],
  },
  examples: [
    {
      title: "A free model with a long context",
      inputs: "Free only, 200K context or more, light use.",
      command: buildSummary(MODEL_FINDER_EXAMPLE_STATES.freeLongContext),
      result: `These are OpenRouter's free models, and they share a cap of ${limits.requestsPerDayBase} requests a day until you buy credits. Fine for learning how an agent behaves, thin for anything you rely on.`,
    },
    {
      title: "A private model with reasoning",
      inputs: "Private only, reasoning models only, 128K context or more, typical use.",
      command: buildSummary(MODEL_FINDER_EXAMPLE_STATES.privateReasoning),
      result: "Private rows are Hivra managed inference, so this is a short list of paid models. The label comes from the provider. Read its terms if privacy decides the choice.",
    },
    {
      title: "A cheap paid model from OpenRouter",
      inputs: "Paid only, OpenRouter only, reasoning models only, 128K context or more, typical use.",
      command: buildSummary(MODEL_FINDER_EXAMPLE_STATES.cheapPaid),
      result: `The cheapest paid row is a starting point, not a pick. Test it on a real task before you trust it. For scale, DeepSeek V4.1 Flash on Hivra lists at about ${formatPrice(flashDay)} a day at typical use.`,
    },
  ],
};
