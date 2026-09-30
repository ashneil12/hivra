import type { ComparisonData } from "./types";
import { COMPETITOR_FACTS, type CompetitorSlug } from "./competitor-facts";

/**
 * Comparison pages against the four hosts people search for by name. Every
 * competitor number here is in competitor-facts.ts with its source and check
 * date; a test keeps the two in step. Each page says where the other host is
 * the better choice, because a comparison that only flatters us is not one a
 * reader or an answer engine will trust.
 *
 * Copy rules that matter here: Hivra sizes are always stated as price plus
 * size ($9.99 is 2 vCPU and 4 GB, $19.99 is 4 vCPU and 8 GB); the guarantee is
 * 7 days on card payments only; no trial, no timing claims, no backup promise.
 */

const related = (slugs: string[]): ComparisonData["relatedComparisons"] => {
  const titles: Record<string, string> = {
    "vs-agent-37": "Hivra vs Agent 37",
    "vs-hostinger": "Hivra vs Hostinger",
    "vs-xcloud": "Hivra vs xCloud",
    "vs-nous-hermes-cloud": "Hivra vs Nous Hermes Cloud",
    "vs-self-hosted": "Hivra vs Self-Hosted VPS",
    "ai-agent-hosting-alternatives": "Best AI Agent Hosting Platforms in 2026",
  };
  return slugs.map((slug) => ({ slug, title: titles[slug] }));
};

const sourcesFor = (slug: CompetitorSlug) => COMPETITOR_FACTS[slug].sources;

