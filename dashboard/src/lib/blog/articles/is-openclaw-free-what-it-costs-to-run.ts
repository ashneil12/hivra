import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

// Written 2026-10-14 for "is openclaw free" (590 US searches a month, KD 18, Aug 2026 data),
// with "openclaw pricing" (260) and "openclaw cost" (140) folded into the same page. Demand
// is down about 85% from a March peak, so the page stays short on purpose.
//
// Facts read 14 October 2026 (research log only; reader copy carries one "as of October 2026"
// stamp, never a day stamp):
// - https://github.com/openclaw/openclaw/blob/main/LICENSE : MIT, copyright OpenClaw Foundation, free of charge
// - https://docs.openclaw.ai : "Self-hosted: runs on your hardware, your rules" and "Open source: MIT licensed";
//   "You also need an API key from your chosen provider"
// - https://docs.openclaw.ai/install/raspberry-pi : minimum 1 GB RAM, 1 core, 500 MB disk; recommended 2 GB+ RAM;
//   "typical hardware cost is $35-80 one-time, no monthly fees" for a Pi; models run in the cloud via API
// - https://docs.openclaw.ai/help/faq-first-run/quick-start : "No. Run OpenClaw with API keys
//   (Anthropic/OpenAI/others) or local-only models so your data stays on your device. Subscriptions
//   (Claude Pro/Max, ChatGPT/Codex) are optional ways to authenticate those providers."
// - https://platform.claude.com/docs/en/api/rate-limits : spend limits, set your own limit below the tier cap
//   under Settings > Billing
// - https://developers.openai.com/api/docs/guides/spend-limits : hard spend limit returns 429 once reached
//
// Left out on purpose: managed-host prices (Hostinger, ClawHost and the rest were not re-read this run, so the
// table says "the host's plan" rather than a dollar figure), and any OpenClaw-level spend cap (issue #38248 was
// closed as not planned and points at an open request, so the page never claims OpenClaw itself can cap spend).

const AS_OF = "October 2026";

