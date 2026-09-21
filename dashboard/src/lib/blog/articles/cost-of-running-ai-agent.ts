import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "cost-of-running-ai-agent",
  title: "The real cost of running a persistent AI agent in 2026",
  metaDescription:
    "A breakdown of every cost involved in running a persistent AI agent: server hosting, API tokens, maintenance time, and hidden costs. With specific numbers, not estimates.",
  publishedDate: "2026-04-01",
  lastModified: "2026-04-01",
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
        "VPS pricing: Hetzner CX22 (2 vCPU, 4 GB RAM) costs €7.49/month. DigitalOcean's comparable Droplet is $24/month. Hetzner is cheaper but you handle all configuration and maintenance yourself. Vultr and Linode fall in the $12-18/month range for equivalent specs. For a dedicated IP and better I/O, move up to the CX32 (4 vCPU, 8 GB RAM) at €17.99/month — useful if your agent does frequent browser automation.\n\nManaged hosting: Hivra starts at $9.99/month for the Pro plan (2 vCPU, 4 GB RAM) and goes to $19.99/month for the Power plan (4 vCPU, 8 GB RAM). You pay slightly more per compute unit than a raw VPS, and in exchange you get configuration already done, monitoring, automatic restarts, and no maintenance time.",
      ],
    },
    {
      heading: "AI provider tokens",
      paragraphs: [
        "Token prices as of April 2026 (check provider pages — these move frequently): Claude Haiku 4.5 ($1 input / $5 output per MTok); Claude Sonnet 4.6 ($3 / $15 per MTok, now with 1M token context at no surcharge); Claude Opus 4.6 ($5 / $25 per MTok, 1M context, 128K max output); GPT-5 mini ($0.25 / $2 per MTok — cheapest capable option currently available). The Anthropic Batch API cuts Haiku 4.5 to $0.50/$2.50 per MTok for async workloads.",
        "What does this cost in practice? For a lean setup — 10-15 scheduled tasks per day, browsing a few URLs each, text-only outputs on Haiku 4.5 — you are typically spending $3-8/month. Mixed Haiku/Sonnet workloads with research and code generation run $20-50/month. Heavy Sonnet usage with long context tasks can push $60-120/month.",
        "Browser automation is where tokens compound. Vision inputs — screenshots, page captures — are large. A task taking 10 screenshots at ~1,000 tokens each, running daily, costs roughly 300,000 tokens per month just for screenshot processing. Use Haiku for the vision steps and Sonnet only for the reasoning steps if you are doing frequent browser-heavy work.",
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
        "**Self-hosted, minimal:** Hetzner CX22 (~€7.49/month) + $3-10/month API tokens (Haiku, text-only tasks) + 1-2 hours/month maintenance. Cash cost: $11-18/month. Real cost with time at $50/hour: $61-118/month.\n\n**Self-hosted, active use:** Hetzner CX32 (€17.99/month) + $20-50/month API tokens (mixed Haiku/Sonnet with some browser automation) + 2-3 hours/month maintenance. Cash cost: $38-68/month. Real cost with time: $138-218/month.\n\n**Serverless option (Modal or Daytona):** near-zero idle cost, pay only per execution. Suits agents with infrequent but compute-heavy tasks. Latency is higher on cold starts. Not suitable for sub-minute cron tasks that need instant execution.\n\n**Managed hosting (Hivra Pro):** $9.99/month + $4-20/month API tokens + 0 maintenance time. Real cost: $14-30/month.",
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
      a: "Hetzner CX22 at €7.49/month as the server, Claude Haiku as the model (cheapest capable model), and limit automated tasks to text-only (no browser automation, which is the main token multiplier). Total: $10-15/month if you are technically comfortable doing the setup.",
    },
    {
      q: "Can I run a Hermes agent for free?",
      a: "Anthropic and Google offer small free API tiers. You can use these for light experimentation, but free quotas are too low for any production scheduled task use. A sustainable setup costs at minimum $8-15/month including server and tokens.",
    },
    {
      q: "How does pricing change as I add more agents?",
      a: "With Hivra, adding more agent profiles on the same instance does not increase the hosting cost. API costs scale with usage — more agents running more tasks means more tokens. The server cost is fixed per plan tier until you need more compute.",
    },
  ],
  relatedArticles: [
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means" },
    { slug: "hermes-agent-vs-chatgpt", title: "Hermes Agent vs ChatGPT" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
    { slug: "ai-agent-hosting-alternatives", title: "All AI agent hosting options" },
  ],
};
