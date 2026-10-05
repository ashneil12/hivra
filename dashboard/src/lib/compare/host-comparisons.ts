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
    "ai-agent-hosting-alternatives": "AI Agent Hosting Alternatives Compared (2026)",
  };
  return slugs.map((slug) => ({ slug, title: titles[slug] }));
};

const sourcesFor = (slug: CompetitorSlug) => COMPETITOR_FACTS[slug].sources;

export const HOST_COMPARISONS: Record<CompetitorSlug, ComparisonData> = {
  "vs-agent-37": {
    title: "Hivra vs Agent 37: Price, Plans and Always-On Hosting",
    h1: "Agent 37 is cheaper on raw compute. What do you give up, and what do you get?",
    metaDescription:
      "Hivra vs Agent 37 for hosting AI agents: a metered Cloud API from $4.76/mo, or Hivra's flat $9.99 for 2 vCPU and 4 GB. Prices checked 2 October 2026.",
    tagline: "Metered API or flat monthly price. Both keep an agent running.",
    intro: [
      "Agent 37 is a Y Combinator-backed host, and it sells hosting two ways. One is a metered Cloud API that gives each of your customers an isolated persistent sandbox. The other is a set of flat monthly dashboard plans, each for one managed OpenClaw or Hermes agent. Hivra sells a single thing: a monthly plan that gives you a computer for an agent, at a flat price.",
      "Building a product that spins up an agent per customer? Agent 37's API is aimed at you. Hivra isn't. If you just want to run your own agents and know the bill in advance, the two are closer than the headline prices suggest.",
    ],
    sections: [
      {
        heading: "What each one costs for an agent that stays on",
        paragraphs: [
          "Agent 37's Cloud API bills per minute from a prepaid balance. The monthly rates are $0.80 per vCPU, $0.70 per GB of RAM and $0.09 per GB of disk. A 2 vCPU, 4 GB shape with 4 GB of disk comes to $4.76 a month if it's awake around the clock, and a 4 vCPU, 8 GB shape comes to $9.34. An instance that sleeps when idle pays for disk only, so a mostly idle agent costs far less.",
          "Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month for 4 vCPU and 8 GB of RAM, billed monthly. That same always-on 2 vCPU, 4 GB shape costs about half as much on Agent 37's metered API. On raw compute, Agent 37 wins.",
          "Agent 37's flat managed plans are the closer match to Hivra's model. The entry plan is $3.99 for 1 vCPU, 4 GB of RAM and 8 GB of storage. At $9.99 you get 1 vCPU, 4 GB of RAM and 12 GB of storage with some bundled model usage, and $29.99 buys 2 vCPU, 8 GB and 20 GB. Hivra's $9.99 gets you 2 vCPU and 4 GB of RAM, and its $19.99 gets you 4 vCPU and 8 GB, with models paid for through your own key. The plans also bundle different things, so read both lists before you decide on price alone.",
        ],
      },
      {
        heading: "Billing: a flat price or a balance that runs down",
        paragraphs: [
          "Agent 37's Cloud API runs on a prepaid balance. Auto top-up is on by default after your first top-up, and if the balance runs out your instances may be paused. A new workspace can run one instance on the smallest shape until it makes a first real top-up. After that, larger shapes and more instances open up as cumulative top-ups grow. If you meter usage per customer, that suits you. If you want one agent, it's a chore.",
          "Hivra's plans are a fixed monthly price for a compute pool that your agent computers share, so there's no balance to watch for the computer itself. Model usage is separate. You pay your model provider when you bring your own key, and Hivra also sells managed model credits if you'd rather not.",
        ],
      },
      {
        heading: "Which agents each one runs",
        paragraphs: [
          "Agent 37's homepage lists Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok and Pi, and its docs let you bring a custom Docker image. Its flat managed plans list OpenClaw, Hermes, Claude Code, Codex, OpenCode and Grok. That's a wider list than Hivra's.",
          "Hivra runs Hermes from its own maintained image, plus OpenClaw, Agent Zero, Claude Code and Codex on their own logins, and Aeon on your GitHub Actions. OpenClaw and Agent Zero need a paid size. Custom images aren't supported on Hivra today.",
        ],
      },
      {
        heading: "Refunds, free tier and security",
        paragraphs: [
          "Agent 37 refunds the first month of a subscription in full if you ask before the second billing cycle. Prepaid top-ups are non-refundable except where the law requires it. It has a real free tier too: one managed agent at $0 that sleeps when idle and is removed after 30 days asleep (Agent 37 emails a week before), plus a one-time $5 starter credit once a card is on file. Agent 37 also publishes SOC 2 Type I status, with Type II in progress, and uses gVisor isolation.",
          "Hivra has no free plan and no trial. It offers a 7-day money-back guarantee on card payments, and nothing beyond that. It doesn't claim a SOC 2 report either, so if a SOC 2 report is a procurement requirement, Agent 37 is ahead today.",
        ],
      },
      {
        heading: "Where Hivra is the better fit",
        paragraphs: [
          "Hivra is open source, so you can read the code that runs your agent computers and self-host it on your own server. Agent 37's platform is closed. Hivra's dashboard is built around running your own agents: each one gets a terminal, files, chat and scheduled tasks, with sizes and prices fixed in advance.",
          "If you're running a handful of your own agents, the flat price with no balance to top up is the difference you'll feel most. If you bill your own customers per agent, it isn't, and Agent 37 is the better tool.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Always-on 2 vCPU, 4 GB", hermesOs: "$9.99/mo flat", other: "$4.76/mo metered, prepaid balance", hermosWins: false },
      { criterion: "Always-on 4 vCPU, 8 GB", hermesOs: "$19.99/mo flat for 4 vCPU and 8 GB", other: "$9.34/mo metered, prepaid balance", hermosWins: false },
      { criterion: "Billing model", hermesOs: "Fixed monthly price", other: "Per minute from a balance; auto top-up on by default", hermosWins: true },
      { criterion: "Free tier", hermesOs: "None", other: "One managed agent at $0; sleeps when idle", hermosWins: false },
      { criterion: "Agents hosted", hermesOs: "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon", other: "Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok, Pi, custom image", hermosWins: false },
      { criterion: "Built for reselling per-customer agents", hermesOs: "No", other: "Yes, API-first with white-label dashboard", hermosWins: false },
      { criterion: "Refund", hermesOs: "7-day money-back guarantee on card payments", other: "First month of a subscription; top-ups non-refundable", hermosWins: false },
      { criterion: "Open source and self-host", hermesOs: "Yes", other: "No platform release found", hermosWins: true },
      { criterion: "Security attestation", hermesOs: "None claimed", other: "SOC 2 Type I, Type II in progress", hermosWins: false },
    ],
    verdict:
      "Agent 37 if you resell agents to your own customers, want the cheapest raw compute, or need a free tier or a SOC 2 report. Hivra if you run your own agents and want a fixed monthly price, an open-source platform and a dashboard built around them.",
    faqs: [
      {
        q: "Is Agent 37 cheaper than Hivra?",
        a: "On raw compute, yes. Agent 37's metered Cloud API runs an always-on 2 vCPU, 4 GB shape for $4.76 a month against Hivra's $9.99. A 4 vCPU, 8 GB shape is $9.34 against Hivra's $19.99 for 4 vCPU and 8 GB. The metered price assumes you keep a balance topped up, and the plans bundle different things.",
      },
      {
        q: "Does Agent 37 keep agents running when I close my laptop?",
        a: "Yes. Its instances run on Agent 37's servers, not on your machine. They can stay awake around the clock, or sleep when idle and wake on the next request. A Free managed agent sleeps after a period without use and is removed after 30 days asleep.",
      },
      {
        q: "Which one is better for running Claude Code?",
        a: "Both list it. Agent 37 lists Claude Code on its Cloud API and on its flat managed plans. Hivra runs Claude Code on its own Anthropic login and keeps the computer, files and login while you're away. Runs you start inside tmux in the terminal tab keep going after the laptop closes.",
      },
      {
        q: "What happens if my Agent 37 balance runs out?",
        a: "Its terms say instances may be paused when the balance runs out. Auto top-up is on by default after the first top-up. Top-ups are non-refundable, so pick the top-up amount with that in mind.",
      },
      {
        q: "Can I self-host either one?",
        a: "Hivra is open source and can be self-hosted, though we don't promise support for self-hosters. We found no open-source or self-host release of Agent 37's platform on its pages.",
      },
    ],
    relatedComparisons: related(["vs-hostinger", "vs-xcloud", "ai-agent-hosting-alternatives"]),
    relatedBlog: [{ slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" }],
    factSources: sourcesFor("vs-agent-37"),
  },

  "vs-hostinger": {
    title: "Hivra vs Hostinger for Hermes and OpenClaw Hosting",
    h1: "Hostinger is cheaper if you'll prepay for two years.",
    metaDescription:
      "Hivra vs Hostinger for hosting Hermes and OpenClaw: $5.99 managed on a 24-month prepaid term, or Hivra's monthly $9.99. Checked 2 October 2026.",
    tagline: "Prepaid low price or monthly flat price.",
    intro: [
      "Hostinger is a large general web host with two routes to an agent. There's a managed plan that runs Hermes Agent, OpenClaw, n8n or Paperclip with some AI credit included, and there are ordinary VPS plans with one-click Docker templates for OpenClaw and Hermes, which you administer yourself.",
      "The headline price is well below Hivra's. Before you compare, check what you're committing to for that price.",
    ],
    sections: [
      {
        heading: "The price, and what it assumes",
        paragraphs: [
          "Hostinger's managed plan shows $5.99 a month, but that's the 24-month term paid upfront: $143.76 in one payment by our arithmetic. The 12-month term is $7.99 a month, and a single month is $10.99. After the term it renews at $11.99 a month. Prices exclude taxes. The pages also show a struck-through $21.99 as the regular price.",
          "Hostinger's KVM 2 VPS is $8.99 a month on the 24-month term, for 2 vCPU, 8 GB of RAM and 100 GB of NVMe storage, renewing at $14.99. That's more hardware for less money than Hivra's $9.99, 2 vCPU and 4 GB size. You get root access, and you run it yourself.",
          "Hivra is billed monthly with no term: $9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month for 4 vCPU and 8 GB. Maybe you don't want to pay two years upfront, or you're not sure you'll still be running the agent in two years. Then the gap is smaller than $5.99 against $9.99 suggests.",
        ],
      },
      {
        heading: "What Hostinger's managed plan doesn't tell you",
        paragraphs: [
          "Hostinger publishes no vCPU, RAM or disk figures for the managed plan, and no amount for the bundled AI credit. It says it handles updates, backups, compatibility checks, SSL and the firewall. You get a web interface and terminal access, but no root access. For that, Hostinger sends you to its VPS plans.",
          "Hostinger's own support guide says the managed Hermes plan stops answering when the Hostinger credits run out or go negative, until you top up. You can bring your own OpenAI, Anthropic, xAI or Gemini key instead.",
          "Hivra states the size of every plan, so you know what the agent gets to work with before you pay.",
        ],
      },
      {
        heading: "Which agents each one hosts",
        paragraphs: [
          "Hostinger's managed plan covers Hermes Agent, OpenClaw, n8n and Paperclip on one subscription, and you can switch between them. Claude Code and Codex aren't part of it.",
          "Hivra runs Hermes from its own maintained image, OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions. If Claude Code or Codex is the agent you want, Hostinger's managed plan isn't the route. You can still install either one on a VPS yourself.",
        ],
      },
      {
        heading: "Refunds and lock-in",
        paragraphs: [
          "Hostinger's plan pages promise a 30-day money-back guarantee. Its refund policy for VPS plans says you must request the refund within 30 days of the transaction and more than 180 days after your last VPS refund. Crypto-paid products aren't refunded. The policy doesn't say whether managed agent plans are covered, and it lists the bundled nexos.ai credits as non-refundable.",
          "Hivra offers a 7-day money-back guarantee on card payments. Hostinger's window is longer, and on a 24-month prepayment that matters. Leave Hivra after a month and it costs you a month. Leave a 24-month Hostinger term after 30 days and what you get back depends on the refund rules above.",
        ],
      },
      {
        heading: "Where Hostinger is the better choice",
        paragraphs: [
          "If you're sure you'll keep the agent for two years, Hostinger is the cheaper route, by a wide margin on the VPS. It's an established host with data centres on several continents, a free domain for a year on VPS plans and a longer refund window. And if you want root access, or want to run other things next to the agent, the KVM VPS beats anything Hivra offers, because Hivra doesn't expose SSH to the underlying server.",
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
      "Hostinger wins on price if you'll commit for two years, and on control if you want root access on a VPS. Hivra wins if you want to pay monthly with stated sizes, need Claude Code or Codex, or want an open-source platform.",
    faqs: [
      {
        q: "Is Hostinger cheaper than Hivra for Hermes Agent?",
        a: "Yes, if you take the 24-month term. The managed plan is $5.99 a month on that term, paid upfront, and it renews at $11.99 a month. Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, billed monthly.",
      },
      {
        q: "What size is Hostinger's managed plan?",
        a: "Hostinger doesn't publish vCPU, RAM or disk for the managed plan. Its VPS plans do: KVM 2 is 2 vCPU, 8 GB of RAM and 100 GB of NVMe storage.",
      },
      {
        q: "Do I get root access on Hostinger's managed plan?",
        a: "No. You get a web interface and terminal access. For root access, Hostinger points you to its VPS plans.",
      },
      {
        q: "Can I run Claude Code on Hostinger?",
        a: "Not on the managed plan, which lists Hermes Agent, OpenClaw, n8n and Paperclip. You can install Claude Code yourself on a VPS. Hivra runs Claude Code on your own Anthropic login.",
      },
      {
        q: "What happens if the Hostinger AI credits run out?",
        a: "Hostinger's support guide says the managed Hermes plan stops answering until you top up, unless you've supplied your own model key.",
      },
    ],
    relatedComparisons: related(["vs-agent-37", "vs-xcloud", "vs-self-hosted"]),
    relatedBlog: [{ slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" }],
    factSources: sourcesFor("vs-hostinger"),
  },

  "vs-xcloud": {
    title: "Hivra vs xCloud: AI Agent Hosting Compared",
    h1: "xCloud gives you more hardware for the price. Check the renewal.",
    metaDescription:
      "Hivra vs xCloud for OpenClaw and Hermes: $9.99 promotional for 4 vCPU and 6 GB, or Hivra's $9.99 for 2 vCPU and 4 GB. Checked 2 October 2026.",
    tagline: "More hardware on promotion, or a fixed monthly price.",
    intro: [
      "xCloud is a server control panel and managed hosting company, mostly for WordPress and other web stacks. It also sells dedicated Cloud VPS servers with OpenClaw, Hermes Agent or DeepSeek Harness pre-installed. Each agent gets its own server, which xCloud provisions, patches and monitors.",
      "It undercuts Hivra on hardware at the entry price. Whether that settles it depends on how long the promotion lasts, the beta label on OpenClaw hosting and how refunds work.",
    ],
    sections: [
      {
        heading: "Price and hardware",
        paragraphs: [
          "xCloud's 6 GB agent server is $9.99 a month on promotion, for 4 vCPU, 6 GB of RAM, 100 GB of NVMe storage and 30 TB of bandwidth, sold for one always-on agent. The page says it renews at $19.99 a month for that 4 vCPU server. It doesn't say how long the promotion lasts, whether the first month only or longer. Larger sizes run up to 24 vCPU and 120 GB of RAM.",
          "Hivra's $9.99 a month is 2 vCPU and 4 GB of RAM, and its $19.99 a month size is 4 vCPU and 8 GB of RAM. At the entry price, xCloud gives roughly twice the vCPU and 50 percent more RAM, for as long as the promotion holds. At the $19.99 renewal price, xCloud's 4 vCPU and 6 GB server costs about twice Hivra's $9.99 size. Against Hivra's 4 vCPU and 8 GB size, the price is the same and Hivra has more RAM. xCloud does list 100 GB of NVMe storage.",
        ],
      },
      {
        heading: "What xCloud's own docs say about OpenClaw hosting",
        paragraphs: [
          "xCloud's OpenClaw documentation, last updated on 27 April 2026, calls OpenClaw hosting a beta feature with limited support. It's available only on xCloud managed servers, not on servers you already own. The same page says the server needs more than 4 GB of RAM, though one step on it says a minimum of 4 GB. The newer pricing page sells 6 GB and up. We couldn't confirm which wording is current.",
          "OpenClaw hosting there is bring-your-own-model only, with no AI credit included. Anthropic (by API key or Claude Code token), OpenAI, OpenRouter, Moonshot and Gemini are listed. The docs list Telegram as the supported chat channel, while marketing also names WhatsApp, Slack and Discord.",
        ],
      },
      {
        heading: "Refunds work differently",
        paragraphs: [
          "xCloud refunds the unused part of a paid term on agent servers, with no flat window. Deleting the server doesn't trigger it. You submit the request from your wallet, and it comes back as account credit that xCloud approves. At least one day of use is always charged. The refundable amount is what you paid, minus used service, minus a Stripe fee of up to 10 percent of the used charge. The 14-day full refund applies only to bring-your-own servers and reseller plans. Add-ons are non-refundable once activated.",
          "Hivra offers a 7-day money-back guarantee on card payments and has no pro-rata scheme. If you're likely to cancel late in a month, xCloud's pro-rated refund can return more. If you want a clean refund in the first week, Hivra's rule is simpler.",
        ],
      },
      {
        heading: "Which agents each one hosts",
        paragraphs: [
          "xCloud hosts OpenClaw, Hermes Agent and DeepSeek Harness. The Claude Code, Cursor, Codex, Gemini and Grok logos on its homepage are MCP clients that can manage xCloud servers. They aren't agents it hosts.",
          "Hivra hosts Hermes from its own maintained image, OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions.",
        ],
      },
      {
        heading: "Where xCloud is the better choice",
        paragraphs: [
          "If the promotion holds for your term, xCloud is more hardware for the money. It also has 24/7 live chat support, more than 30 server locations, one-click restore and team access, from a company that has hosted websites for years. There's a free control-panel tier too, for people who already own servers, and it manages WordPress, Laravel, Node.js and Docker apps from the same account.",
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
      "Pick xCloud if you want the most hardware for the price, live chat support and a pro-rated refund, and you're happy to check the renewal. Pick Hivra if you want Claude Code or Codex, a fixed monthly price with no promotion to expire, or an open-source platform you can read and self-host.",
    faqs: [
      {
        q: "Is xCloud cheaper than Hivra for OpenClaw?",
        a: "At the promotional price, yes. $9.99 a month buys 4 vCPU and 6 GB of RAM, against Hivra's 2 vCPU and 4 GB at the same price. xCloud's page says that server renews at $19.99 a month for 4 vCPU. It doesn't say how long the promotion lasts.",
      },
      {
        q: "Is OpenClaw hosting on xCloud stable?",
        a: "Its documentation, last updated on 27 April 2026, calls it a beta feature with limited support. The pricing page sells it as a standard plan. Check the current status with xCloud before you rely on it.",
      },
      {
        q: "How does xCloud's refund compare?",
        a: "xCloud refunds the unused value of a paid term on request, minus used days and a payment fee of up to 10 percent, as account credit. Hivra has a 7-day money-back guarantee on card payments.",
      },
      {
        q: "Can I run Claude Code on xCloud?",
        a: "xCloud hosts OpenClaw, Hermes Agent and DeepSeek Harness. Claude Code shows up on its site as a client that can manage xCloud. It isn't something xCloud hosts. Hivra runs Claude Code on your own Anthropic login.",
      },
      {
        q: "Does xCloud include AI model credits?",
        a: "No. It's bring-your-own-model only.",
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
      "Hivra vs Nous Hermes Cloud: per-second billing at $0.56/day running against Hivra's flat $9.99 for 2 vCPU and 4 GB. Prices checked 2 October 2026.",
    tagline: "The maker's own hosting, or a flat monthly price for more agents.",
    intro: [
      "Nous Hermes Cloud is run by Nous Research, the team that makes Hermes Agent. It hosts a dedicated instance of Hermes for you, billed per day from prepaid Nous credit, with model and tool usage charged on top. Hivra is a separate company and is not affiliated with Nous Research. It hosts Hermes too, from its own maintained image rather than Nous's release, alongside other agents.",
      "For Hermes alone the two are close. Which one fits depends mostly on how often the agent runs.",
    ],
    sections: [
      {
        heading: "What each costs",
        paragraphs: [
          "Nous charges by the second of uptime plus storage, and takes it from your credit once a day in arrears. The Medium instance (4 vCPU and 2 GB of RAM) is $0.56 a day running, about $16.80 over 30 days by our arithmetic. The Large instance (8 vCPU and 4 GB) is $1.09 a day, about $32.70 over 30 days. Stopped, an instance costs $0.03 a day for storage, about $0.90 over 30 days.",
          "Hivra is $9.99 a month for 2 vCPU and 4 GB, or $19.99 a month for 4 vCPU and 8 GB. The shapes differ, so the numbers aren't like for like. Nous Medium has more vCPU and less RAM than Hivra's $9.99 size. Nous Large has more vCPU and half the RAM of Hivra's 4 vCPU and 8 GB size.",
          "Model usage is extra on both when you bring your own key. On Nous it comes out of the same credit. To deploy there, you need at least $2 of credit or an active subscription.",
        ],
      },
      {
        heading: "Always on versus a few hours a week",
        paragraphs: [
          "If the agent runs all day, Hivra's flat price is lower than Nous's running rate, though the sizes differ. If you use Hermes a few hours a week and stop it in between, Nous is cheaper than any flat monthly fee. A stopped instance costs about $0.90 a month, and running time is metered to the second.",
          "Nous's page says the agent runs 24/7 and also says it scales to zero when idle. It doesn't reconcile the two, so it isn't clear whether an idle instance stops on its own. If you want the low price, stop the instance yourself.",
        ],
      },
      {
        heading: "Refunds and billing risk",
        paragraphs: [
          "Nous's Terms of Service say all fees are non-refundable, with no refunds or credits for unused or partial periods. They don't say how unspent prepaid credit or daily instance charges are treated. Charges land a day or two after use, so your balance can lag your real spend.",
          "Hivra offers a 7-day money-back guarantee on card payments. That helps if you're not sure Hermes hosting is for you.",
        ],
      },
      {
        heading: "What each one gives you beyond Hermes",
        paragraphs: [
          "Nous Hermes Cloud runs Hermes Agent only. It's first-party, so updates, model routing and its Tool Gateway (web search, image generation, speech and a cloud browser) all come from one vendor on one bill. One Nous subscription proxies a large model catalogue. Nous lists 14 city locations, including Asia-Pacific, India and Europe, and lets you resize at any time. Hermes Agent itself is MIT licensed and can be self-hosted, so there's no lock-in to Nous hosting.",
          "Hivra hosts Hermes from its own image, so the version can differ from Nous's latest release. It also hosts OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions, all from one dashboard.",
        ],
      },
      {
        heading: "Where Nous is the better choice",
        paragraphs: [
          "If you want Hermes exactly as its maker ships it, with the Tool Gateway and a single bill for models and hosting, Nous is the direct route. Intermittent use costs less there too. The top size is larger, and Nous lists 14 city locations.",
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
      "Nous Hermes Cloud suits you if you want Hermes straight from its maker, use it in short bursts or want a choice of region. Hivra suits you if you run several kinds of agent, want a fixed monthly price, a 7-day card refund window or an open-source platform.",
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
        a: "Its terms say all fees are non-refundable and don't cover unspent prepaid credit, so assume you can't get it back. Hivra has a 7-day money-back guarantee on card payments.",
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
