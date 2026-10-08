import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialCTA, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle, XCircle } from "lucide-react";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import type { ComparisonData } from "@/lib/compare/types";
import { HOST_COMPARISONS } from "@/lib/compare/host-comparisons";
import { COMPETITOR_FACTS_CHECKED, formatCheckedMonth } from "@/lib/compare/competitor-facts";

// Competitor prices below were re-checked on the vendors' own pages on
// 2026-09-24: hetzner.com price adjustment (15 June 2026), digitalocean.com
// droplet pricing, railway.com pricing and docs, render.com pricing and docs.
// Hermes' own OpenClaw migration guide (`hermes claw migrate`); Hivra has no
// OpenClaw import of its own.
const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";
// Setup and upkeep hours are the reader's own. This page states none; the
// calculator takes the reader's hours and hourly rate.
const HOSTING_COST_CALCULATOR_HREF = "/tools/ai-agent-hosting-cost-calculator";

const BASE_COMPARISONS: Record<string, ComparisonData> = {
  "vs-self-hosted": {
    title: "Hivra vs Self-Hosted VPS: Which Should You Choose?",
    h1: "Self-hosting Hermes: the honest tradeoff.",
    metaDescription:
      "Hivra vs a self-hosted VPS on Hetzner or DigitalOcean: an honest comparison of cost, setup time, upkeep, and reliability for a persistent Hermes AI agent.",
    tagline: "Control vs. time. Here's what it actually costs.",
    intro: [
      "Self-hosting Hermes is technically possible and sometimes the right call. Hetzner's CX23 (2 vCPU, 4 GB) costs €5.49/mo before VAT for a VPS you fully control. Hivra costs more each month than that server. What it gives you back is the time you would spend on setup and upkeep.",
      "Setting up a Hermes agent on a raw VPS means installing Docker and Caddy, setting up networking, SSH keys and environment files, and adding monitoring. After that you keep all of it updated. When an update breaks something, fixing it is on you.",
    ],
    sections: [
      {
        heading: "What self-hosting actually costs over a year",
        paragraphs: [
          "The server itself is cheap. Hetzner's CX23 (€5.49/month before VAT and a public IPv4 address, 2 vCPU 4 GB RAM) is about €66/year for a server you fully control. CX33 (€8.49/month, 4 vCPU 8 GB RAM) is the better choice once you are running browser automation or parallel subagents. DigitalOcean's equivalent Droplets are $24-48/month. Modal or Daytona serverless are a third option, with near-zero idle cost at the expense of cold-start latency. They suit infrequent heavy tasks but not sub-minute cron jobs.",
          "Setup is your own time. You install and secure the server, install Docker and a web server, connect the agent to your AI key or login, and set up monitoring. How long that takes depends on how much of it you have done before, so this page does not put a number on it.",
          "Upkeep is your own time too: Hermes updates, Docker problems, certificate renewals and dependency conflicts. Failures and full disks add to it.",
          "On cash alone, the server wins. The server is about €66 a year. Hivra hosting starts at $9.99/month (2 vCPU, 4 GB), about $120/year, with the server upkeep handled for you. Hivra comes out ahead only if your own setup and upkeep time is worth more to you than that difference. To check with your own hours and hourly rate, use the AI agent hosting cost calculator.",
        ],
      },
      {
        heading: "What you get from self-hosting that Hivra does not give you",
        paragraphs: [
          "Complete root access. You can modify the Hermes Agent source code, add system-level dependencies, run other services on the same server, and configure networking at any layer. If you are building something custom that requires this level of access, self-hosting is the right call.",
          "No subscription dependency. Self-hosting means your agent continues running as long as your server is running, regardless of any external product decisions. This is relevant for long-running projects where continuity matters more than convenience.",
          "Data locality. If your project has specific requirements about where your data is stored and processed, such as on-premises, in a specific country or on hardware you control, self-hosting lets you meet those requirements. Hivra runs in our cloud infrastructure, which may not meet jurisdiction-specific data residency requirements.",
        ],
      },
      {
        heading: "Where self-hosting regularly fails",
        paragraphs: [
          "Update management is the main pain point. Nous Research ships updates to Hermes Agent that sometimes change the memory storage schema, update required environment variables, or introduce new dependencies. On self-hosted setups, applying these requires manual steps and testing. On Hivra, Hermes updates are tested on one agent before they roll out to the rest.",
          "Backup reliability is the second failure mode. The agent's memory volume needs regular off-host backups. Most self-hosters either do not set this up, or set it up incorrectly and discover the problem when they need to restore. Backups matter on Hivra too: backup coverage is not guaranteed, so keep your own copy of anything you cannot lose. You can download a Hermes agent's memory files from its file explorer, and Claude Code and Codex agents add a JSON export of chats and memory.",
          "The crash-at-bad-time problem: agents deployed for 24/7 scheduled task operation crash silently on self-hosted setups when Docker has an issue, the host runs out of memory, or a dependency update breaks the container. Without monitoring set up, you will not know until you notice a task has not run for days.",
        ],
      },
      {
        heading: "The right way to think about this decision",
        paragraphs: [
          "Self-hosting is the right choice if you have specific requirements that managed hosting cannot meet, such as full OS control, specific data residency, or deep customization of the stack. It is also the right choice if you genuinely enjoy the infrastructure work and treat it as a learning opportunity.",
          "Managed hosting is the right choice if your goal is to have an agent, not to build the infrastructure layer for one. The setup time you spend configuring a VPS is time you are not spending on the work the agent is supposed to do for you.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No server setup: launch from the dashboard", other: "You set up the server yourself, so it depends on your experience", hermosWins: true },
      { criterion: "Monthly infrastructure cost", hermesOs: "From $9.99/mo for 2 vCPU, 4 GB (managed)", other: "From €5.49/mo before VAT (unmanaged)", hermosWins: false },
      { criterion: "Agent dashboard", hermesOs: "Built-in, always running", other: "None. You build it", hermosWins: true },
      { criterion: "Automatic updates", hermesOs: "Tested before rollout", other: "Manual, sometimes breaking", hermosWins: true },
      { criterion: "Multiple agents", hermesOs: "More than one per paid plan, one dashboard", other: "Manual configuration per agent", hermosWins: true },
      { criterion: "Monitoring & restarts", hermesOs: "Automatic", other: "You set it up or it does not exist", hermosWins: true },
      { criterion: "Data export", hermesOs: "Download memory files; JSON export on Claude Code and Codex agents", other: "You script it", hermosWins: true },
      { criterion: "Root OS access", hermesOs: "Dashboard-managed (no SSH)", other: "Full root access", hermosWins: false },
      { criterion: "Data residency control", hermesOs: "Our cloud regions only", other: "Any server you choose", hermosWins: false },
    ],
    verdict:
      "Choose Hivra if you want an agent running today without the DevOps overhead. Choose self-hosting if you need root-level control, specific data residency, or you genuinely enjoy maintaining Linux infrastructure.",
    faqs: [
      {
        q: "Is self-hosting Hermes agent really that hard?",
        a: "For developers comfortable with Docker and Linux, it is manageable but takes time. For everyone else, it is a big project. The part people often underestimate is the ongoing maintenance.",
      },
      {
        q: "Can I switch from self-hosted to Hivra later?",
        a: "Yes, but the move is manual today. Hivra has no import tool, so you copy your agent's configuration and memory files to the new agent yourself.",
      },
      {
        q: "What if I want SSH access on Hivra?",
        a: "SSH access to the underlying server is not currently exposed. Container-level configuration is accessible through the dashboard on all plans.",
      },
      {
        q: "I already have a Hetzner server. Can I run Hermes on it side by side with Hivra?",
        a: "Yes. You can keep your self-hosted instance and run Hivra separately. Some users do this to run different agent profiles on different infrastructure.",
      },
      {
        q: "What are the data privacy implications of Hivra vs self-hosted?",
        a: "On self-hosted, your agent's memory and logs stay on your server. On Hivra, they are stored on infrastructure Hivra operates. API traffic always passes through your AI provider regardless of where the agent is hosted.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-railway", title: "Hivra vs Railway" },
      { slug: "vs-render", title: "Hivra vs Render" },
      { slug: "openclaw-to-hermes", title: "OpenClaw to Hermes Migration" },
      { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
      { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    ],
    relatedBlog: [
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    ],
    externalRelated: [{ label: "AI agent hosting cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
  },

  "vs-railway": {
    title: "Hivra vs Railway: Running Hermes Agent on Railway",
    h1: "Railway is a great platform. Just not for Hermes agents.",
    metaDescription:
      "Hivra vs Railway for hosting a Hermes AI agent. Railway is generic cloud; Hivra is built for agents. The honest difference in setup, cost, and features.",
    tagline: "Generic cloud vs. purpose-built agent hosting.",
    intro: [
      "Railway is a genuinely good platform. If you are deploying a Node.js API or a Next.js app, it is excellent. Deploying a Hermes agent is a different problem.",
      "On Railway, you would write your own Dockerfile, configure your own persistent storage for agent memory, build your own monitoring, and get no agent dashboard or multi-agent tooling. Railway also bills for the CPU and memory you use, so the monthly cost moves with the agent's workload.",
    ],
    sections: [
      {
        heading: "What Railway was built to do",
        paragraphs: [
          "Railway is a developer-focused platform-as-a-service that makes it easy to deploy web applications, APIs, background workers, and databases. Its strengths are the developer experience: a clean UI, instant deploys from GitHub, a good database provisioning flow, and competitive pricing on per-usage billing.",
          "For stateless or lightly stateful web services, Railway is excellent. A Next.js app, a Python API and a PostgreSQL database are exactly what Railway is built for. The platform scales these kinds of services well and makes them easy to manage.",
        ],
      },
      {
        heading: "Where Railway falls short for Hermes",
        paragraphs: [
          "Hermes Agent is not a web service. It is a persistent process that maintains state, runs a browser, executes scheduled tasks, and accumulates memory over months of operation. This does not fit neatly into Railway's run model.",
          "The persistent volume configuration Railway provides works for databases, but the Hermes Agent memory system is more complex. It is memory files plus a session database, both with backup and recovery requirements. Configuring this correctly on Railway requires understanding the agent's internals and building the backup solution yourself.",
          "Railway does not have a natural construct for the agent's scheduled task system. Railway's cron schedule is set per service, and the service must exit when its task finishes, so each scheduled task becomes a separate short-lived service with no shared state with the main agent and no natural integration with the agent's memory context.",
          "There is also no agent dashboard on Railway. You deploy the container, you get logs. All the tooling that Hivra provides (chat and session history, file access, several agents in one dashboard, scheduled task management) you would build yourself.",
        ],
      },
      {
        heading: "Cost comparison at typical agent usage",
        paragraphs: [
          "Railway's pricing is usage-based: its pricing page lists $20 per vCPU and $10 per GB of RAM per month of use, plus $0.15 per GB of volume storage, on top of a plan fee (Hobby is $5/month). You pay for what the agent actually uses, so a quiet agent costs less than a busy one, and memory alone costs $10 per GB for every month it stays in use.",
          "Hivra hosting starts at $9.99/month for 2 vCPU and 4 GB RAM. The price is flat, all agent tooling is included, and there is no setup work.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No setup: launch from the dashboard", other: "You set it up yourself", hermosWins: true },
      { criterion: "Hermes-specific configuration", hermesOs: "Pre-configured out of the box", other: "DIY from scratch", hermosWins: true },
      { criterion: "Agent dashboard & monitoring", hermesOs: "Built-in", other: "None", hermosWins: true },
      { criterion: "Multiple agents", hermesOs: "More than one per paid plan, one dashboard", other: "Manual configuration", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Requires custom Docker setup", hermosWins: true },
      { criterion: "Memory persistence", hermesOs: "Pre-configured, on the agent's own disk", other: "Manual volume + backup setup", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "Separate Railway cron service", hermosWins: true },
      { criterion: "General-purpose app hosting", hermesOs: "Not the focus", other: "Excellent", hermosWins: false },
      { criterion: "Pricing model", hermesOs: "Flat, from $9.99/mo (2 vCPU, 4 GB)", other: "Usage-based: $20/vCPU and $10/GB RAM per month, plus plan fee", hermosWins: true },
    ],
    verdict:
      "If you are deploying a Hermes AI agent, Hivra is the simpler choice, with more agent-specific tooling and a flat price. If you need to deploy other web services alongside it, run those on Railway and the agent on Hivra.",
    faqs: [
      {
        q: "Can I actually deploy Hermes Agent to Railway?",
        a: "Technically yes, with a custom Dockerfile. But you get no native agent support, no dashboard, no multi-agent tooling, and need to configure memory persistence and scheduled tasks yourself. It is significant DIY work, and the monthly cost depends on usage.",
      },
      {
        q: "Is Railway cheaper than Hivra?",
        a: "It depends on how hard the agent works. Railway charges for the CPU and memory you use ($20 per vCPU and $10 per GB of RAM per month at its listed rates) plus a plan fee, and an always-on agent never scales to zero. Hivra is a flat price, from $9.99/month for 2 vCPU and 4 GB, with monitoring and task scheduling included.",
      },
      {
        q: "Does Hivra support multiple regions like Railway?",
        a: "Not today. Hivra chooses where hosted agents run, and there is no region picker. Hermes runs on Hivra Cloud only. Other agents, such as OpenClaw, Claude Code and Codex, can run on your own Hetzner Cloud project (in preview), where you pick the location.",
      },
      {
        q: "If I already use Railway for my app, does that affect my Hivra choice?",
        a: "No. The two platforms run independently. A common setup is a Next.js app on Railway, with the Hermes agent on Hivra, connected via webhook or API when the app needs to trigger agent tasks.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted" },
      { slug: "vs-render", title: "Hivra vs Render" },
      { slug: "ai-agent-hosting-alternatives", title: "All AI Agent Hosting Options" },
      { slug: "vs-agent-37", title: "Hivra vs Agent 37" },
    ],
    relatedBlog: [
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    ],
  },

  "vs-render": {
    title: "Hivra vs Render: Which is Better for AI Agent Hosting?",
    h1: "Render is a web host. Hivra is built around agents.",
    metaDescription:
      "Comparing Hivra vs Render for hosting a Hermes AI agent. Render is a solid general host but lacks agent-specific tooling. Here's the honest breakdown.",
    tagline: "Render vs Hivra for persistent AI agent hosting.",
    intro: [
      "Render is a reliable, developer-friendly platform for web apps and APIs. It is not built for AI agents, and that gap shows in practice.",
      "Deploying Hermes on Render means writing a Dockerfile from scratch, figuring out the persistent storage configuration for agent memory, setting up your own monitoring, and building without any agent dashboard or multi-agent tooling.",
    ],
    sections: [
      {
        heading: "Render's strengths and the limits for agents",
        paragraphs: [
          "Render excels at three things: simple static site hosting, background worker processes, and managed PostgreSQL/Redis databases. For web apps where you want to avoid the complexity of AWS or GCP, Render is an attractive middle ground between raw VPS and a full platform-as-a-service like Heroku.",
          "The issue with Hermes Agent is that it does not fit neatly into any of Render's service types. It is not a web service (it does not listen for HTTP requests). It is not a standard background worker (it has complex startup dependencies). And its storage needs are more specialized than a standard database volume.",
          "Render's free tier spins down web services after 15 minutes without inbound traffic, and free services cannot use a persistent disk. Hermes Agent cannot be cold-started. It needs to be always on to run scheduled tasks, maintain browser sessions, and serve the dashboard. Free tier is unusable for any real agent deployment on Render.",
        ],
      },
      {
        heading: "The Dockerfile you would have to write",
        paragraphs: [
          "Getting Hermes running on Render requires a multi-stage Dockerfile that installs all Chromium dependencies (a list of about 15 system libraries), sets up the correct user permissions for the browser process, configures the memory volume mount, and sets the startup command correctly.",
          "The steps are public in Hermes's own docs, and you still have to test them. The Chromium dependency list in particular changes between minor versions of the agent, meaning container rebuilds can fail in non-obvious ways.",
          "Once running, you have no dashboard beyond Render's log viewer. Monitoring, scheduled task management, and memory inspection all require building your own tooling or accessing the agent's internal API directly.",
        ],
      },
      {
        heading: "Cost comparison",
        paragraphs: [
          "Render's Starter compute plan ($7/month) has 512 MB RAM, which is far too little for Hermes. The Standard compute plan at $25/month gives 1 CPU and 2 GB RAM, which is workable for light use but will hit memory pressure during browser automation tasks. The Pro compute plan at $85/month gives 2 CPU and 4 GB RAM, which is the realistic minimum for reliable browser use.",
          "Add a Render Disk for persistent memory storage: $0.25/GB/month. Add RAM overhead when you factor in the Chromium process during browser tasks. On those prices, a Hermes agent with a browser costs at least $85/month on Render, before the disk and any extra services.",
          "Hivra: from $9.99/month for 2 vCPU and 4 GB RAM, the same CPU and memory figures as Render's $85 Pro compute plan, with the browser pre-configured. The cost comparison is not close when you look at equivalent specs.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Pre-configured for Hermes", hermesOs: "Yes, fully", other: "No. You build it yourself", hermosWins: true },
      { criterion: "Persistent memory storage", hermesOs: "Pre-configured, on the agent's own disk", other: "Manual disk/volume setup", hermosWins: true },
      { criterion: "Agent dashboard", hermesOs: "Built-in dashboard", other: "None", hermosWins: true },
      { criterion: "Browser automation environment", hermesOs: "Pre-installed", other: "Complex Docker setup required", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "Render Cron Jobs (a separate service)", hermosWins: true },
      { criterion: "Always-on (no sleep)", hermesOs: "Paid plans are never paused for inactivity", other: "Free sleeps after 15 idle minutes; always-on paid only", hermosWins: true },
      { criterion: "Monthly cost for 4 GB RAM", hermesOs: "$9.99/mo (2 vCPU, 4 GB)", other: "$85/mo (2 CPU, 4 GB) plus disk", hermosWins: true },
      { criterion: "Static site hosting", hermesOs: "Not supported", other: "Excellent and free", hermosWins: false },
    ],
    verdict:
      "For running a persistent Hermes AI agent, Hivra wins on setup work, agent tooling, and cost at equivalent specs. Render makes more sense for web apps and APIs than for agent workloads that need persistent processes and browser access.",
    faqs: [
      {
        q: "Does Render's free tier work for Hermes?",
        a: "No. Free web services spin down after 15 minutes without inbound traffic and cannot use a persistent disk, which Hermes needs for scheduled tasks and persistent memory. You need at minimum Render's Standard compute plan ($25/month, 1 CPU, 2 GB RAM).",
      },
      {
        q: "Is Render faster to set up than a raw VPS for Hermes?",
        a: "Slightly, because you skip OS-level setup. But you still need to configure everything at the application layer including the Chromium dependencies, memory volumes, and monitoring. Hivra still needs far less setup.",
      },
      {
        q: "What does Render lack that Hivra provides?",
        a: "Agent dashboard, several agents managed in one place, pre-configured browser automation, Hermes-specific memory persistence, scheduled task management, and a choice of agents including Hermes, OpenClaw, Claude Code and Codex.",
      },
      {
        q: "Can I run Hermes on Render's cheapest plan with 512 MB RAM?",
        a: "We do not recommend it. 512 MB leaves little room for Hermes and none for a browser; plan on at least 1-2 GB, and 4 GB if the agent browses.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-railway", title: "Hivra vs Railway" },
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted" },
      { slug: "ai-agent-hosting-alternatives", title: "All AI Agent Hosting Options" },
      { slug: "vs-xcloud", title: "Hivra vs xCloud" },
    ],
    relatedBlog: [
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    ],
  },

  "openclaw-to-hermes": {
    title: "Migrating from OpenClaw to Hivra: Step-by-Step",
    h1: "Your OpenClaw setup. Hivra's infrastructure.",
    metaDescription:
      "Move from self-hosted OpenClaw to Hivra: let Hivra host OpenClaw, or switch to Hermes with its own migration command. Drop the self-hosting upkeep.",
    tagline: "Keep your agent. Leave the maintenance behind.",
    intro: [
      "OpenClaw is a powerful open-source framework. If you have been using it, you have put real work into your agent setup: prompts, tools, workflows, memory.",
      "You have two paths. Hivra can host OpenClaw itself on paid plans, or you can move to Hermes, whose `hermes claw migrate` command imports your persona, memory, skills, and settings. Neither is a one-click import in Hivra today, but either way what you leave behind is the maintenance burden. Hivra is not affiliated with the OpenClaw project.",
    ],
    sections: [
      {
        heading: "What OpenClaw does well",
        paragraphs: [
          "OpenClaw's main strength is being a personal agent you reach from the messaging apps you already use, such as Telegram, Discord, Slack and WhatsApp, with tools for the browser, files, and code, and a choice of hosted or local models. For technical developers who want this and are comfortable self-hosting, OpenClaw is a capable tool with an active community.",
          "The ecosystem includes contributed tool libraries, community configurations for common use cases, and active development. If you are deeply embedded in the OpenClaw community and your work benefits from following the upstream development closely, that is a real value.",
        ],
      },
      {
        heading: "Where the operational friction accumulates",
        paragraphs: [
          "Self-hosted OpenClaw runs wherever you install it. On a laptop, the agent only works while the laptop is on, so its built-in scheduler cannot run a 6am daily brief while the lid is closed. Moving it to a server fixes that, but then you run the server.",
          "OpenClaw keeps its memory on your own hardware, in files such as MEMORY.md. That is good for control, but backing it up and moving it between machines is your job.",
          "Update management is manual. When a new version of OpenClaw ships, you update it yourself. Occasionally these updates are breaking and require debugging your configuration.",
        ],
      },
      {
        heading: "What to expect during migration",
        paragraphs: [
          "To move to Hermes, use Hermes' own migration command, `hermes claw migrate`. It reads your OpenClaw setup and imports your persona (SOUL.md), memory, skills, MCP servers, model settings, and messaging tokens. API keys come across only with `--migrate-secrets`, and `--dry-run` previews everything first. Hivra does not run this for you: it is a manual step on the agent's computer.",
          "Some things do not come across. Hermes' migration guide lists cron jobs, plugins, webhooks, and channel bindings as archived for you to set up again by hand, and WhatsApp needs pairing again.",
          "Browser session credentials do not migrate because they are machine-local. The first time the agent needs to access an authenticated site on Hivra, it logs in and the session is then stored on the cloud server persistently. If you would rather keep OpenClaw, launch it on Hivra and copy your configuration across by hand.",
        ],
      },
      {
        heading: "What Hivra adds",
        paragraphs: [
          "A server that stays on, so memory and scheduled tasks keep working whether your own machine is on or not. More than one agent on a paid plan, and they do not all have to be the same kind: Hermes, OpenClaw, Claude Code, and Codex can run side by side. A dashboard with chat, task history, and a file explorer for the agent's memory files; Claude Code and Codex agents add a JSON export of chats and memory.",
          "Model choice stays open: OpenClaw and Hermes both work with many providers. On Hivra you bring your own key for Anthropic, OpenAI, or OpenRouter with no markup, switchable per agent profile without changing platforms.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Hosting model", hermesOs: "Cloud-hosted, persistent 24/7", other: "Your laptop or a server you maintain", hermosWins: true },
      { criterion: "Update management", hermesOs: "Tested before rollout", other: "Manual, sometimes breaking", hermosWins: true },
      { criterion: "Memory across sessions", hermesOs: "Built-in, on a server that stays on", other: "Built-in, on your own hardware", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native cron, runs while you are away", other: "Built-in scheduler, runs while your machine is on", hermosWins: true },
      { criterion: "Multiple agents", hermesOs: "More than one per paid plan, mixed agent types", other: "Each one set up and run yourself", hermosWins: true },
      { criterion: "Agent dashboard", hermesOs: "Chat, tasks, and files", other: "Self-hosted, you maintain it", hermosWins: true },
      { criterion: "OpenClaw community", hermesOs: "OpenClaw runs on Hivra too", other: "Active, large community", hermosWins: false },
      { criterion: "Model support", hermesOs: "BYO key: Anthropic, OpenAI, OpenRouter", other: "Hosted and local providers", hermosWins: false },
      { criterion: "Cost", hermesOs: "From $9.99/mo (2 vCPU, 4 GB)", other: "Free (self-hosted) + API costs", hermosWins: false },
    ],
    verdict:
      "If you love tinkering with OpenClaw and do not mind the maintenance, stay. If you want your agents, OpenClaw included, running reliably 24/7 without handling updates and infrastructure, Hivra is the natural next step.",
    faqs: [
      {
        q: "What exactly migrates from OpenClaw to Hivra?",
        a: "Hivra itself has no import tool. If you move to Hermes, `hermes claw migrate` brings across your persona (SOUL.md), memory, skills, MCP servers, model and messaging settings, and API keys if you choose. Cron jobs, plugins, webhooks, and channel bindings do not come across and need setting up again by hand.",
      },
      {
        q: "Will all my OpenClaw tools work on Hivra?",
        a: "If you run OpenClaw on Hivra, your OpenClaw skills stay OpenClaw skills. If you move to Hermes, skills come across but plugins do not. Tools that depend on local machine resources need adapting for a cloud server.",
      },
      {
        q: "What if I want to go back to OpenClaw after trying Hivra?",
        a: "You can download a Hermes agent's memory files from its file explorer at any time, and your OpenClaw setup is still yours to run. Hivra can also run OpenClaw for you. There is no lock-in.",
      },
      {
        q: "Can I keep using Claude on Hivra?",
        a: "Yes. Connect your own Anthropic API key and choose Claude models per agent profile. You can also run Claude Code on Hivra with your own login.",
      },
      {
        q: "Do I lose the OpenClaw community features and plugins?",
        a: "Not if you run OpenClaw on Hivra. If you move to Hermes, OpenClaw plugins are not compatible and would need to be ported; Hermes has its own built-in tools and skills.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted VPS" },
      { slug: "ai-agent-hosting-alternatives", title: "All AI Agent Hosting Options" },
      { slug: "vs-railway", title: "Hivra vs Railway" },
    ],
    relatedBlog: [
      { slug: "what-is-hermes-agent", title: "What is Hermes Agent?" },
    ],
    relatedFeatures: [
      { slug: "openclaw-alternative", title: "OpenClaw Alternative" },
      { slug: "persistent-memory", title: "Persistent Memory" },
    ],
    externalRelated: [
      { label: "Hermes docs: Migrate from OpenClaw", href: HERMES_OPENCLAW_MIGRATION_GUIDE },
    ],
  },

  "ai-agent-hosting-alternatives": {
    title: "AI Agent Hosting Alternatives Compared (2026)",
    h1: "Cloud computers for AI agents, compared by criteria.",
    metaDescription:
      "Fly Sprites, Railway, DO Agent Droplets, Cloudways, Orgo, E2B and Hivra compared on what matters for an agent. Prices as of October 2026.",
    tagline: "Five questions pick your host. Then the prices.",
    intro: [
      "Need a computer that stays on for an AI agent? Five questions do most of the sorting. Does your stuff survive when it sleeps? How much do you control? Desktop or just a terminal? Flat price or a meter? And can you bring your own agent? Fair warning: we make Hivra, it's one of the options here, and we'll tell you where it loses.",
      "Every figure comes from the vendor's own pages, as of October 2026. Prices and plan names move a lot, so open the source before you pay. Agent 37, Hostinger, xCloud and Nous Hermes Cloud each have their own comparison page.",
    ],
    sections: [
      {
        heading: "What should I check before picking a host for my agent?",
        paragraphs: [
          "Start with whether your work survives. Files, installs and logins should still be there after a pause or a closed laptop. Pay-per-second sandboxes that wipe the disk when the session ends fail that test for an agent you want running for weeks.",
          "Then control. Do you get root or a terminal, can you use your own model key, and can you pick which agent runs? Some hosts only run the agents they ship.",
          "Desktop or terminal matters less than people think. A full GUI desktop counts if your agent clicks around a screen. For Claude Code, Codex, Hermes and OpenClaw, a terminal and files are plenty for most people.",
          "Read the price model, not just the price. Flat monthly, prepaid allowance and per-second meters all look alike on a headline, and the same dollar can buy half the hardware once you check the size. Last, can you bring your own agent (Hermes, OpenClaw, Claude Code, Codex, your own loop), or are you locked to one?",
        ],
      },
      {
        heading: "What does each option cost, and who is it for?",
        paragraphs: [
          "Fly Sprites (fly.io/sprites): Linux computers billed only while running. CPU $0.03825 per CPU-hour, memory $0.021875 per GB-hour, hot storage about $0.50 per GB-month. Their worked examples: a 4-hour Claude Code session about $0.23, a light web app about $1.05 a month. New orgs can get $30 trial credit (one grant per user, one receive per org). Disk and checkpoints persist across sleep. Good fit if your agent works in bursts and you want an API that spins up lots of machines.",
          "Railway free VM (railway.com/free-vm): `ssh railway.new` gives 2 vCPU and 2 GB with no account while unclaimed. Claude Code, Codex, OpenCode and others come preinstalled. Limits: about 60 minutes to build, then 24 hours to claim, up to 3 per IP per day, IPv4 only. Unclaimed VMs are deleted with their files. Great for a throwaway coding VM today. Claim it if the work matters.",
          "DigitalOcean Agent Droplets (from DigitalOcean's docs and launch blog): Pro $50 a month with 15% off eligible agent usage (covers $58.82 at list rates), Team $200 a month with 20% off (covers $250). The blog offers new customers a $5 promotional credit to start. MicroVMs pause when idle. Listed harnesses include Claude Code, Codex CLI, OpenCode, Hermes, CrewAI and LangGraph. Third-party model spend is not discounted. Makes sense if you already live on DigitalOcean and want one bill for the agent runtime, storage and their hosted models.",
          "Cloudways Managed AI Agents (cloudways.com/en/managed-ai-agents.php): listed Scout $9.99 for 1 vCPU and 2 GB RAM, Operator at the same dollar as Hivra's larger plan for 2 vCPU and 4 GB, Squad $39.99 for 4 vCPU and 8 GB, Swarm $79.99 for 8 vCPU and 16 GB. Same dollar as Hivra's entry price buys half the vCPU and RAM on Scout. Hivra is $9.99 for 2 vCPU and 4 GB, or $19.99 for 4 vCPU and 8 GB, so Cloudways Operator matches Hivra's entry size at a higher list price. Product cards list OpenClaw and Hermes as Generally Available; the FAQ still says only OpenClaw. BYOK for OpenAI, Anthropic and Google. The FAQ still mentions a Public Preview trial and a later intro discount with no end date on the page. Refund terms weren't on the product page, so we won't guess at them. Worth a look if you already run apps on Cloudways and want OpenClaw or Hermes in the same dashboard.",
          "Orgo (orgo.ai/pricing): Hacker $29, Startup $99, Scale $399 a month. Hacker is 1 computer with an 8 GB RAM pool and 40 GB storage plus $5 monthly AI credit; Startup 4 computers / 32 GB / 160 GB / $10 credit; Scale 16 computers / 128 GB / 640 GB / $50 credit. Persistent cloud desktops with click and type controls, not a per-second meter. Stopped computers still count against the plan until you delete them. The pick when your agent needs a real desktop GUI, Windows on Scale, or an API built around desktops.",
          "E2B (e2b.dev/pricing): Hobby at $0 with a one-time $100 usage credit (20 concurrent, 1-hour sessions). Pro $150 a month plus usage (100 concurrent, 24-hour sessions). Usage $0.000014 per vCPU-second and $0.0000045 per GiB-second; storage included. Default sandbox 2 vCPU and 4 GiB. Built for short code sandboxes your app spins up, not a personal computer you keep for a month. The pick if you're shipping a product that opens thousands of them.",
          "Hivra: $9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM, billed monthly. Hermes from Hivra's maintained image, plus OpenClaw and Agent Zero on a paid size, Claude Code and Codex on your own logins, and Aeon on your GitHub Actions. Flat price for the computer. Model spend stays on your key unless you buy managed credits. 7-day money-back on card payments only. No free hosting and no trial; the platform itself is free with your own computer. Open source if you want to read the code or self-host. Hivra fits when you want one always-on computer for your own agents at a fixed monthly price, and you don't need a fleet API or a farm of GUI desktops.",
        ],
      },
      {
        heading: "When is Hivra the wrong choice?",
        paragraphs: [
          "Building a product that opens sandboxes per user request? E2B or Fly Sprites fit that shape. Hivra is one computer per agent for you, not a metering API for your customers.",
          "Need a free throwaway Linux VM for an afternoon of coding? Railway's free VM wins on cash. Claim it if you care about the files.",
          "Need a watched desktop that clicks through a GUI, or Windows guests? Orgo is built for that. Hivra is terminal and files first, and it has no macOS computers.",
          "Already deep in DigitalOcean and want harness, storage and their hosted models on one discounted plan? Agent Droplets Pro or Team are aimed at you.",
          "Want the lowest cash bill and you are happy running Linux yourself? A raw VPS still undercuts every managed row on money alone. Use the hosting cost calculator with your own hours.",
        ],
      },
      {
        heading: "What about a plain VPS or self-hosted OpenClaw?",
        paragraphs: [
          "Still a solid option. A Hetzner, DigitalOcean or Vultr VPS gives you root and the lowest cash bill. You also own every update, restart and backup. OpenClaw as a self-hosted app on your laptop or that VPS is free software; the cost is keeping the machine awake. OpenClaw has its own memory and scheduler while that machine is up. Hivra can host OpenClaw for you on a paid size if you want the same agent without the upkeep.",
          "Railway and Render as general PaaS hosts can run a container, but they are built for web apps. Pair them with the free VM above only when you already live there.",
        ],
      },
      {
        heading: "So which one should I pick?",
        paragraphs: [
          "Lots of short sandboxes from an API? E2B or Fly Sprites. A free VM for an afternoon? Railway. A desktop your agent can click around? Orgo. One DigitalOcean bill for managed agents? Agent Droplets. Already on Cloudways? Stay in that dashboard. A flat monthly computer for your own Hermes, OpenClaw, Claude Code or Codex? That's Hivra. Root access and the lowest cash bill? Run a VPS yourself.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No server setup", other: "Varies: free VM in seconds, Sprites via CLI, VPS is DIY", hermosWins: true },
      { criterion: "Hermes-specific tooling", hermesOs: "Native dashboard, multi-agent", other: "None in the options above", hermosWins: true },
      { criterion: "Monthly cost floor", hermesOs: "Hosting from $9.99/mo (2 vCPU, 4 GB)", other: "Railway free VM $0 unclaimed; Sprites/E2B meter; Cloudways Scout $9.99 for 1 vCPU and 2 GB", hermosWins: false },
      { criterion: "Ongoing maintenance", hermesOs: "Server upkeep handled for you", other: "Yours on a VPS; lighter on managed hosts", hermosWins: true },
      { criterion: "Persistent memory", hermesOs: "Built-in, on the agent's own disk", other: "Sprites, Orgo, Cloudways, Hivra keep disks; E2B sessions are short; Railway free VM dies if unclaimed", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Orgo desktop-native; others DIY or bundled tools", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "DIY on a VPS, Railway, Render or serverless; OpenClaw has its own scheduler", hermosWins: true },
      { criterion: "Full infrastructure control", hermesOs: "Dashboard + container shell", other: "Full on VPS options", hermosWins: false },
      { criterion: "Money-back guarantee", hermesOs: "Yes, 7 days, card payments only", other: "Varies by provider", hermosWins: true },
      { criterion: "Same $9.99 hardware?", hermesOs: "$9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM", other: "Cloudways Scout $9.99 is 1 vCPU and 2 GB; Cloudways Operator matches Hivra's 2 vCPU and 4 GB entry size at a higher list price", hermosWins: true },
    ],
    verdict:
      "Match the shape first. E2B and Fly for fleets of short sandboxes, Orgo for desktop computer-use, Railway's free VM for a throwaway session, DigitalOcean Agent Droplets when you want one DO bill, Cloudways when you already host there, a raw VPS when cash and root win, Hivra when you want a flat monthly computer for your own agents. We built Hivra, so check the prices against each vendor's page before you believe any of us.",
    faqs: [
      {
        q: "What is the cheapest way to host a Hermes AI agent in 2026?",
        a: "For the lowest cash cost, a small VPS still wins, but you own the upkeep. Hivra hosting at $9.99/month for 2 vCPU and 4 GB can work out cheaper once you count your time. The AI agent hosting cost calculator lets you check with your own hours. Cloudways lists $9.99 for 1 vCPU and 2 GB, so compare size, not only the dollar.",
      },
      {
        q: "Can I run a Hermes agent on a free tier service?",
        a: "Railway's free VM is free while unclaimed, with a short build window and a claim deadline. E2B Hobby gives usage credit for short sandboxes, not a month-long personal computer. Render's free web services spin down after idle time, which fights a persistent agent. Hivra's paid plans are never paused for inactivity, and Hivra has no free plan.",
      },
      {
        q: "What is the best AI agent hosting for beginners?",
        a: "A managed host with stated sizes and a dashboard. Hivra needs no Linux knowledge for the managed path. If you are comfortable with a terminal and want full control, a small VPS is the highest ceiling for the cash.",
      },
      {
        q: "Is Hivra the only managed Hermes agent hosting service?",
        a: "No. Cloudways lists Hermes on its managed agents page, DigitalOcean lists Hermes among Agent Droplets harnesses, and Nous runs Hermes Cloud. What Hivra focuses on is several agents side by side, including Hermes, OpenClaw, Claude Code and Codex, at a flat monthly price for the computer.",
      },
      {
        q: "Fly Sprites or Hivra for Claude Code?",
        a: "Sprites if you want pay-per-second Linux computers you drive from an API and you are fine with idle sleep. Hivra if you want one flat monthly computer with Claude Code on your own Anthropic login and a dashboard built around that computer.",
      },
      {
        q: "Cloudways $9.99 or Hivra $9.99?",
        a: "Different hardware. As of October 2026, Cloudways Scout lists 1 vCPU and 2 GB RAM at $9.99. Hivra is $9.99 for 2 vCPU and 4 GB RAM, or $19.99 for 4 vCPU and 8 GB RAM. Cloudways Operator lists 2 vCPU and 4 GB at a higher list price than Hivra's entry size. Compare agents and refund terms on each vendor's page before you treat the dollar as equal.",
      },
      {
        q: "When should I pick Orgo or E2B instead of Hivra?",
        a: "Orgo when the agent needs a real desktop it can click. E2B when your product opens many short code sandboxes. Hivra when you want one always-on computer for your own agents at a known monthly price.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted VPS" },
      { slug: "vs-railway", title: "Hivra vs Railway" },
      { slug: "vs-agent-37", title: "Hivra vs Agent 37" },
      { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
      { slug: "vs-xcloud", title: "Hivra vs xCloud" },
      { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    ],
    relatedBlog: [
      { slug: "ai-agent-hosting-guide", title: "AI agent hosting guide" },
      { slug: "managed-vs-self-hosted-ai-agents", title: "Managed vs self-hosted AI agents" },
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    ],
    externalRelated: [
      { label: "AI agent hosting cost calculator", href: HOSTING_COST_CALCULATOR_HREF },
      { label: "Fly Sprites", href: "https://fly.io/sprites" },
      { label: "Railway free VM", href: "https://railway.com/free-vm" },
      { label: "DigitalOcean Agent Droplets pricing", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
      { label: "Cloudways Managed AI Agents", href: "https://www.cloudways.com/en/managed-ai-agents.php" },
      { label: "Orgo pricing", href: "https://www.orgo.ai/pricing" },
      { label: "E2B pricing", href: "https://e2b.dev/pricing" },
    ],
  },

};

const COMPARISONS: Record<string, ComparisonData> = { ...BASE_COMPARISONS, ...HOST_COMPARISONS };

interface ComparePageParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ComparePageParams): Promise<Metadata> {
  const { slug } = await params;
  const comparison = COMPARISONS[slug];
  if (!comparison) return {};

  return {
    title: comparison.title,
    description: comparison.metaDescription,
    ...buildWebsiteMetadata({
      path: `/compare/${slug}`,
      title: comparison.title,
      description: comparison.metaDescription,
    }),
  };
}

export function generateStaticParams() {
  return Object.keys(COMPARISONS).map((slug) => ({ slug }));
}

export default async function ComparisonPage({ params }: ComparePageParams) {
  const { slug } = await params;
  const comparison = COMPARISONS[slug];
  if (!comparison) notFound();

  const pageUrl = `${SITE_URL}/compare/${slug}`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` },
          { "@type": "ListItem", position: 3, name: comparison.title, item: pageUrl },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: comparison.faqs.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  const contents = comparison.sections.map((section, index) => ({ id: `section-${index + 1}`, label: section.heading }));
  return (<PublicSite className={styles.page} data-page="compare-detail"><StructuredData schema={schema} /><main className={styles.main} id="main-content">
    <Breadcrumbs items={[{ label: "Compare", href: "/compare" }, { label: comparison.title }]} />
    <header className={styles.masthead}><span className={styles.eyebrow}>{comparison.tagline}</span><h1>{comparison.h1}</h1></header>
    <div className={styles.articleLayout}><ArticleNavigation items={contents} /><div className={styles.articleBody}><div className={styles.detailIntro}>{comparison.intro.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    {comparison.sections.map((section, index) => <section key={section.heading} id={contents[index].id}><h2>{section.heading}</h2>{section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}
    <section><h2>Feature comparison</h2><div className={styles.tableScroll} role="region" aria-label="Feature comparison" tabIndex={0}><table><thead><tr><th scope="col">Criterion</th><th scope="col">Hivra</th><th scope="col">Alternative</th></tr></thead><tbody>{comparison.vsTable.map(({ criterion, hermesOs, other, hermosWins }) => <tr key={criterion}><th scope="row">{criterion}</th><td>{hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{hermesOs}</td><td>{!hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{other}</td></tr>)}</tbody></table></div></section><section className={styles.verdict}><h2>Verdict</h2><p>{comparison.verdict}</p></section>{comparison.factSources ? <section aria-labelledby="fact-sources"><h2 id="fact-sources">Where these numbers come from</h2><p>Prices and terms for the other provider come from its own pages, as of <time dateTime={COMPETITOR_FACTS_CHECKED}>{formatCheckedMonth()}</time>. Vendors change prices, so check the source before you pay.</p><ul>{comparison.factSources.map(({ label, href }) => <li key={href}><a href={href} rel="noopener noreferrer">{label}</a></li>)}</ul></section> : null}<EditorialQuestions questions={comparison.faqs} /></div></div><EditorialCTA title={<>Ready to <strong>stop managing infra?</strong></>} label="Deploy My Agent" /><EditorialRelated links={[...comparison.relatedComparisons.map(({ slug, title }) => ({ label: title, href: `/compare/${slug}` })), ...(comparison.relatedBlog ?? []).map(({ slug, title }) => ({ label: `Blog: ${title}`, href: `/blog/${slug}` })), ...(comparison.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })), ...(comparison.externalRelated ?? []), { label: "Pricing", href: "/pricing" }, { label: "All Features", href: "/features" }]} /></main></PublicSite>);
}