export const article: BlogArticle = {
  slug: "is-openclaw-free-what-it-costs-to-run",
  title: "Is OpenClaw free? What it costs to run",
  metaTitle: "Is OpenClaw free? What it costs to run",
  metaDescription:
    "OpenClaw is free MIT software. You pay for the machine it runs on and the model it calls. Routes, prices, and a spend cap you can set today.",
  publishedDate: "2026-10-14",
  lastModified: "2026-10-14",
  readingTimeMin: 6,
  author: "Hivra team",
  tagline: "The software costs nothing. The machine and the model don't.",
  intro:
    "OpenClaw is free to download and free to run. The bill shows up next to it: a computer that stays on, and a model provider that charges per use.",
  shortAnswer: `OpenClaw is free open-source software under the MIT licence, as of ${AS_OF}. Downloading and running it costs $0. You pay for the machine it sits on, from a $35 Raspberry Pi up, and for the model it calls, billed to your own account. A spend cap at the model provider is the one limit that stops a surprise bill.`,
  sections: [
    {
      heading: "Is the OpenClaw software free?",
      paragraphs: [
        "Yes. The OpenClaw repository carries an [MIT licence](https://github.com/openclaw/openclaw/blob/main/LICENSE) from the OpenClaw Foundation, which grants anyone permission to use, copy and modify the software free of charge. Nothing on that licence charges you for running it.",
        "OpenClaw's own docs describe it as a self-hosted gateway: it runs on hardware you control, and you bring an API key from a model provider. So \"free\" applies to the program. It never applied to the two things the program needs in order to answer you.",
      ],
    },
    {
      heading: "What do you actually pay for?",
      paragraphs: [
        "Two bills, and they don't come from OpenClaw.",
        "The machine. The gateway has to stay running or the agent goes quiet. OpenClaw's Raspberry Pi guide sets the floor at 1 GB of RAM, one core and 500 MB of disk, and recommends 2 GB or more. It also quotes typical Pi hardware at $35 to $80 once, with no monthly fee, because the Pi only runs the gateway and the models stay in the cloud. That floor is the project's own number, not a hosting minimum.",
        "The model. OpenClaw's first-run FAQ says to run it with API keys from Anthropic, OpenAI or others, or with local models. A Claude or ChatGPT subscription is an optional way to sign in to those providers, and it still draws from that plan's own limits. Local models move the cost into hardware instead: OpenClaw's local-model guide starts its smallest recipe at 8 GB of memory, so a machine that small is a different purchase.",
      ],
    },
    {
      heading: "What does each way of running it cost?",
      paragraphs: [
        `Prices below are the ones we can stand behind as of ${AS_OF}. Managed hosts change their numbers often, so the table names the route and leaves their price on their own page.`,
        [
          "| Route | What you pay | What you take on |",
          "|---|---|---|",
          "| Laptop | $0 extra if you already own it | Stops when the lid closes or the machine sleeps |",
          "| Raspberry Pi | $35 to $80 once, no monthly fee (OpenClaw's own figure) | You power it, update it and keep the SD card alive |",
          "| Rented VPS | A small monthly server bill, yours to pick | You install OpenClaw, patch it and watch it |",
          "| A managed host | Whatever that host charges | The host runs the computer; you still bring the model |",
          `| Hivra | ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} | OpenClaw needs a paid plan at that size |`,
        ].join("\n"),
        "On every row except a local model, the model bill sits on top and goes to your provider, not to the host.",
        "A rented server is the cheapest ongoing route if you like running Linux. It is the wrong pick if you don't want a second machine to babysit, because updates and odd failures land on you. The [OpenClaw self-hosting guide](/blog/how-to-self-host-openclaw) covers the install itself, and the [OpenClaw alternative page](/features/openclaw-alternative) puts the hosted route next to switching the agent.",
      ],
    },
    {
      heading: "Why does the model bill surprise people?",
      paragraphs: [
        "The machine price is fixed. The model price isn't, and nothing in OpenClaw stops it climbing.",
        "One reported case, from an OpenClaw user on [GitHub issue 38248](https://github.com/openclaw/openclaw/issues/38248), shows how. Their primary model hit a rate limit and the fallback chain retried the whole conversation on pricier models, 6,000 requests and a reported $169 in one session. That's one person's setup, not a typical bill, and the issue was closed as not planned. It does show the shape of the problem: retries resend the full context, and each retry costs more than the last.",
        "OpenClaw doesn't ship a spend ceiling of its own. The limit that holds is the one at the provider, set before you leave the agent running.",
      ],
    },
    {
      heading: "How do you cap the bill?",
      paragraphs: [
        "Set the cap where the money leaves, which is the model account. Both major providers let you do this, and it applies wherever OpenClaw runs.",
        "Anthropic: Claude Console, Settings, Billing, Spend limits. You set your own monthly limit below your tier's cap. Hitting the limit you set stops further requests until you raise it or the month rolls over.",
        "OpenAI: Organization limits, Spend, Edit spend limit, and turn on \"Enforce a hard limit\". Past that amount, API requests come back with a 429 error instead of running. An alert alone only emails you, so the traffic keeps going.",
        "Do this before the first overnight run, not after. A cap you set tomorrow doesn't unwind what ran last night.",
        "One thing a host cannot do: cap spending on a key you brought yourself. On Hivra your OpenClaw requests bill your own provider account, with no markup on that usage. The cap lives in your Anthropic or OpenAI settings, and Hivra never sees it.",
      ],
    },
    {
      heading: "What does OpenClaw cost on Hivra?",
      paragraphs: [
        `OpenClaw needs a paid plan. ${ENTRY_PLAN_PRICE} a month gets you ${ENTRY_PLAN_SIZE}, and that covers OpenClaw with the live browser switched on. OpenClaw on its own needs 1 vCPU and 2 GB, and the browser adds 1 vCPU and 2 GB more. Paid plans aren't paused for inactivity, and card payments come with a ${MONEY_BACK_GUARANTEE}.`,
        "The model is still yours. You pick the provider in the Control UI and that account gets the bill.",
        "Hivra isn't always the right route. A Pi you already have is cheaper once you've bought it, and it keeps the data at home. A VPS is cheaper hardware if you want root and don't mind the upkeep. And if OpenClaw itself isn't the agent you want, the [Hermes and OpenClaw comparison](/blog/hermes-vs-openclaw) says where each fits.",
        "Hivra is independent and isn't affiliated with the OpenClaw project.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is OpenClaw free?",
      a: `Yes. OpenClaw is MIT-licensed software from the OpenClaw Foundation, free of charge to download and run, as of ${AS_OF}. You pay separately for the computer it runs on and the model it calls.`,
    },
    {
      q: "Does OpenClaw cost money to use?",
      a: "The program doesn't. A model provider does, unless you run a local model, and even then you paid for the hardware. A Claude or ChatGPT subscription is one way to sign in, and it draws from that plan's own limits.",
    },
    {
      q: "How much RAM does OpenClaw need?",
      a: "OpenClaw's Raspberry Pi guide sets a minimum of 1 GB of RAM, one core and 500 MB of disk, and recommends 2 GB or more for the gateway. Running models locally is a different machine: the local-model guide starts at 8 GB.",
    },
    {
      q: "How much does it cost to run OpenClaw on Hivra?",
      a: `OpenClaw needs a paid plan, ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. That size covers OpenClaw with the live browser on. Model usage bills your own provider account, and Hivra adds no markup on it. Card payments come with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can OpenClaw limit how much I spend on the model?",
      a: "Not by itself. Set a spend limit in the model account: Anthropic under Settings, Billing, Spend limits, and OpenAI under Organization limits with a hard limit enforced. A host that runs OpenClaw on your own key can't set that cap for you.",
    },
    {
      q: "Is running OpenClaw on a Raspberry Pi really free?",
      a: "The hardware is a one-off $35 to $80 by OpenClaw's own guide, with no monthly fee, and the gateway runs fine there because the models stay in the cloud. The model calls still bill your provider account.",
    },
    {
      q: "Is there a free hosted plan for OpenClaw?",
      a: "Not on Hivra. OpenClaw needs a paid plan, from $9.99 a month. A machine you already own, or a Pi you buy outright, is the route with no monthly hosting bill.",
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "hermes-vs-openclaw", title: "Hermes vs OpenClaw" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means" },
  ],
};
