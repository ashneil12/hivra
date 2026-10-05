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
import { COMPETITOR_FACTS_CHECKED, formatCheckedDate } from "@/lib/compare/competitor-facts";

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
          "For stateless or lightly stateful web services, Railway is excellent. A Next.js app, a Python API and a PostgreSQL database are exactly what Railway is optimized for. The platform scales these kinds of services well and makes them easy to manage.",
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
    h1: "Render was not built for agents. Hivra was.",
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
          "This is not undocumented, but it requires working through Hermes's own documentation and testing. The Chromium dependency list in particular changes between minor versions of the agent, meaning container rebuilds can fail in non-obvious ways.",
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
    title: "Best AI Agent Hosting Platforms in 2026",
    h1: "The main ways to host a persistent AI agent.",
    metaDescription:
      "AI agent hosting 2026: Sprites, Railway free VM, Agent Droplets, Cloudways, Orgo, E2B, VPS, Hivra. Dated prices, criteria first.",
    tagline: "The main options. Honest tradeoffs. Dated prices.",
    intro: [
      "We built Hivra, so we have an incentive to recommend it. This page still starts with selection criteria, then a dated cell-by-cell snapshot from each vendor's own pages (checked 5 October 2026), then the older categories that still matter: raw VPS, general PaaS, self-hosted OpenClaw, and pay-per-use sandboxes. When another option is the better fit, we say so.",
      "Persistent agents need more than a place to run a container. Useful criteria: does state survive a restart, who controls the OS and files, desktop or terminal, flat monthly price versus metered compute, and whether you bring your own agent (Claude Code, Codex, Hermes, OpenClaw) or only theirs.",
    ],
    sections: [
      {
        heading: "Dated vendor snapshot (checked 5 October 2026)",
        paragraphs: [
          "Fly Sprites (fly.io/sprites): billable while running at about $0.03825 per CPU-hour and $0.021875 per GB-hour, plus storage. Warm or cold sprites are not billed for compute. Fly publishes worked examples such as a multi-hour Claude Code session for a fraction of a dollar, and a $30 trial credit with grant limits. Pick Sprites if you want checkpoints, your own HTTPS URL, and pay-per-use rather than a flat always-on bill.",
          "Railway free VM (railway.com/free-vm): `ssh railway.new` without an account for an unclaimed VM (2 vCPU, 2 GB) with Claude Code, Codex, OpenCode, Cursor CLI and others preinstalled. Unclaimed compute is free within Railway's published limits (build window, claim window, VMs per IP). Pick it to try agents for free; claiming moves that VM into a paid Railway account.",
          "DigitalOcean Agent Droplets (blog 1 Oct 2026 + docs pricing): Pro $50/mo (covers a listed $58.82 standard-rate allotment at 15% off) and Team $200/mo (20% off a listed $250 allotment). Harnesses listed include Claude Code, Codex CLI, OpenCode, Hermes, CrewAI and LangGraph. New-customer trial credit is described on DigitalOcean's blog. Pick Agent Droplets if you already live in DigitalOcean and want a managed harness with pause-when-idle.",
          "Cloudways Managed AI Agents (cloudways.com/en/managed-ai-agents.php): listed tiers on 5 Oct 2026 include $9.99 (1 vCPU, 2 GB), $19.99 (2 vCPU, 4 GB), $39.99 (4 vCPU, 8 GB) and $79.99 (8 vCPU, 16 GB). Product cards list OpenClaw and Hermes as generally available; FAQ text on the same day still emphasises OpenClaw and a public preview. BYOK for major model providers. Pick Cloudways if you want those price points on Cloudways' managed stack, and re-read their FAQ the day you buy, because preview versus GA wording still moves.",
          "Orgo (orgo.ai/pricing): JSON-LD offers Hacker $29, Startup $99 and Scale $399 per month. Page text pairs those with computer counts and RAM (for example Hacker: 1 computer, 8 GB RAM). Persistent desktops; stopped computers still occupy plan slots per Orgo docs. Pick Orgo if you need a full desktop per agent and a flat seat-style plan.",
          "E2B (e2b.dev/pricing): Hobby at $0 with one-time credits and short sessions; Pro $150/mo plus usage with longer sessions; higher Pro tiers and Enterprise minimums published on the same page. Default sandbox shape about 2 vCPU / 4 GiB, CPU-only, rates billed per vCPU-second and GiB-second. Pick E2B for ephemeral sandboxes and code-execution APIs, not a personal always-on agent computer with a dashboard.",
        ],
      },
      {
        heading: "Option 1: Raw VPS (Hetzner, DigitalOcean, Vultr)",
        paragraphs: [
          "A raw VPS gives you the most flexibility. Hetzner's CX23 at €5.49/month before VAT is among the cheapest servers that can run Hermes: 2 vCPU, 4 GB RAM, enough for the agent plus light browser automation. DigitalOcean's 4 GB Droplet is $24/month.",
          "Setup is a real project even for someone comfortable with Linux: Ubuntu install, Docker/Compose setup, Caddy for reverse proxy and SSL, environment configuration, monitoring, and backup configuration. Once running, it is among the most powerful and cheapest options in cash terms.",
          "The catch: ongoing maintenance is real and non-trivial. When things break, debugging time is on you. Best for: developers who want maximum control and treat the infrastructure work as part of the project. To compare cash versus your own time with your own hours, use the AI agent hosting cost calculator.",
        ],
      },
      {
        heading: "Option 2: Railway and Render (general PaaS)",
        paragraphs: [
          "Railway and Render are PaaS platforms designed for web applications. Both can theoretically run a Hermes Docker container, but neither is built for agent workloads. They have no native scheduling integration with the agent's memory context, no multi-agent tooling and no agent dashboard.",
          "Render's free tier spins services down after inactivity, which is incompatible with persistent agents, and its 2 CPU, 4 GB compute plan is $85/month. Railway bills for the CPU and memory you use, so an always-on agent's cost moves with its workload. Both require a custom Dockerfile and manual configuration of the memory persistence layer.",
          "Best for: teams already on these platforms for other services who want to avoid adding another platform. The Railway free VM above is a different product surface aimed at trying coding agents quickly.",
        ],
      },
      {
        heading: "Option 3: OpenClaw (self-hosted desktop app)",
        paragraphs: [
          "OpenClaw is an open-source (MIT) personal agent created by Peter Steinberger and its community. It runs a gateway on your laptop or a server, works with hosted and local model providers, and you reach it from messaging apps such as Telegram, Discord, and WhatsApp.",
          "For technical developers who want full local control with zero subscription fees beyond API costs, it is a capable and honest choice. Its main cost is operational: 24/7 operation requires keeping your machine on or running it on a VPS yourself (which is then effectively the same as Option 1). It has its own memory and scheduler, but they only work while that machine is up. Hivra can also host OpenClaw for you on paid plans (see Option 5).",
        ],
      },
      {
        heading: "Option 4: Pay-per-use sandboxes (Modal, Daytona, Fly Sprites, E2B)",
        paragraphs: [
          "Modal and Daytona offer serverless compute with near-zero idle cost, so you pay only when the agent is actively executing. This suits agents with infrequent but compute-intensive tasks. Fly Sprites and E2B sit in the same broad bucket: metered sandboxes with different persistence and session limits (see the dated snapshot).",
          "The limitation is cold-start latency and the lack of a personal agent dashboard. You are deploying a container or sandbox and building monitoring, memory persistence, and scheduling yourself unless the vendor supplies them. Not the default choice for a personal agent you expect to stay reachable every morning.",
        ],
      },
      {
        heading: "Option 5: Hivra",
        paragraphs: [
          "Hivra is managed hosting for AI agents: Hermes, OpenClaw, Claude Code, Codex, and others. For Hermes, the container, browser environment, memory persistence layer, and dashboard are all pre-configured. Sign up, add an API key or login, and launch.",
          "Hosting is $9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM. Automatic updates and 24/7 monitoring are included; backups are not guaranteed, so keep an export of anything you cannot lose. The trade: you are not running on your own infrastructure, and $9.99/month is higher than a Hetzner CX23's raw server cost.",
          "Best for: anyone who wants a running agent without setting up and maintaining the infrastructure themselves.",
        ],
      },
      {
        heading: "Where Hivra is the wrong choice",
        paragraphs: [
          "Pick a raw VPS if you need root, custom networking, or a specific data residency story Hivra does not offer.",
          "Pick Agent 37 or similar API hosts if you resell per-customer agent sandboxes (see the dedicated Agent 37 comparison).",
          "Pick Orgo if you need a persistent full desktop per seat and Hivra's terminal-first computer is the wrong shape.",
          "Pick E2B or Modal if your workload is short-lived sandboxes behind an API, not a personal always-on agent.",
          "Pick Cloudways or DigitalOcean Agent Droplets if you already standardised on those clouds and want their harness more than Hivra's open-source computer.",
          "Pick self-hosted OpenClaw on your laptop if you accept that the agent stops when the laptop sleeps and you want zero host subscription.",
        ],
      },
      {
        heading: "How to choose",
        paragraphs: [
          "If you have specific requirements about data control, infrastructure cost is more important than your time, and you are comfortable with Linux: raw VPS is the right answer.",
          "If you already use Railway or Render for other services and want everything on one platform: the extra setup work may be justified by operational simplicity.",
          "If you want a running agent today and your time is the scarce resource: Hivra.",
          "If you are still comparing shapes and prices, start from the dated vendor snapshot and the AI agent hosting cost calculator, then open the named vs pages for Agent 37, Hostinger, xCloud and Nous Hermes Cloud.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No server setup", other: "You set up the server or platform yourself", hermosWins: true },
      { criterion: "Hermes-specific tooling", hermesOs: "Native dashboard, multi-agent", other: "None in the options above", hermosWins: true },
      { criterion: "Monthly cost floor", hermesOs: "Hosting from $9.99/mo (2 vCPU, 4 GB)", other: "€5.49/mo VPS before VAT (+ setup time)", hermosWins: false },
      { criterion: "Ongoing maintenance", hermesOs: "Server upkeep handled for you", other: "Regular on self-hosted options", hermosWins: true },
      { criterion: "Persistent memory", hermesOs: "Built-in, on the agent's own disk", other: "DIY on a VPS, Railway, Render or serverless; OpenClaw has its own", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Manual on a VPS, Railway, Render or serverless; OpenClaw has browser tools", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "DIY on a VPS, Railway, Render or serverless; OpenClaw has its own scheduler", hermosWins: true },
      { criterion: "Full infrastructure control", hermesOs: "Dashboard + container shell", other: "Full on VPS options", hermosWins: false },
      { criterion: "Money-back guarantee", hermesOs: "Yes, 7 days, card payments only", other: "Varies by provider", hermosWins: true },
    ],
    verdict:
      "Hivra is the right choice for anyone who wants a persistent agent running without becoming a part-time sysadmin. Self-hosted VPS is the right choice for developers who want complete control and do not mind the setup cost. Railway and Render are built for web apps, not persistent agent workloads. Fly Sprites, E2B, Orgo, Cloudways and DigitalOcean Agent Droplets each win on specific shapes called out above. Use the dated snapshot, not a generic ranking.",
    faqs: [
      {
        q: "What is the cheapest way to host a Hermes AI agent in 2026?",
        a: "For the lowest cash cost, a Hetzner CX23 at €5.49/month before VAT is hard to beat, but you still need to factor in your own setup time and ongoing maintenance. Hivra hosting at $9.99/month (2 vCPU, 4 GB) can work out cheaper once you count your time. The AI agent hosting cost calculator lets you plug in your own hours.",
      },
      {
        q: "Can I run Claude Code or Codex on these hosts?",
        a: "Yes on several of them. DigitalOcean Agent Droplets and Railway's free VM list Claude Code and Codex among preinstalled or supported harnesses. Hivra runs official Claude Code and Codex CLIs on a paid computer. Always re-check the vendor page the day you buy: harness lists change.",
      },
      {
        q: "Is Hivra the same as Nous Hermes Cloud?",
        a: "No. Nous Research runs its own Hermes Cloud product. Hivra is a separate open-source computer for agents (formerly HermesOS). See the dedicated Nous Hermes Cloud comparison for a fair, dated side-by-side.",
      },
      {
        q: "Do you buy backlinks or pay for rankings for this page?",
        a: "No. This page is maintained as part of Hivra's own SEO operating system. Competitor prices are copied from each vendor's public pricing page on the check date shown.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted VPS" },
      { slug: "vs-railway", title: "Hivra vs Railway" },
      { slug: "openclaw-to-hermes", title: "OpenClaw to Hermes Migration" },
      { slug: "vs-agent-37", title: "Hivra vs Agent 37" },
      { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
      { slug: "vs-xcloud", title: "Hivra vs xCloud" },
      { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    ],
    relatedBlog: [
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
      { slug: "ai-agent-hosting-guide", title: "AI agent hosting guide" },
    ],
    factSources: [
      { label: "Fly Sprites", href: "https://fly.io/sprites" },
      { label: "Railway free VM", href: "https://railway.com/free-vm" },
      { label: "DigitalOcean Agent Droplets blog", href: "https://www.digitalocean.com/blog/introducing-agent-droplets" },
      { label: "DigitalOcean Agent Harness pricing", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
      { label: "Cloudways Managed AI Agents", href: "https://www.cloudways.com/en/managed-ai-agents.php" },
      { label: "Orgo pricing", href: "https://www.orgo.ai/pricing" },
      { label: "E2B pricing", href: "https://e2b.dev/pricing" },
    ],
    externalRelated: [{ label: "AI agent hosting cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
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
    <section><h2>Feature comparison</h2><div className={styles.tableScroll} role="region" aria-label="Feature comparison" tabIndex={0}><table><thead><tr><th scope="col">Criterion</th><th scope="col">Hivra</th><th scope="col">Alternative</th></tr></thead><tbody>{comparison.vsTable.map(({ criterion, hermesOs, other, hermosWins }) => <tr key={criterion}><th scope="row">{criterion}</th><td>{hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{hermesOs}</td><td>{!hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{other}</td></tr>)}</tbody></table></div></section><section className={styles.verdict}><h2>Verdict</h2><p>{comparison.verdict}</p></section>{comparison.factSources ? <section aria-labelledby="fact-sources"><h2 id="fact-sources">Where these numbers come from</h2><p>Prices and terms for the other provider were read from its own pages on <time dateTime={COMPETITOR_FACTS_CHECKED}>{formatCheckedDate()}</time>. Vendors change prices, so check the source before you pay.</p><ul>{comparison.factSources.map(({ label, href }) => <li key={href}><a href={href} rel="noopener noreferrer">{label}</a></li>)}</ul></section> : null}<EditorialQuestions questions={comparison.faqs} /></div></div><EditorialCTA title={<>Ready to <strong>stop managing infra?</strong></>} label="Deploy My Agent" /><EditorialRelated links={[...comparison.relatedComparisons.map(({ slug, title }) => ({ label: title, href: `/compare/${slug}` })), ...(comparison.relatedBlog ?? []).map(({ slug, title }) => ({ label: `Blog: ${title}`, href: `/blog/${slug}` })), ...(comparison.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })), ...(comparison.externalRelated ?? []), { label: "Pricing", href: "/pricing" }, { label: "All Features", href: "/features" }]} /></main></PublicSite>);
}
