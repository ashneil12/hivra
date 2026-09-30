import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
export const article: BlogArticle = {
  slug: "cost-of-running-ai-agent",
  title: "The real cost of running a persistent AI agent in 2026",
  metaDescription:
    "A breakdown of every cost involved in running a persistent AI agent: server hosting, API tokens, maintenance time, and hidden costs. With specific numbers, not estimates.",
  publishedDate: "2026-04-01",
  lastModified: "2026-09-24",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "Actual numbers, not a pricing page.",
  intro:
    "The full cost of a persistent AI agent is not just the subscription price. Here is every component — server, tokens, time, and the less-obvious costs — with real figures for early 2026.",
  sections: [
    {
      heading: "Server infrastructure",
      paragraphs: [
        "Running a Hermes agent requires a server that stays on. Three paths: rent a VPS, use a managed hosting service, or run it on hardware you own.",
        `VPS pricing as of September 2026 (Hetzner adjusted CX prices on 15 June 2026): Hetzner CX23 (2 vCPU, 4 GB RAM) costs €5.49/month excluding VAT. DigitalOcean's comparable Basic Droplet is $24/month. OVH's entry VPS-1 (2 vCPU, 4 GB) is about $4.54/month on annual billing. Hetzner and OVH are cheap but you handle all configuration and maintenance yourself. For more headroom, the Hetzner CX33 (4 vCPU, 8 GB RAM) at €8.49/month is the step up, useful if your agent does frequent browser automation.\n\nManaged hosting: [Hivra](/pricing) plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}. Paid plans are not paused for inactivity and come with a ${MONEY_BACK_GUARANTEE}. You pay for hosting, with zero markup on AI usage through your own keys or logins, and in exchange you get configuration already done and no server maintenance on your side. To compare a specific setup against a raw VPS, run your numbers through the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator).`,
      ],
    },
    {
      heading: "AI provider tokens",
      paragraphs: [
        "Token prices as of April 2026 (check provider pages — these move frequently): Claude Haiku 4.5 ($1 input / $5 output per MTok); Claude Sonnet 4.6 ($3 / $15 per MTok, now with 1M token context at no surcharge); Claude Opus 4.6 ($5 / $25 per MTok, 1M context, 128K max output); GPT-5 mini ($0.25 / $2 per MTok — cheapest capable option currently available). The Anthropic Batch API cuts Haiku 4.5 to $0.50/$2.50 per MTok for async workloads.",
        "What does this cost in practice? For a lean setup — 10-15 scheduled tasks per day, browsing a few URLs each, text-only outputs on Haiku 4.5 — you are typically spending $3-8/month. Mixed Haiku/Sonnet workloads with research and code generation run $20-50/month. Heavy Sonnet usage with long context tasks can push $60-120/month.",
        "Browser automation is where tokens compound. Vision inputs — screenshots, page captures — are large. A task taking 10 screenshots at ~1,000 tokens each, running daily, costs roughly 300,000 tokens per month just for screenshot processing. Use Haiku for the vision steps and Sonnet only for the reasoning steps if you are doing frequent browser-heavy work. [Which browser automation tool you pick](/blog/ai-agent-browser-automation-tools) changes that number too, because they differ in how much of the page they send to the model.",
        "Model choice is the biggest lever on this line, but it is not the only one. Prompt caching, batching, and trimming what you send each turn routinely cut a bill by more than switching models does. [AI agent API costs and how developers cut them](/blog/ai-agent-api-cost-optimization) goes through those with real numbers.",
      ],
    },
    {
      heading: "Coding agents cost differently: subscription login vs API",
      paragraphs: [
        "Claude Code and Codex are a special case. Both run on Hivra as the official, unmodified CLIs, and both sign in with the subscription you already pay for. [Claude Code](/agents/claude-code) uses your Anthropic account login. [Codex](/agents/codex) uses your ChatGPT login. No API key, no per-token bill, and zero markup on AI usage.",
        `That changes the math. If you already pay for a Claude or ChatGPT subscription, the marginal AI cost of running these agents in the cloud is $0. Your only new cost is hosting, from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. To check whether your Claude plan covers the usage you have in mind, run the numbers in the [Claude Code plan calculator](/tools/claude-code-plan-calculator).`,
      ],
    },
    {
      heading: "Time (the cost most people miss)",
      paragraphs: [
        "Self-hosted agents require time. Initial setup: 4-8 hours for someone with Linux experience. Ongoing minimum: 1-2 hours per month for updates, log review, and debugging intermittent failures. When something breaks meaningfully — a Docker update causes a compatibility issue, an API schema change breaks a tool the agent depends on — add 2-6 hours for the incident.",
        "If your time is worth $50/hour, 2 hours/month of maintenance is $100/month in opportunity cost. More than the server cost itself. The actual economics of self-hosting depend heavily on how you value your own time and how much you enjoy the infrastructure work. Do not do the comparison without counting maintenance.",
      ],
    },
    {
      heading: "The total picture",
      paragraphs: [
        `**Self-hosted, minimal:** Hetzner CX23 (€5.49/month excluding VAT) + $3-10/month API tokens (Haiku, text-only tasks) + 1-2 hours/month maintenance. Cash cost: $10-17/month. Real cost with time at $50/hour: $60-117/month.\n\n**Self-hosted, active use:** Hetzner CX33 (€8.49/month excluding VAT) + $20-50/month API tokens (mixed Haiku/Sonnet with some browser automation) + 2-3 hours/month maintenance. Cash cost: $30-60/month. Real cost with time: $130-210/month.\n\n**Serverless option (Modal or Daytona):** near-zero idle cost, pay only per execution. Suits agents with infrequent but compute-heavy tasks. Latency is higher on cold starts. Not suitable for sub-minute cron tasks that need instant execution.\n\n**Managed hosting (Hivra, ${ENTRY_PLAN_PRICE} plan):** ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE} + $4-20/month API tokens + no server maintenance. Real cost: $14-30/month. Full plan details on [the pricing page](/pricing).`,
        "These comparisons favour managed hosting more than the sticker prices suggest, because maintenance time is real and compounds. If you genuinely value root-level control or have strict data residency requirements, self-hosting on Hetzner is a reasonable choice — the infrastructure is good and the community around self-hosted Hermes setups is active.",
      ],
    },
    {
      heading: "Costs that do not appear in any pricing table",
      paragraphs: [
        "Domain name: $10-15/year for self-hosted setups. You need a domain for HTTPS to work correctly. Managed hosting includes this.\n\nBackup storage: if you care about your agent's memory surviving a server failure, you need off-host backups. S3-compatible storage costs roughly $0.02/GB/month. A healthy agent memory store runs 50-500 MB, so call it $1-10/month. Managed hosting handles this.\n\nAPI error costs: agents that are misconfigured or hit edge cases can burn tokens unexpectedly. Set a monthly spend cap on your API key — every provider supports this — and check it weekly when you first run a new task configuration.\n\nRecovery time: if your self-hosted server goes down and you do not have infrastructure-as-code or a backup restore procedure, getting it back up from scratch takes 4-8 hours again. One-time per incident, but real.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the absolute cheapest way to run a Hermes agent?",
      a: `Hetzner CX23 at €5.49/month as the server, Claude Haiku as the model (cheapest capable model), and limit automated tasks to text-only (no browser automation, which is the main token multiplier). Total: $10-17/month if you are technically comfortable doing the setup. Or skip the setup on Hivra from ${ENTRY_PLAN_PRICE}/month, with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can I run a Hermes agent for free?",
      a: "Anthropic and Google offer small free API tiers. You can use these for light experimentation, but free quotas are too low for any production scheduled task use. A sustainable setup costs at minimum $8-15/month including server and tokens.",
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
      title: "AI agent API costs in 2026: real numbers and how developers cut them",
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
  ],
};