export const HOST_COMPARISONS: Record<CompetitorSlug, ComparisonData> = {
  "vs-agent-37": {
    title: "Hivra vs Agent 37: Price, Plans and Always-On Hosting",
    h1: "Agent 37 is cheaper on raw compute. Here is what you give up and get.",
    metaDescription:
      "Hivra vs Agent 37 for hosting AI agents: metered Cloud API from $4.76/mo against Hivra's flat $9.99 for 2 vCPU and 4 GB. Prices checked 30 September 2026.",
    tagline: "Metered API or flat monthly price. Both keep an agent running.",
    intro: [
      "Agent 37 is a Y Combinator-backed host that sells agent hosting two ways: a metered Cloud API that gives each of your customers an isolated persistent sandbox, and flat monthly dashboard plans for one managed OpenClaw or Hermes agent. Hivra sells one thing, a monthly plan that gives you a computer for an agent, at a flat price.",
      "If you are building a product that spins up an agent per customer, Agent 37's API is aimed at you and Hivra is not. If you want to run your own agents and know the bill in advance, the comparison is closer than the headline prices suggest.",
    ],
    sections: [
      {
        heading: "What each one costs for an agent that stays on",
        paragraphs: [
          "Agent 37's Cloud API charges per minute from a prepaid balance, at $0.80 per vCPU, $0.70 per GB of RAM and $0.09 per GB of disk each month. That makes a 2 vCPU, 4 GB shape with 4 GB of disk $4.76 a month if it is awake around the clock, and a 4 vCPU, 8 GB shape $9.34 a month. An instance that sleeps when idle pays for disk only, so a mostly idle agent costs far less.",
          "Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month for 4 vCPU and 8 GB of RAM, billed monthly. The same always-on 2 vCPU, 4 GB shape is about half the price on Agent 37's metered API. On raw compute, Agent 37 wins.",
          "Agent 37's flat managed plans are the closer match to Hivra's model. Its entry plan is $3.99 for 1 vCPU, 4 GB of RAM and 8 GB of storage. Its $9.99 plan gives 1 vCPU, 4 GB of RAM and 12 GB of storage with some bundled model usage, and its $29.99 plan gives 2 vCPU, 8 GB and 20 GB. At $9.99 Hivra gives 2 vCPU and 4 GB of RAM, and at $19.99 it gives 4 vCPU and 8 GB, with models paid for through your own key. The plans differ in what is bundled as well as in size, so read both lists before deciding on price alone.",
        ],
      },
      {
        heading: "Billing: a flat price or a balance that runs down",
        paragraphs: [
          "Agent 37's Cloud API runs on a prepaid balance. Auto top-up is on by default after your first top-up, and if the balance runs out your instances may be paused. A new workspace can run one instance on the smallest shape until it makes a first real top-up, then larger shapes and more instances unlock as cumulative top-ups grow. That suits a builder who meters usage per customer and is a chore for someone who wants one agent.",
          "Hivra's plans are a fixed monthly price for a compute pool that your agent computers share. You do not watch a balance for the computer itself. You still pay your model provider for usage when you bring your own key, and Hivra also sells managed model credits if you would rather not.",
        ],
      },
      {
        heading: "Which agents each one runs",
        paragraphs: [
          "Agent 37's homepage lists Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok and Pi, and its docs let you bring a custom Docker image. That is a wider list than Hivra's. Whether every one of those is available on the flat managed plans, as opposed to the Cloud API, was not something its pages confirmed when we checked.",
          "Hivra runs Hermes from its own maintained image, plus OpenClaw, Agent Zero, Claude Code and Codex on their own logins, and Aeon on your GitHub Actions. OpenClaw and Agent Zero need a paid size. Hivra has no custom image support today.",
        ],
      },
      {
        heading: "Refunds, free tier and trust signals",
        paragraphs: [
          "Agent 37 refunds the first month of a subscription in full if you ask before the second billing cycle. Prepaid top-ups are non-refundable except where law requires. It also has a real free tier: one managed agent at $0 that is awake for at most 10 hours a week and sleeps when idle, and a one-time $5 starter credit once a card is on file. It publishes SOC 2 Type I status, with Type II in progress, and uses gVisor isolation.",
          "Hivra has no free plan and no trial. It offers a 7-day money-back guarantee on card payments, nothing more, and it does not claim a SOC 2 report. If a SOC 2 report is a procurement requirement, Agent 37 is ahead today.",
        ],
      },
      {
        heading: "Where Hivra is the better fit",
        paragraphs: [
          "Hivra is open source, so you can read the code that runs your agent computers and self-host it on your own server. Agent 37's platform is closed. Hivra's dashboard is built around running your own agents: a terminal, files, chat and scheduled tasks for each one, with the sizes and prices fixed in advance.",
          "For a person running a handful of their own agents, a flat price with no balance to top up is the main difference you will feel. For a developer who bills their own customers per agent, it is not, and Agent 37 is the better tool.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Always-on 2 vCPU, 4 GB", hermesOs: "$9.99/mo flat", other: "$4.76/mo metered, prepaid balance", hermosWins: false },
      { criterion: "Always-on 4 vCPU, 8 GB", hermesOs: "$19.99/mo flat for 4 vCPU and 8 GB", other: "$9.34/mo metered, prepaid balance", hermosWins: false },
      { criterion: "Billing model", hermesOs: "Fixed monthly price", other: "Per minute from a balance; auto top-up on by default", hermosWins: true },
      { criterion: "Free tier", hermesOs: "None", other: "One managed agent, awake up to 10 hours a week", hermosWins: false },
      { criterion: "Agents hosted", hermesOs: "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon", other: "Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok, Pi, custom image", hermosWins: false },
      { criterion: "Built for reselling per-customer agents", hermesOs: "No", other: "Yes, API-first with white-label dashboard", hermosWins: false },
      { criterion: "Refund", hermesOs: "7-day money-back guarantee on card payments", other: "First month of a subscription; top-ups non-refundable", hermosWins: false },
      { criterion: "Open source and self-host", hermesOs: "Yes", other: "No platform release found", hermosWins: true },
      { criterion: "Security attestation", hermesOs: "None claimed", other: "SOC 2 Type I, Type II in progress", hermosWins: false },
    ],
    verdict:
      "Choose Agent 37 if you resell agents to your own customers, want the lowest raw compute price, or need a free tier or a SOC 2 report. Choose Hivra if you run your own agents and want a fixed monthly price, an open-source platform and a dashboard built around them.",
    faqs: [
      {
        q: "Is Agent 37 cheaper than Hivra?",
        a: "On raw compute, yes. Agent 37's metered Cloud API runs an always-on 2 vCPU, 4 GB shape for $4.76 a month against Hivra's $9.99, and a 4 vCPU, 8 GB shape for $9.34 against Hivra's $19.99 for 4 vCPU and 8 GB. The metered price assumes you keep a balance topped up, and the plans bundle different things.",
      },
      {
        q: "Does Agent 37 keep agents running when I close my laptop?",
        a: "Yes. Its instances run on Agent 37's servers, not your machine. They can stay awake around the clock or sleep when idle and wake on the next request, and the Free managed plan sleeps after a period without use and is awake at most 10 hours a week.",
      },
      {
        q: "Which one is better for running Claude Code?",
        a: "Both list it. Agent 37 lists Claude Code on its Cloud API. Hivra runs Claude Code on its own Anthropic login and keeps the computer, files and login while you are away; runs you start inside tmux in the terminal tab keep going after the laptop closes.",
      },
      {
        q: "What happens if my Agent 37 balance runs out?",
        a: "Its terms say instances may be paused when the balance runs out, and auto top-up is on by default after the first top-up. Top-ups are non-refundable, so set the top-up amount with that in mind.",
      },
      {
        q: "Can I self-host either one?",
        a: "Hivra is open source and can be self-hosted, with no promise of support for self-hosters. We found no open-source or self-host release of Agent 37's platform on its pages.",
      },
    ],
    relatedComparisons: related(["vs-hostinger", "vs-xcloud", "ai-agent-hosting-alternatives"]),
    relatedBlog: [{ slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" }],
    factSources: sourcesFor("vs-agent-37"),
  },

  "vs-hostinger": {
    title: "Hivra vs Hostinger for Hermes and OpenClaw Hosting",
    h1: "Hostinger is cheaper if you will prepay for two years.",
    metaDescription:
      "Hivra vs Hostinger for hosting Hermes and OpenClaw: $5.99 managed on a 24-month prepaid term against Hivra's monthly $9.99. Checked 30 September 2026.",
    tagline: "Prepaid low price or monthly flat price.",
    intro: [
      "Hostinger is a large general web host that now sells two routes to an agent: a managed plan that runs Hermes Agent, OpenClaw, n8n or Paperclip with some AI credit included, and ordinary VPS plans with one-click Docker templates for OpenClaw and Hermes that you administer yourself.",
      "Its headline price is well below Hivra's, and it is worth knowing exactly what you commit to for that price before you compare.",
    ],
    sections: [
      {
        heading: "The price, and what it assumes",
        paragraphs: [
          "Hostinger's managed plan shows $5.99 a month. That price is for a 24-month term paid upfront, which is $143.76 in one payment by our arithmetic. The 12-month term is $7.99 a month and a single month is $10.99. The plan renews at $11.99 a month, and the prices exclude taxes. The pages show a struck-through $21.99 as the regular price.",
          "Hostinger's KVM 2 VPS is $8.99 a month on the 24-month term for 2 vCPU, 8 GB of RAM and 100 GB of NVMe storage, renewing at $14.99. It is more hardware for less money than Hivra's $9.99, 2 vCPU and 4 GB size, and you get root access and run it yourself.",
          "Hivra is billed monthly with no term: $9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month for 4 vCPU and 8 GB. If you would rather not pay two years upfront, or you are not sure you will still be running the agent in two years, the gap is smaller than $5.99 against $9.99 suggests.",
        ],
      },
      {
        heading: "What the managed plan does not tell you",
        paragraphs: [
          "Hostinger publishes no vCPU, RAM or disk figures for the managed plan, and no amount for the bundled AI credit. It says it handles updates, backups, compatibility checks, SSL and the firewall. There is a web interface and terminal access on the managed plan, but no root access; Hostinger sends you to its VPS plans for that.",
          "Hostinger's own support guide says the managed Hermes plan stops answering if the Hostinger credits run out or go negative until you top up. You can bring your own OpenAI, Anthropic, xAI or Gemini key instead.",
          "Hivra states the size of every plan, so you know what the agent has to work with before you pay.",
        ],
      },
      {
        heading: "Which agents each one hosts",
        paragraphs: [
          "Hostinger's managed plan covers Hermes Agent, OpenClaw, n8n and Paperclip on one subscription, and you can switch between them. Claude Code and Codex are not part of it.",
          "Hivra runs Hermes from its own maintained image, OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions. If the agent you want is Claude Code or Codex, Hostinger's managed plan is not the route, though you can install either on a VPS yourself.",
        ],
      },
      {
        heading: "Refunds and lock-in",
        paragraphs: [
          "Hostinger's plan pages promise a 30-day money-back guarantee. Its refund policy for VPS plans says the refund must be requested within 30 days of the transaction and more than 180 days after your last VPS refund, and crypto-paid products are not refunded. The policy does not say whether managed agent plans are covered, and it lists the bundled nexos.ai credits as non-refundable.",
          "Hivra offers a 7-day money-back guarantee on card payments. Hostinger's window is longer, and on a 24-month prepayment that matters. Leaving Hivra after a month costs you a month; leaving a 24-month Hostinger term after 30 days depends on the refund rules above.",
        ],
      },
      {
        heading: "Where Hostinger is the better choice",
        paragraphs: [
          "If you are sure you will keep the agent for two years, Hostinger is the cheaper route, by a wide margin on the VPS. It is an established host with data centres on several continents, a free domain for a year on VPS plans and a longer refund window. If you want root access and to run other things next to the agent, the KVM VPS route is better than anything Hivra offers, since Hivra does not expose SSH to the underlying server.",
          "Hivra is the better fit if you want monthly billing, stated sizes, Claude Code or Codex, or a platform you can read and self-host.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Entry price", hermesOs: "$9.99/mo monthly, 2 vCPU and 4 GB RAM", other: "$5.99/mo on a 24-month prepaid term, size not published", hermosWins: false },
      { criterion: "Commitment", hermesOs: "Monthly", other: "Paid upfront for the term ($143.76 for 24 months)", hermosWins: true },
      { criterion: "Renewal", hermesOs: "The listed monthly price", other: "$11.99/mo on the managed plan", hermosWins: true },
      { criterion: "Published hardware", hermesOs: "Stated for every size", other: "Not published for the managed plan", hermosWins: true },
      { criterion: "VPS alternative", hermesOs: "No root or SSH access", other: "KVM 2 at $8.99/mo: 2 vCPU, 8 GB, root access", hermosWins: false },
      { criterion: "Agents", hermesOs: "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon", other: "Hermes, OpenClaw, n8n, Paperclip", hermosWins: true },
      { criterion: "Refund window", hermesOs: "7 days on card payments", other: "30 days, with VPS conditions", hermosWins: false },
      { criterion: "Open source platform", hermesOs: "Yes", other: "No, proprietary", hermosWins: true },
    ],
    verdict:
      "Choose Hostinger if you will commit for two years, want the lowest price or want root access on a VPS. Choose Hivra if you want to pay monthly with stated sizes, need Claude Code or Codex, or want an open-source platform.",
    faqs: [
      {
        q: "Is Hostinger cheaper than Hivra for Hermes Agent?",
        a: "Yes, if you take the 24-month term. Its managed plan is $5.99 a month on that term, paid upfront, and renews at $11.99 a month. Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, billed monthly.",
      },
      {
        q: "What size is Hostinger's managed plan?",
        a: "Hostinger does not publish vCPU, RAM or disk for the managed plan. Its VPS plans do: KVM 2 is 2 vCPU, 8 GB of RAM and 100 GB of NVMe storage.",
      },
      {
        q: "Do I get root access on Hostinger's managed plan?",
        a: "No. It offers a web interface and terminal access, and Hostinger points to its VPS plans for root access.",
      },
      {
        q: "Can I run Claude Code on Hostinger?",
        a: "Not on the managed plan, which lists Hermes Agent, OpenClaw, n8n and Paperclip. You can install Claude Code yourself on a VPS. Hivra runs Claude Code on your own Anthropic login.",
      },
      {
        q: "What happens if the Hostinger AI credits run out?",
        a: "Hostinger's support guide says the managed Hermes plan stops answering until you top up, unless you have supplied your own model key.",
      },
    ],
    relatedComparisons: related(["vs-agent-37", "vs-xcloud", "vs-self-hosted"]),
    relatedBlog: [{ slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" }],
    factSources: sourcesFor("vs-hostinger"),
  },

  "vs-xcloud": {
    title: "Hivra vs xCloud: AI Agent Hosting Compared",
    h1: "xCloud gives more hardware for the price. Check the renewal.",
    metaDescription:
      "Hivra vs xCloud for OpenClaw and Hermes: $9.99 promotional for 4 vCPU and 6 GB against Hivra's $9.99 for 2 vCPU and 4 GB. Checked 30 September 2026.",
    tagline: "More hardware on promotion, or a fixed monthly price.",
    intro: [
      "xCloud is a server control panel and managed hosting company, mostly for WordPress and other web stacks, that also sells dedicated Cloud VPS servers with OpenClaw, Hermes Agent or DeepSeek Harness pre-installed. Each agent gets its own server that xCloud provisions, patches and monitors.",
      "It undercuts Hivra on hardware at the entry price. The details that decide it are how long the promotion lasts, the beta label on OpenClaw hosting and how refunds work.",
    ],
    sections: [
      {
        heading: "Price and hardware",
        paragraphs: [
          "xCloud's 6 GB agent server is $9.99 a month promotional for 4 vCPU, 6 GB of RAM, 100 GB of NVMe storage and 30 TB of bandwidth, sold for one always-on agent. The page says it renews at $19.99 a month for that 4 vCPU server. It does not say how long the promotion lasts, whether the first month only or longer. Larger sizes run up to 24 vCPU and 120 GB of RAM.",
          "Hivra's $9.99 a month is 2 vCPU and 4 GB of RAM, and its $19.99 a month size is 4 vCPU and 8 GB of RAM. At the entry price, xCloud gives roughly twice the vCPU and 50 percent more RAM, for as long as the promotion holds. At the renewal price of $19.99 a month, xCloud's 4 vCPU and 6 GB server costs about twice Hivra's $9.99 size, and the same as Hivra's 4 vCPU and 8 GB size, which has more RAM, while xCloud lists 100 GB of NVMe storage.",
        ],
      },
      {
        heading: "What xCloud's own docs say about OpenClaw hosting",
        paragraphs: [
          "xCloud's OpenClaw documentation, last updated on 27 April 2026, calls OpenClaw hosting a beta feature with limited support, available only on xCloud managed servers and not on servers you already own. It says the server needs more than 4 GB of RAM, though one step of the same page says a minimum of 4 GB. The newer pricing page sells 6 GB and up, so which wording is current was not something we could confirm.",
          "It is bring-your-own-model only, with no AI credit included. Anthropic (by API key or Claude Code token), OpenAI, OpenRouter, Moonshot and Gemini are listed. The docs list Telegram as the supported chat channel, while marketing also names WhatsApp, Slack and Discord.",
        ],
      },
      {
        heading: "Refunds work differently",
        paragraphs: [
          "xCloud refunds the unused part of a paid term on agent servers, not a flat window. Deleting the server does not trigger it. You submit a request from your wallet as account credit that xCloud approves, and a used day is charged at minimum. The refundable amount is what you paid, minus used service, minus a Stripe fee of up to 10 percent of the used charge. The 14-day full refund applies only to bring-your-own servers and reseller plans. Add-ons are non-refundable once activated.",
          "Hivra offers a 7-day money-back guarantee on card payments and has no pro-rata scheme. If you are likely to cancel late in a month, xCloud's pro-rated refund can return more. If you want a clean refund in the first week, Hivra's rule is simpler.",
        ],
      },
      {
        heading: "Which agents each one hosts",
        paragraphs: [
          "xCloud hosts OpenClaw, Hermes Agent and DeepSeek Harness. The Claude Code, Cursor, Codex, Gemini and Grok logos on its homepage are MCP clients that can manage xCloud servers, not agents it hosts.",
          "Hivra hosts Hermes from its own maintained image, OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions.",
        ],
      },
      {
        heading: "Where xCloud is the better choice",
        paragraphs: [
          "If the promotion holds for your term, xCloud is more hardware for the money, with 24/7 live chat support, more than 30 server locations, one-click restore and team access from a company that has hosted websites for years. There is also a free control-panel tier for people who already own servers, and it manages WordPress, Laravel, Node.js and Docker apps from the same account.",
          "Hivra is the better fit if you want Claude Code or Codex, a fixed monthly price with no promotion to expire, or an open-source platform you can read and self-host.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Entry price", hermesOs: "$9.99/mo for 2 vCPU and 4 GB RAM", other: "$9.99/mo promotional for 4 vCPU and 6 GB RAM", hermosWins: false },
      { criterion: "After the promotion", hermesOs: "The listed monthly price; no promotional rate is shown", other: "Renews at $19.99/mo for that 4 vCPU server; length not stated", hermosWins: true },
      { criterion: "OpenClaw hosting status", hermesOs: "Available on a paid size", other: "Beta with limited support in its docs", hermosWins: true },
      { criterion: "Agents", hermesOs: "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon", other: "OpenClaw, Hermes Agent, DeepSeek Harness", hermosWins: true },
      { criterion: "Models", hermesOs: "Your own key, or managed credits", other: "Your own key only", hermosWins: true },
      { criterion: "Refund", hermesOs: "7-day money-back guarantee on card payments", other: "Pro-rated unused value, minus used days and up to 10% fee, by request", hermosWins: false },
      { criterion: "Server locations", hermesOs: "Not published", other: "More than 30 listed", hermosWins: false },
    ],
    verdict:
      "Choose xCloud if you want the most hardware for the price, live chat support and a pro-rated refund, and you are happy to check the renewal. Choose Hivra if you want Claude Code or Codex, a fixed monthly price, or an open-source platform.",
    faqs: [
      {
        q: "Is xCloud cheaper than Hivra for OpenClaw?",
        a: "At the promotional price, yes: $9.99 a month buys 4 vCPU and 6 GB of RAM against Hivra's 2 vCPU and 4 GB at the same price. xCloud's page says that server renews at $19.99 a month for 4 vCPU, and it does not say how long the promotion lasts.",
      },
      {
        q: "Is OpenClaw hosting on xCloud stable?",
        a: "Its documentation, last updated on 27 April 2026, calls it a beta feature with limited support. The pricing page sells it as a standard plan, so check the current status with xCloud before relying on it.",
      },
      {
        q: "How does xCloud's refund compare?",
        a: "xCloud refunds the unused value of a paid term on request, minus used days and a payment fee of up to 10 percent, as account credit. Hivra has a 7-day money-back guarantee on card payments.",
      },
      {
        q: "Can I run Claude Code on xCloud?",
        a: "xCloud hosts OpenClaw, Hermes Agent and DeepSeek Harness. Claude Code appears on its site as a client that can manage xCloud, not as something it hosts. Hivra runs Claude Code on your own Anthropic login.",
      },
      {
        q: "Does xCloud include AI model credits?",
        a: "No. It is bring-your-own-model only.",
      },
    ],
    relatedComparisons: related(["vs-hostinger", "vs-agent-37", "ai-agent-hosting-alternatives"]),
    relatedBlog: [{ slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" }],
    factSources: sourcesFor("vs-xcloud"),
  },

  "vs-nous-hermes-cloud": {
    title: "Hivra vs Nous Hermes Cloud: Cost and Differences",
    h1: "Nous Hermes Cloud is cheaper if you use it a few hours a week.",
    metaDescription:
      "Hivra vs Nous Hermes Cloud: per-second billing at $0.56/day running against Hivra's flat $9.99 for 2 vCPU and 4 GB. Prices checked 30 September 2026.",
    tagline: "The maker's own hosting, or a flat monthly price for more agents.",
    intro: [
      "Nous Hermes Cloud is run by Nous Research, the team that makes Hermes Agent. It hosts a dedicated instance of Hermes for you, billed per day from prepaid Nous credit, with model and tool usage charged on top. Hivra is a separate company and is not affiliated with Nous Research. It also hosts Hermes, from its own maintained image rather than Nous's release, alongside other agents.",
      "For Hermes alone the two are close, and the right one depends mostly on how often the agent runs.",
    ],
    sections: [
      {
        heading: "What each costs",
        paragraphs: [
          "Nous charges by the second of uptime plus storage, deducted from your credit once a day in arrears. The Medium instance (4 vCPU and 2 GB of RAM) is $0.56 a day running, about $16.80 over 30 days by our arithmetic. The Large instance (8 vCPU and 4 GB) is $1.09 a day, about $32.70 over 30 days. A stopped instance costs $0.03 a day for storage, about $0.90 over 30 days.",
          "Hivra is $9.99 a month for 2 vCPU and 4 GB, or $19.99 a month for 4 vCPU and 8 GB. The shapes differ, so the numbers are not like for like: Nous Medium has more vCPU and less RAM than Hivra's $9.99 size, and Nous Large has more vCPU and half the RAM of Hivra's 4 vCPU and 8 GB size.",
          "Model usage is extra on both when you bring your own key. On Nous it is billed from the same credit. You need at least $2 of credit or an active subscription to deploy.",
        ],
      },
      {
        heading: "Always on versus a few hours a week",
        paragraphs: [
          "If the agent runs all day, Hivra's flat price is lower than Nous's running rate, though the sizes differ. If you use Hermes a few hours a week and stop it in between, Nous is cheaper than any flat monthly fee, because a stopped instance costs about $0.90 a month and running time is metered to the second.",
          "Nous's page says the agent runs 24/7 and also says it scales to zero when idle. It does not reconcile the two, and whether an idle instance stops on its own is not clear, so stop an instance yourself if you want the low price.",
        ],
      },
      {
        heading: "Refunds and billing risk",
        paragraphs: [
          "Nous's Terms of Service say all fees are non-refundable, with no refunds or credits for unused or partial periods. The terms do not say how unspent prepaid credit or daily instance charges are treated. Charges land a day or two after use, so your balance can lag your real spend.",
          "Hivra offers a 7-day money-back guarantee on card payments. If you are not sure Hermes hosting is for you, that is a reason to try Hivra first.",
        ],
      },
      {
        heading: "What each one gives you beyond Hermes",
        paragraphs: [
          "Nous Hermes Cloud runs Hermes Agent only. It is first-party, so updates, model routing and its Tool Gateway for web search, image generation, speech and a cloud browser come from one vendor on one bill. One Nous subscription proxies a large model catalogue. It also lists 14 city locations, including Asia-Pacific, India and Europe, and lets you resize at any time. Hermes Agent itself is MIT licensed and can be self-hosted, so there is no lock-in to Nous hosting.",
          "Hivra hosts Hermes from its own image, so the version can differ from Nous's latest release. It also hosts OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions, from one dashboard.",
        ],
      },
      {
        heading: "Where Nous is the better choice",
        paragraphs: [
          "If you want Hermes exactly as its maker ships it, with the Tool Gateway and a single bill for models and hosting, Nous is the direct route. It is also the cheaper one for intermittent use, it has a larger top size and it lists 14 city locations.",
          "Hivra is the better fit if you want several kinds of agent in one place, a fixed monthly bill, a 7-day card refund window or an open-source platform.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Always-on cost, entry size", hermesOs: "$9.99/mo for 2 vCPU and 4 GB RAM", other: "About $16.80 over 30 days for 4 vCPU and 2 GB RAM, plus model usage", hermosWins: true },
      { criterion: "Used a few hours a week", hermesOs: "Same flat price", other: "Stop it to pay about $0.90 a month for storage", hermosWins: false },
      { criterion: "Billing", hermesOs: "Monthly", other: "Prepaid credit, charged daily in arrears", hermosWins: true },
      { criterion: "Agents", hermesOs: "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon", other: "Hermes Agent only", hermosWins: true },
      { criterion: "Hermes version", hermesOs: "Hivra's maintained image", other: "First-party from Nous", hermosWins: false },
      { criterion: "Largest size", hermesOs: "4 vCPU and 8 GB RAM at $19.99/mo", other: "8 vCPU and 4 GB RAM at $1.09/day", hermosWins: false },
      { criterion: "Refund", hermesOs: "7-day money-back guarantee on card payments", other: "All fees non-refundable per its terms", hermosWins: true },
      { criterion: "Regions", hermesOs: "Not published", other: "14 cities listed", hermosWins: false },
    ],
    verdict:
      "Choose Nous Hermes Cloud if you want Hermes straight from its maker, use it in short bursts or want a choice of region. Choose Hivra if you run several kinds of agent, want a fixed monthly price or want a money-back window.",
    faqs: [
      {
        q: "Is Hivra the same as Nous Hermes Cloud?",
        a: "No. Nous Hermes Cloud is run by Nous Research. Hivra is a separate company, not affiliated with Nous Research, and runs Hermes from its own maintained image.",
      },
      {
        q: "How much does Nous Hermes Cloud cost per month?",
        a: "The Medium instance is $0.56 a day while running, about $16.80 over 30 days by our arithmetic, plus model and tool usage. A stopped instance is $0.03 a day. You need at least $2 of credit to deploy.",
      },
      {
        q: "Can I run Claude Code or Codex on Nous Hermes Cloud?",
        a: "No. It runs Hermes Agent only. Hivra runs Claude Code and Codex on your own logins.",
      },
      {
        q: "Does Nous Hermes Cloud refund unused credit?",
        a: "Its terms say all fees are non-refundable and do not cover unspent prepaid credit, so assume you cannot get it back. Hivra has a 7-day money-back guarantee on card payments.",
      },
      {
        q: "Can I self-host Hermes instead of paying either?",
        a: "Yes. Hermes Agent is MIT licensed and runs on your own machine or server. See the self-hosting guide for the work involved.",
      },
    ],
    relatedComparisons: related(["vs-self-hosted", "vs-agent-37", "ai-agent-hosting-alternatives"]),
    relatedBlog: [{ slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" }],
    factSources: sourcesFor("vs-nous-hermes-cloud"),
  },
};

export const HOST_COMPARISON_SLUGS = Object.keys(HOST_COMPARISONS) as CompetitorSlug[];
