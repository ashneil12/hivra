import type { ComparePage } from "./types";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT } from "@/lib/blog/plan-facts";
import { HETZNER_LIMITED_NOTE } from "@/lib/tools/tool-catalog";
import { formatCheckedMonth } from "./competitor-facts";
import {
  AI_ACCESS_CELL,
  CLOSING,
  DECISION_SECTION,
  ENTRY_PRICE_PROSE,
  HOSTING_COST_CALCULATOR_HREF,
  REFUND_LINKED,
  PRICES_AS_OF_STAMP,
  STAYS_ON,
  AI_USAGE,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "./shared-copy";

/**
 * The five comparison pages that are not about one named competitor: self-hosting,
 * Railway, Render, moving from OpenClaw to Hermes, and the broader hosting options.
 * They used to sit inside app/compare/[slug]/page.tsx.
 *
 * The wording is the October 2026 copy (scratchpad batches/b04, files 02, 03, 07, 08
 * and 09). The corrections the claim audit of 2026-10-20 required are in place:
 * Hermes ships its own dashboard and cron, Railway shows metrics and logs and has
 * community Hermes templates, Fly describes Sprites as persistent computers, and
 * Hermes' own `hermes claw migrate` command imports a good deal of an OpenClaw setup.
 * Hivra still has no import tool of its own, and nothing here says otherwise.
 *
 * Competitor figures on these pages were read from the vendors' own pages: Hetzner,
 * DigitalOcean and Railway on 2026-09-24, Render on 2026-10-09, and all of them again
 * for the audit of 2026-10-20 (they matched, except where the copy now says otherwise).
 * Update the figures and the claims tests together when a vendor changes a price.
 */

// Hermes' own OpenClaw migration guide (`hermes claw migrate`); Hivra has no
// OpenClaw import of its own.
export const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";

export const GENERAL_COMPARISONS: Record<string, ComparePage> = {
  "vs-self-hosted": {
    slug: "vs-self-hosted",
    browserTitle: "Self-hosting Hermes or using Hivra: control has a cost | Hivra",
    h1: "Self-hosting Hermes or using Hivra: control has a cost",
    metaDescription: `Hetzner costs less each month; Hivra is ${ENTRY_PRICE_PROSE} and handles upkeep. When self-hosting wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "A self-hosted Linux server is often the cheapest way to run an AI agent in direct infrastructure spend. It is also the way to get the most control. You decide what to install, how traffic is routed, where data sits and when software is upgraded. For some people, that is exactly the appeal.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `A Hetzner CX23, with 2 vCPU and 4 GB RAM, is €5.49 per month before VAT and a public IPv4 address (Hetzner's price adjustment page lists the same server at $6.49 in US dollars for Germany and Finland). ${HETZNER_LIMITED_NOTE} Hivra's managed computer starts at ${ENTRY_PRICE_PROSE}. On the server bill alone, the VPS is cheaper.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "The difference is the work you take on. You need safe SSH access, firewalls, TLS, agent installation, secret handling, backups, updates and monitoring. None of that is impossible, but problems tend to appear when you are busy doing something else. If you already automate server maintenance, Hivra may offer less advantage.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Self-hosting also wins when you need root privileges, specialised dependencies, strict data locality, or the freedom to run unrelated services. Hivra is not a replacement for full ownership of a machine. It is an option for people who would rather spend less time administering one.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and a self-hosted VPS compared",
            rows: [
              { criterion: "Time to first running agent", hivra: "No server setup: launch from the dashboard", alternative: "You set up the server yourself, so it depends on your experience" },
              { criterion: "Monthly infrastructure cost", hivra: "From $9.99/mo for 2 vCPU, 4 GB (managed)", alternative: "From €5.49/mo before VAT and a public IPv4 address (unmanaged), or $6.49 in US dollars for Germany and Finland. Hetzner says supply in this range is limited" },
              { criterion: "Agent dashboard", hivra: "Built-in, on a computer that stays on and is not paused for inactivity", alternative: "Hermes ships its own dashboard; you set up its login and access yourself" },
              { criterion: "Automatic updates", hivra: "Hermes updates can be rolled out in stages, starting with a single agent", alternative: "Manual: you apply each update yourself" },
              { criterion: "Multiple agents", hivra: "More than one per paid plan, one dashboard", alternative: "Manual configuration per agent" },
              { criterion: "Monitoring & restarts", hivra: "Automatic", alternative: "You set it up" },
              { criterion: "Data export", hivra: "Download memory files; JSON export on Claude Code and Codex agents", alternative: "Hermes can export sessions from its dashboard; otherwise copy its data folder" },
              { criterion: "Root OS access", hivra: "Dashboard-managed (no SSH)", alternative: "Full root access" },
              { criterion: "Data residency control", hivra: "Our cloud regions only", alternative: "Any server you choose" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: {
      intro: `The Hetzner price comes from Hetzner's own pages and the Hermes dashboard from the Hermes documentation, as of ${formatCheckedMonth()}. Vendors change prices, so check the source before you pay.`,
      links: [
        { label: "Hetzner price adjustment", href: "https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/" },
        { label: "Hetzner Cloud server prices", href: "https://www.hetzner.com/cloud/cost-optimized/" },
        { label: "Hermes web dashboard (Nous Research)", href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard" },
      ],
    },
    faqs: [
      {
        q: "Is a VPS cheaper than Hivra?",
        a: "Often in direct server cost. The comparison changes when you include the time and responsibility of maintaining it.",
      },
      {
        q: "Is Hivra suitable for strict data residency?",
        a: "Only if its available hosting region, processing arrangements and contractual terms meet your requirements. A self-hosted system gives you more direct location control.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-railway", "vs-render", "openclaw-to-hermes", "vs-hostinger", "vs-nous-hermes-cloud"],
      blog: ["self-hosting-hermes-guide", "cost-of-running-ai-agent"],
      extra: [{ label: "AI agent hosting cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },

  "vs-railway": {
    slug: "vs-railway",
    browserTitle: "Railway vs Hivra: a platform for apps or a home for an agent | Hivra",
    h1: "Railway vs Hivra: a platform for apps or a home for an agent",
    metaDescription: `Railway deploys apps; Hivra hosts a persistent agent from ${ENTRY_PRICE_PROSE}. How the two differ. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Railway is a capable platform for deploying software. If you are building an application with services, deployments, databases and environment management, those are compelling reasons to use it. Hivra solves a narrower job: running a persistent AI agent without turning its installation and upkeep into a separate project.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "You can run agent software on general infrastructure, but the pieces are yours to assemble. Think about a durable filesystem, long-lived sessions, a safe public endpoint, background jobs and monitoring. A container that deploys successfully is not automatically a useful persistent workspace.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "Hivra packages a supported agent with a computer, storage and a management interface. Starting hosting is $9.99 a month for 2 vCPU and 4 GB of RAM before AI model spending. Railway's billing and service configuration are different, so compare an actual deployment rather than only entry-level prices.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "There is no need to pick only one. A web application can live on Railway while an agent runs on Hivra, with an approved webhook or API connecting them. If you already have strong deployment automation on Railway, using it for both can still be reasonable.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Railway compared",
            rows: [
              { criterion: "Time to first running agent", hivra: "No setup: launch from the dashboard", alternative: "You set it up yourself" },
              { criterion: "Hermes-specific configuration", hivra: "Pre-configured out of the box", alternative: "Community one-click Hermes templates exist; you still pick the size, the login and the updates" },
              { criterion: "Agent dashboard & monitoring", hivra: "Built-in", alternative: "No agent dashboard from Railway (Hermes brings its own); Railway shows service metrics and logs" },
              { criterion: "Multiple agents", hivra: "More than one per paid plan, one dashboard", alternative: "Manual configuration" },
              { criterion: "Browser automation", hivra: "Pre-configured", alternative: "Needs a bigger size and shared-memory tuning" },
              { criterion: "Memory persistence", hivra: "Pre-configured, on the agent's own disk", alternative: "Manual volume + backup setup" },
              { criterion: "Scheduled tasks", hivra: "Native agent scheduling", alternative: "Hermes has its own cron; a Railway cron job is a separate service that must exit when its task finishes" },
              { criterion: "General-purpose app hosting", hivra: "Not the focus", alternative: "Excellent" },
              { criterion: "Pricing model", hivra: "Flat, from $9.99/mo (2 vCPU, 4 GB)", alternative: "Usage-based: $20/vCPU and $10/GB RAM per month, plus plan fee" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources([
      { label: "Railway pricing", href: "https://railway.com/pricing" },
      { label: "Railway plans", href: "https://docs.railway.com/pricing/plans" },
      { label: "Railway observability", href: "https://docs.railway.com/observability" },
      { label: "Railway cron jobs", href: "https://docs.railway.com/cron-jobs" },
      { label: "Railway volumes", href: "https://docs.railway.com/volumes/reference" },
      { label: "Hermes Docker setup (Nous Research)", href: "https://hermes-agent.nousresearch.com/docs/user-guide/docker" },
    ]),
    faqs: [
      {
        q: "Can I use Railway and Hivra together?",
        a: "Yes. Keep your application on Railway and run the agent on Hivra, connected through appropriately authenticated interfaces.",
      },
      {
        q: "Can Railway run agents?",
        a: "Yes. It hosts applications and services. The additional agent environment and persistence choices are yours to configure.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "vs-render", "ai-agent-hosting-alternatives", "vs-agent-37"],
      blog: ["cost-of-running-ai-agent"],
    }),
  },

  "vs-render": {
    slug: "vs-render",
    browserTitle: "Running Hermes on Render or on Hivra | Hivra",
    h1: "Running Hermes on Render or on Hivra",
    metaDescription: `Render's $25 Standard Hermes template: its README warns of no default login. Hivra is ${ENTRY_PRICE_PROSE}. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Render has a published Hermes one-click template, so the comparison is not “can Render run an agent?” It can. The difference is how much of the agent environment, access control and maintenance you are prepared to handle yourself.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Render's Hermes template uses its Standard web service, listed at $25 monthly with 1 CPU and 2 GB of RAM, plus a 5 GB persistent disk costing $1.25. The entry template is therefore around $26.25 before AI usage. Hivra lists ${ENTRY_PRICE_PROSE}, with Hermes already installed.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "The most important technical caveat is security. Render's template README warns that its Hermes dashboard is not protected by a login by default. That is not something to leave exposed. You must add an authentication gateway or private access arrangement. The template also does not configure everything needed for browser automation.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Render makes sense if your other services already run there and you want to keep them together. Hivra makes sense if you want the agent computer itself managed. In either case, your model usage remains a separate cost.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Render compared",
            rows: [
              { criterion: "Hermes setup", hivra: "Installed when you launch the computer", alternative: "One-click template, then add a model key in the dashboard" },
              { criterion: "Cheapest size Render's Hermes template runs on", hivra: "$9.99/mo (2 vCPU, 4 GB)", alternative: "$25/mo (1 CPU, 2 GB) plus disk" },
              { criterion: "Monthly cost for 4 GB RAM", hivra: "$9.99/mo (2 vCPU, 4 GB)", alternative: "$85/mo (2 CPU, 4 GB) plus disk" },
              { criterion: "Always-on (no sleep)", hivra: STAYS_ON, alternative: "Free sleeps after 15 idle minutes; paid plans stay up" },
              { criterion: "Other agents", hivra: "Hermes, OpenClaw, Agent Zero, Claude Code and Codex, each on its own computer", alternative: "Anything you can put in a container, set up by you" },
              { criterion: "Render MCP tools in the agent", hivra: "Not included", alternative: "Included in the template" },
              { criterion: "Static site hosting", hivra: "Not supported", alternative: "Free static sites" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources([
      { label: "Render pricing", href: "https://render.com/pricing" },
      { label: "Render's Hermes template", href: "https://render.com/templates/hermes-on-render" },
      { label: "Render's Hermes template README on GitHub", href: "https://github.com/render-examples/hermes-render" },
      { label: "Render free instance limits", href: "https://render.com/docs/free" },
      { label: "Render persistent disks", href: "https://render.com/docs/disks" },
      { label: "Hermes Docker setup (Nous Research)", href: "https://hermes-agent.nousresearch.com/docs/user-guide/docker" },
    ]),
    faqs: [
      {
        q: "Does Render offer a Hermes template?",
        a: "Yes. Render publishes a one-click Hermes template. Check its current plan requirements and template instructions before you deploy.",
      },
      {
        q: "What is the most important security step?",
        a: "Ensure the Hermes dashboard cannot be accessed publicly without effective authentication, and restrict API keys appropriately.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-railway", "vs-self-hosted", "ai-agent-hosting-alternatives", "vs-xcloud"],
      blog: ["cost-of-running-ai-agent", "self-hosting-hermes-guide"],
    }),
  },

  "openclaw-to-hermes": {
    slug: "openclaw-to-hermes",
    browserTitle: "Moving from OpenClaw to Hermes on Hivra | Hivra",
    h1: "Moving from OpenClaw to Hermes on Hivra",
    metaDescription:
      "Hivra can host OpenClaw or Hermes on a paid computer. Hermes has its own command to move an OpenClaw setup. What carries over and what you rebuild.",
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Switching agent frameworks and switching hosting providers are not the same decision. If OpenClaw already does what you need, Hivra can host it on a paid Hivra Cloud computer, just as it hosts Hermes. You do not have to adopt Hermes simply to stop maintaining your own machine.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "If you are curious about Hermes, treat the move as a migration of workflows, not a one-click transfer of an entire personality. Hivra itself has no import tool. Hermes' own `hermes claw migrate` command imports your persona, memory, skills, MCP servers, and model and messaging settings, and `--dry-run` previews it first. Record your active integrations, schedules, skills, memory files and secrets first. Then rebuild a small test setup and check its behaviour before switching off OpenClaw.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "Hermes is an interesting choice when you want its own approach to skills, memory and recurrent tasks. OpenClaw remains useful for people who know its messaging integrations and prefer its existing tools. A hosted computer removes some infrastructure work, but does not make the frameworks interchangeable. Hivra is not affiliated with the OpenClaw project.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Hivra does not convert OpenClaw memory, plugins or configuration for you, and Hermes' own command does not bring everything across. Third-party integrations may need to be authorised again. Keep the old setup available until essential workflows have been checked.",
        ),
      },
      {
        heading: "A migration that does not lose your working setup",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Inventory what matters.", text: "Export memory and configuration where the framework allows it. Record the messaging channels, schedules, credentials and installed skills the agent uses." },
              { lead: "Start a separate test computer.", text: "Bring up Hermes without taking the existing OpenClaw bot offline. Avoid pointing both agents at the same production accounts unless you understand the consequences." },
              { lead: "Rebuild one workflow at a time.", text: "Test reading, drafting and scheduled tasks before authorising write actions or unattended activity." },
              { lead: "Verify the real output.", text: "Check that the message was delivered, that the file was written, or that the record changed, rather than trusting a success-looking response." },
              { lead: "Cut over deliberately.", text: "Turn off duplicate schedules and revoke old credentials you no longer need." },
            ],
          },
        ],
      },
      {
        heading: "What will not transfer automatically",
        blocks: paragraphs(
          "Hermes' migration guide lists cron jobs, plugins, webhooks and channel bindings as archived for you to set up again by hand, and WhatsApp needs pairing again. API keys come across only with `--migrate-secrets`. Treat migration as a controlled rebuild, not a guaranteed import.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and self-hosted OpenClaw compared",
            rows: [
              { criterion: "Hosting model", hivra: `Cloud-hosted. ${STAYS_ON}`, alternative: "Your laptop or a server you maintain" },
              { criterion: "Update management", hivra: "Hermes updates can be rolled out in stages, starting with a single agent", alternative: "Manual: you update OpenClaw yourself" },
              { criterion: "Memory across sessions", hivra: "Built-in, on a paid computer that stays on and is not paused for inactivity", alternative: "Built-in, on your own hardware" },
              { criterion: "Scheduled tasks", hivra: "Native cron on a paid computer that is not paused for inactivity, so it runs while you are away", alternative: "Built-in scheduler, runs while your machine is on" },
              { criterion: "Multiple agents", hivra: "More than one per paid plan, mixed agent types", alternative: "OpenClaw runs several agents in one gateway; you set it up and run it yourself" },
              { criterion: "Agent dashboard", hivra: "Chat, tasks, and files", alternative: "Self-hosted, you maintain it" },
              { criterion: "OpenClaw community", hivra: "OpenClaw runs on Hivra too", alternative: "Active, large community" },
              { criterion: "Model support", hivra: AI_ACCESS_CELL, alternative: "Hosted and local providers" },
              { criterion: "Cost", hivra: "From $9.99/mo (2 vCPU, 4 GB)", alternative: "The software is free; you supply the machine, plus API costs" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: {
      heading: "Where these facts come from",
      intro: `The migration steps come from Hermes' own migration guide and the OpenClaw documentation, as of ${formatCheckedMonth()}. Both change, so open the guide before you migrate.`,
      links: [
        { label: "Hermes docs: Migrate from OpenClaw", href: HERMES_OPENCLAW_MIGRATION_GUIDE },
        { label: "OpenClaw documentation", href: "https://docs.openclaw.ai" },
        { label: "OpenClaw on GitHub", href: "https://github.com/openclaw/openclaw" },
      ],
    },
    faqs: [
      {
        q: "Do I need to leave OpenClaw to use Hivra?",
        a: `No. Hivra can host OpenClaw as well as Hermes. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
      },
      {
        q: "Can I transfer every OpenClaw skill and memory?",
        a: "Do not assume so. Hivra itself has no import tool. If you move to Hermes, hermes claw migrate brings across your persona, memory, skills, MCP servers, model and messaging settings, and API keys if you choose. Cron jobs, plugins, webhooks and channel bindings need setting up again by hand.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "ai-agent-hosting-alternatives", "vs-railway"],
      blog: ["what-is-hermes-agent"],
      features: [
        { slug: "openclaw-alternative", label: "OpenClaw Alternative" },
        { slug: "persistent-memory", label: "Persistent Memory" },
      ],
    }),
  },

  "ai-agent-hosting-alternatives": {
    slug: "ai-agent-hosting-alternatives",
    browserTitle: "AI agent hosting in 2026: choose the kind of computer first | Hivra",
    h1: "AI agent hosting in 2026: choose the kind of computer first",
    metaDescription: `Fly Sprites, E2B, Railway, DigitalOcean, Cloudways, Orgo, a VPS or Hivra: which kind of computer suits an AI agent. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "There is no useful “best AI agent host” without asking what you are hosting. An always-on Hermes assistant is different from a code interpreter that runs for thirty seconds. A browser-driven desktop is different again. This comparison starts with the workload, then looks at billing, persistence and control.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "For a long-lived agent, check that the filesystem survives restarts and that background tasks can run without a browser tab being open. For bursty jobs, an idle computer may be wasted money, so metered providers such as Fly Sprites or E2B can be more sensible. For direct visual computer use, look at GUI-oriented platforms such as Orgo.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra is aimed at people who want to keep their own agent running on a predictable monthly computer. It offers managed environments for Hermes and other supported agents. ${AI_USAGE} It is not an API that creates thousands of isolated per-request sandboxes.`,
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "If you already have strong Linux skills, compare against a VPS. If you need an ephemeral environment for each customer job, compare against sandbox APIs. If you need a purpose-built computer-use desktop, test a product built for that against your own task before assuming a general-purpose computer can replace it.",
        ),
      },
      {
        heading: "Other categories worth comparing",
        blocks: [
          {
            kind: "entries",
            items: [
              { lead: "Fly Sprites and E2B:", text: "Built for programmatically creating working environments. E2B is aimed at short-lived code sandboxes, while Fly describes Sprites as persistent computers whose disk survives sleep. Both suit machines created on demand. Check session limits, storage persistence and the combined compute bill." },
              { lead: "Railway free VM:", text: "Useful for experimenting without committing to a hosted agent subscription, but Railway's page describes time limits and deletion of unclaimed machines. Do not leave important files in an environment that is designed to expire." },
              { lead: "DigitalOcean Agent Droplets (in public preview) and Cloudways Managed AI Agents:", text: "More integrated options, particularly for teams already paying those providers. Check which agent runtimes and resource sizes are actually available at the intended tier." },
              { lead: "Orgo:", text: "More desktop-oriented, including visual computer-control workflows. A graphical desktop and a persistent terminal are not interchangeable for every task." },
              { lead: "A plain VPS:", text: "Full root control and responsibility for the whole machine, often with the lowest direct infrastructure cost." },
            ],
          },
        ],
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and the other hosting options compared",
            rows: [
              { criterion: "Time to first running agent", hivra: "No server setup", alternative: "Varies: Railway says its free VM is ready in seconds, Sprites via CLI, VPS is DIY" },
              { criterion: "Hermes-specific tooling", hivra: "Hermes from Hivra's maintained image, one dashboard for several agents", alternative: "Hermes brings its own dashboard on any host, and Cloudways lists Hermes as generally available" },
              { criterion: "Monthly cost floor", hivra: "Hosting from $9.99/mo (2 vCPU, 4 GB)", alternative: "Railway free VM $0 unclaimed; Sprites/E2B meter; Cloudways Scout $9.99 for 1 vCPU and 2 GB" },
              { criterion: "Ongoing maintenance", hivra: "Server upkeep handled for you", alternative: "Yours on a VPS; lighter on managed hosts" },
              { criterion: "Persistent memory", hivra: "Built-in, on the agent's own disk", alternative: "Sprites, Orgo, Cloudways, Hivra keep disks; E2B sessions are capped at 1 hour on Hobby and 24 hours on Pro, though paused sandboxes keep their state; Railway free VM dies if unclaimed" },
              { criterion: "Browser automation", hivra: "Pre-configured", alternative: "Orgo desktop-native; others DIY or bundled tools" },
              { criterion: "Scheduled tasks", hivra: "Native agent scheduling", alternative: "DIY on a VPS, Railway, Render or serverless; Hermes has its own cron and OpenClaw has its own scheduler" },
              { criterion: "Full infrastructure control", hivra: "Dashboard + container shell", alternative: "Full on VPS options" },
              { criterion: "Money-back guarantee", hivra: `Yes: ${REFUND_LINKED}`, alternative: "Varies by provider" },
              { criterion: "Same $9.99 hardware?", hivra: "$9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM", alternative: "Cloudways Scout $9.99 is 1 vCPU and 2 GB; Cloudways Operator matches Hivra's 2 vCPU and 4 GB entry size at a higher list price" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources([
      { label: "Fly Sprites", href: "https://fly.io/sprites" },
      { label: "Railway free VM", href: "https://railway.com/free-vm" },
      { label: "DigitalOcean Agent Droplets pricing", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
      { label: "Cloudways Managed AI Agents", href: "https://www.cloudways.com/en/managed-ai-agents.php" },
      { label: "Orgo pricing", href: "https://www.orgo.ai/pricing" },
      { label: "E2B pricing", href: "https://e2b.dev/pricing" },
    ], undefined, true),
    faqs: [
      {
        q: "Can I use a free VM for a persistent agent?",
        a: "Some free environments expire or sleep. Check persistence, quotas and deletion policies before relying on them.",
      },
      {
        q: "Which is best for many short-lived tasks?",
        a: "A sandbox or metered-compute API may suit that workload better than a monthly always-on computer.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "vs-railway", "vs-agent-37", "vs-hostinger", "vs-xcloud", "vs-nous-hermes-cloud"],
      blog: ["ai-agent-hosting-guide", "managed-vs-self-hosted-ai-agents", "cost-of-running-ai-agent"],
      extra: [{ label: "AI agent hosting cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },
};
