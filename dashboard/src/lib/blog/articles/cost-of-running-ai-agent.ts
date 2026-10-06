import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
export const article: BlogArticle = {
  slug: "cost-of-running-ai-agent",
  title: "The real cost of running a persistent AI agent in 2026",
  metaTitle: "The real cost of running an AI agent in 2026",
  metaDescription:
    "What it costs to keep an AI agent running around the clock: server, API tokens and your time, with real monthly figures for self-hosted and managed setups.",
  publishedDate: "2026-04-01",
  lastModified: "2026-10-05",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "What the monthly bill adds up to.",
  intro:
    "An agent that runs all the time costs more than the price on the plan. Here's each piece with a real figure: the server, the tokens, your time, and the bits no pricing table mentions.",
  shortAnswer: `Running a persistent AI agent costs you a server, AI tokens and your time. A minimal self-hosted setup is about $10-17 a month in cash, or $60-117 once you count maintenance at $50 an hour. Hivra is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, plus about $4-20 in tokens.`,
  sections: [
    {
      heading: "What does the server cost?",
      paragraphs: [
        "Somewhere between €5 and $24 a month for a rented server, because the agent needs a machine that stays on. You can rent a VPS, pay a managed host, or run it on hardware you already own.",
        `VPS prices as of September 2026 (Hetzner last changed its CX prices on 15 June 2026): Hetzner CX23 (2 vCPU, 4 GB RAM) costs €5.49/month excluding VAT. DigitalOcean's comparable Basic Droplet is $24/month. OVH's entry VPS-1 (2 vCPU, 4 GB) is about $4.54/month on annual billing. Hetzner and OVH are cheap, and every bit of setup and upkeep is yours. Need more room? The Hetzner CX33 (4 vCPU, 8 GB RAM) at €8.49/month is the next step up, and worth it if your agent uses the browser a lot.\n\nManaged hosting: [Hivra](/pricing) plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}. Paid plans are not paused for inactivity and come with a ${MONEY_BACK_GUARANTEE}. You pay for hosting, with no markup on AI usage through your own keys or logins. In return the setup's done and there's no server to maintain. To compare a specific setup against a raw VPS, run your numbers through the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator).`,
      ],
    },
    {
      heading: "What do the AI tokens cost?",
      paragraphs: [
        "Anthropic's prices as of October 2026, from [its pricing page](https://platform.claude.com/docs/en/about-claude/pricing) (they move, so check): Claude Haiku 4.5 ($1 input / $5 output per MTok); Claude Sonnet 5.5 ($2 / $10 per MTok, with the 1M-token context window at standard pricing); Claude Opus 5.5 ($4 / $20 per MTok, also with the 1M-token window at standard pricing). OpenAI, as of April 2026: GPT-5 mini ($0.25 / $2 per MTok, the cheapest capable option at the time). The Anthropic Batch API cuts Anthropic rates by 50% for async workloads, so Haiku 4.5 drops to $0.50/$2.50 per MTok. The monthly ranges below were worked out at April 2026 prices and have not been recalculated.",
        "In practice? A lean setup (10 to 15 scheduled tasks a day, a few URLs each, text output on Haiku 4.5) usually spends $3 to $8 a month. Mixed Haiku/Sonnet workloads with research and code generation run $20-50/month. Heavy Sonnet usage with long context tasks can push $60-120/month.",
        "Browser work is where tokens pile up, because screenshots and page captures are big. A task taking 10 screenshots at ~1,000 tokens each, running daily, costs roughly 300,000 tokens per month just for screenshot processing. If your agent browses a lot, put the screenshot steps on Haiku and save Sonnet for the thinking. [Which browser automation tool you pick](/blog/ai-agent-browser-automation-tools) changes that number too, because they differ in how much of the page they send to the model.",
        "Picking the model is the obvious lever. It isn't the only one. Prompt caching, batching and trimming what you resend each turn often save more than switching models. [What an AI agent costs per month in API tokens](/blog/ai-agent-api-cost-optimization) has a monthly table with the sums shown, plus those cuts.",
      ],
    },
    {
      heading: "Do Claude Code and Codex cost extra to run in the cloud?",
      paragraphs: [
        "Not if you already pay for Claude or ChatGPT. Both run on Hivra with their official CLIs and sign in with the subscription you already have. [Claude Code](/agents/claude-code) uses your Anthropic account login. [Codex](/agents/codex) uses your ChatGPT login. No API key, no per-token bill, and no Hivra markup on AI usage. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
        `So the extra AI cost of running them in the cloud is $0 while they stay inside the subscription's limits. Your only new cost is hosting, from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. To check whether your Claude plan covers the usage you have in mind, run the numbers in the [Claude Code plan calculator](/tools/claude-code-plan-calculator). For which Claude plan that usage needs, and when API billing is the cheaper way to pay, see [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code). If your ChatGPT plan lists Codex cloud, OpenAI's pricing page says cloud chats and local messages share one allowance. A computer that stays on adds a hosting bill, not a second Codex allowance. The side by side is in the [Codex cloud guide](/blog/run-codex-24-7-in-the-cloud).`,
      ],
    },
    {
      heading: "How much of my time does a self-hosted agent take?",
      paragraphs: [
        "More than people budget for. Setup takes 4 to 8 hours if you know Linux. After that it's at least 1 to 2 hours a month on updates, logs and odd failures. When something properly breaks (a Docker update clashes with something, or an API change breaks a tool the agent relies on), add another 2 to 6 hours.",
        "At $50 an hour, 2 hours a month is $100 a month. That's more than the server. Whether self-hosting pays depends on what your time is worth and whether you enjoy the work. Either way, count the maintenance before you compare.",
      ],
    },
    {
      heading: "So what does it all add up to?",
      paragraphs: [
        `| Setup | What's in it | Cash per month | With your time at $50/hour |\n|---|---|---|---|\n| Self-hosted, minimal | Hetzner CX23 (€5.49 before VAT), $3 to $10 of Haiku tokens on text-only tasks, 1 to 2 hours of upkeep | $10 to $17 | $60 to $117 |\n| Self-hosted, active | Hetzner CX33 (€8.49 before VAT), $20 to $50 of mixed Haiku and Sonnet with some browser work, 2 to 3 hours of upkeep | $30 to $60 | $130 to $210 |\n| Hivra, ${ENTRY_PLAN_PRICE} plan | ${ENTRY_PLAN_SIZE}, $4 to $20 of tokens, no server upkeep | $14 to $30 | $14 to $30 |\n\nServerless (Modal or Daytona) sits off to one side. It costs almost nothing while idle and you pay per run, so it suits agents with rare but heavy jobs. Cold starts make it a poor fit for cron jobs that must fire every minute. Full plan details are on [the pricing page](/pricing).`,
        "Count your time and managed hosting looks a lot better than the sticker prices suggest. Still, if you want root access or have strict rules about where data lives, self-hosting on Hetzner is a perfectly good choice. The hardware is solid and the self-hosted Hermes community is active.",
      ],
    },
    {
      heading: "What costs don't show up on any pricing page?",
      paragraphs: [
        "A domain, for a start. Self-hosted setups need one for HTTPS, at $10 to $15 a year. On Hivra you reach the agent through the dashboard, so you don't.",
        "Backups. If you want your agent's memory to survive a dead server, keep a copy somewhere else. S3-compatible storage runs about $0.02 per GB a month, and a healthy memory store is 50 to 500 MB, so a few dollars at most. Hivra does not guarantee backups either, so keep your own off-host copy there too.",
        "Mistakes. A badly set-up agent, or one that hits a weird edge case, can burn tokens fast. Put a monthly spend cap on your API key (most providers have one) and check it weekly while a new task beds in.",
        "And recovery. If a self-hosted server dies and you have no restore plan, rebuilding from scratch is another 4 to 8 hours. Not every month. But it happens.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the absolute cheapest way to run a Hermes agent?",
      a: `A Hetzner CX23 at €5.49/month, Claude Haiku as the model, and text-only tasks (browser work is what blows up token use). That's $10 to $17 a month if you're happy doing the setup yourself. Or skip the setup on Hivra, from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can I run a Hermes agent for free?",
      a: "Not for long. Some providers have small free API tiers (the terms change, so check), and they're fine for poking around. They run out fast once you schedule real tasks. A setup you can keep running costs at least $8 to $15 a month, server and tokens included.",
    },
    {
      q: "How does pricing change as I add more agents?",
      a: `Hivra plans are priced by compute: ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE}/month for ${LARGER_PLAN_SIZE}, split across your agents. Each agent gets its own VM, so running more or bigger agents means moving up a plan, not a per-agent surcharge. API costs scale separately with usage: more agents running more tasks means more tokens.`,
    },
  ],
  relatedArticles: [
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means" },
    {
      slug: "ai-agent-api-cost-optimization",
      title: "What an AI agent costs per month in API tokens (2026)",
    },
    {
      slug: "multi-agent-systems-explained",
      title: "Multi-agent AI systems in 2026: how they're built, what they cost, and when they're worth it",
    },
    { slug: "hermes-agent-vs-chatgpt", title: "Hermes Agent vs ChatGPT" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
    { slug: "ai-agent-hosting-alternatives", title: "All AI agent hosting options" },
    { slug: "vs-agent-37", title: "Hivra vs Agent 37" },
    { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
    { slug: "vs-xcloud", title: "Hivra vs xCloud" },
  ],
};
