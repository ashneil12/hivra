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

type ComparisonSection = {
  heading: string;
  paragraphs: string[];
};

type ComparisonData = {
  title: string;
  h1: string;
  metaDescription: string;
  tagline: string;
  intro: string[];
  sections: ComparisonSection[];
  vsTable: Array<{
    criterion: string;
    hermesOs: string;
    other: string;
    hermosWins: boolean;
  }>;
  verdict: string;
  faqs: Array<{ q: string; a: string }>;
  relatedComparisons: Array<{ slug: string; title: string }>;
  relatedBlog?: Array<{ slug: string; title: string }>;
  relatedFeatures?: Array<{ slug: string; title: string }>;
  /** Off-site references, such as upstream docs a paragraph relies on. */
  externalRelated?: Array<{ label: string; href: string }>;
};

// Competitor prices below were re-checked on the vendors' own pages on
// 2026-09-24: hetzner.com price adjustment (15 June 2026), digitalocean.com
// droplet pricing, railway.com pricing and docs, render.com pricing and docs.
// Hermes' own OpenClaw migration guide (`hermes claw migrate`); Hivra has no
// OpenClaw import of its own.
const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";

const COMPARISONS: Record<string, ComparisonData> = {
  "vs-self-hosted": {
    title: "Hivra vs Self-Hosted VPS: Which Should You Choose?",
    h1: "Self-hosting Hermes: the honest tradeoff.",
    metaDescription:
      "Hivra vs a self-hosted VPS on Hetzner or DigitalOcean: an honest comparison of cost, setup time, upkeep, and reliability for a persistent Hermes AI agent.",
    tagline: "Control vs. time. Here's what it actually costs.",
    intro: [
      "Self-hosting Hermes is technically possible and sometimes the right call. Hetzner's CX23 (2 vCPU, 4 GB) costs €5.49/mo before VAT for a VPS you fully control. You are not saving money with Hivra — you are saving time.",
      "The honest accounting: setting up a Hermes agent on a raw VPS takes 6-8 hours the first time. Docker, Caddy, networking, SSH keys, env files, monitoring. Then it breaks on the next update, and you spend another evening fixing it.",
    ],
    sections: [
      {
        heading: "What self-hosting actually costs over a year",
        paragraphs: [
          "The server itself is cheap. Hetzner's CX23 (€5.49/month before VAT and a public IPv4 address, 2 vCPU 4 GB RAM) is about €66/year for a server you fully control. CX33 (€8.49/month, 4 vCPU 8 GB RAM) is the better choice once you are running browser automation or parallel subagents. DigitalOcean's equivalent Droplets are $24-48/month. Modal or Daytona serverless are a third option — near-zero idle cost at the expense of cold-start latency, suitable for infrequent heavy tasks but not sub-minute cron jobs.",
          "Initial setup: 4-8 hours for a developer who knows Linux. At $50/hour effective rate, that is $200-400 of time just to get started.",
          "Ongoing maintenance: budget 1-2 hours per month minimum — Hermes updates, Docker daemon issues, certificate renewals, dependency conflicts. Infrastructure failures and disk-fill events add time on top. Over a year: 15-20 hours. At $50/hour: $750-1000.",
          "Total real cost of self-hosting for one year at CX23 pricing, with time factored in: roughly $950-1,400 against about €66 in raw server fees. Hivra hosting starts at $9.99/month (2 vCPU, 4 GB), about $120/year, with the server upkeep handled for you. The gap widens once you value your time honestly.",
        ],
      },
      {
        heading: "What you get from self-hosting that Hivra does not give you",
        paragraphs: [
          "Complete root access. You can modify the Hermes Agent source code, add system-level dependencies, run other services on the same server, and configure networking at any layer. If you are building something custom that requires this level of access, self-hosting is the right call.",
          "No subscription dependency. Self-hosting means your agent continues running as long as your server is running, regardless of any external product decisions. This is relevant for long-running projects where continuity matters more than convenience.",
          "Data locality. If your project has specific requirements about where your data is stored and processed — on-premises, in a specific country, on hardware you control — self-hosting lets you meet those requirements. Hivra runs in our cloud infrastructure, which may not meet jurisdiction-specific data residency requirements.",
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
          "Self-hosting is the right choice if you have specific requirements that managed hosting cannot meet — full OS control, specific data residency, or deep customization of the stack. It is also the right choice if you genuinely enjoy the infrastructure work and treat it as a learning opportunity.",
          "Managed hosting is the right choice if your goal is to have an agent, not to build the infrastructure layer for one. The setup time you spend configuring a VPS is time you are not spending on the work the agent is supposed to do for you.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No server setup: launch from the dashboard", other: "6–8 hours, by our estimate", hermosWins: true },
      { criterion: "Monthly infrastructure cost", hermesOs: "From $9.99/mo for 2 vCPU, 4 GB (managed)", other: "From €5.49/mo before VAT (unmanaged)", hermosWins: false },
      { criterion: "Agent dashboard", hermesOs: "Built-in, always running", other: "None — you build it", hermosWins: true },
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
        a: "For developers comfortable with Docker and Linux, it is manageable but time-consuming. For everyone else, it is a multi-day project. The ongoing maintenance is the part most people underestimate — not the initial setup.",
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
        q: "I already have a Hetzner server — can I run Hermes on it side by side with Hivra?",
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
    ],
    relatedBlog: [
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    ],
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
          "Railway is a developer-focused platform-as-a-service that makes it easy to deploy web applications, APIs, background workers, and databases. Its strengths are the developer experience — a clean UI, instant deploys from GitHub, a good database provisioning flow, and competitive pricing on per-usage billing.",
          "For stateless or lightly stateful web services, Railway is excellent. A Next.js app, a Python API, a PostgreSQL database — these are exactly what Railway is optimized for. The platform scales these kinds of services well and makes them easy to manage.",
        ],
      },
      {
        heading: "Where Railway falls short for Hermes",
        paragraphs: [
          "Hermes Agent is not a web service. It is a persistent process that maintains state, runs a browser, executes scheduled tasks, and accumulates memory over months of operation. This does not fit neatly into Railway's run model.",
          "The persistent volume configuration Railway provides works for databases, but the Hermes Agent memory system is more complex — it is memory files plus a session database, both with backup and recovery requirements. Configuring this correctly on Railway requires understanding the agent's internals and building the backup solution yourself.",
          "Railway does not have a natural construct for the agent's scheduled task system. Railway's cron schedule is set per service, and the service must exit when its task finishes, so each scheduled task becomes a separate short-lived service with no shared state with the main agent and no natural integration with the agent's memory context.",
          "There is also no agent dashboard on Railway. You deploy the container, you get logs. All the tooling that Hivra provides — chat and session history, file access, several agents in one dashboard, scheduled task management — you would build yourself.",
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
      { criterion: "Time to first running agent", hermesOs: "No setup: launch from the dashboard", other: "Hours of configuration", hermosWins: true },
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
        heading: "Render's strengths — and the limits for agents",
        paragraphs: [
          "Render excels at three things: simple static site hosting, background worker processes, and managed PostgreSQL/Redis databases. For web apps where you want to avoid the complexity of AWS or GCP, Render is an attractive middle ground between raw VPS and a full platform-as-a-service like Heroku.",
          "The issue with Hermes Agent is that it does not fit neatly into any of Render's service types. It is not a web service (it does not listen for HTTP requests). It is not a standard background worker (it has complex startup dependencies). And its storage needs are more specialized than a standard database volume.",
          "Render's free tier spins down web services after 15 minutes without inbound traffic, and free services cannot use a persistent disk. Hermes Agent cannot be cold-started — it needs to be always on to run scheduled tasks, maintain browser sessions, and serve the dashboard. Free tier is unusable for any real agent deployment on Render.",
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
          "Render's Starter compute plan ($7/month) has 512 MB RAM — far too little for Hermes. The Standard compute plan at $25/month gives 1 CPU and 2 GB RAM, which is workable for light use but will hit memory pressure during browser automation tasks. The Pro compute plan at $85/month gives 2 CPU and 4 GB RAM — the realistic minimum for reliable browser use.",
          "Add a Render Disk for persistent memory storage: $0.25/GB/month. Add RAM overhead when you factor in the Chromium process during browser tasks. The realistic monthly cost on Render for a properly configured Hermes agent is $85-100/month before any extra services.",
          "Hivra: from $9.99/month for 2 vCPU and 4 GB RAM, the same CPU and memory figures as Render's $85 Pro compute plan, with the browser pre-configured. The cost comparison is not close when you look at equivalent specs.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Pre-configured for Hermes", hermesOs: "Yes — fully", other: "No — build it yourself", hermosWins: true },
      { criterion: "Persistent memory storage", hermesOs: "Pre-configured, on the agent's own disk", other: "Manual disk/volume setup", hermosWins: true },
      { criterion: "Agent dashboard", hermesOs: "Built-in dashboard", other: "None", hermosWins: true },
      { criterion: "Browser automation environment", hermesOs: "Pre-installed", other: "Complex Docker setup required", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "Render Cron Jobs (a separate service)", hermosWins: true },
      { criterion: "Always-on (no sleep)", hermesOs: "Paid plans are never paused for inactivity", other: "Free sleeps after 15 idle minutes; always-on paid only", hermosWins: true },
      { criterion: "Monthly cost for 4 GB RAM", hermesOs: "$9.99/mo (2 vCPU, 4 GB)", other: "$85/mo (2 CPU, 4 GB) plus disk", hermosWins: true },
      { criterion: "Static site hosting", hermesOs: "Not supported", other: "Excellent and free", hermosWins: false },
    ],
    verdict:
      "For running a persistent Hermes AI agent, Hivra wins on setup work, agent tooling, and cost at equivalent specs. Render makes more sense for web apps and APIs — not for autonomous agent workloads requiring persistent processes and browser access.",
    faqs: [
      {
        q: "Does Render's free tier work for Hermes?",
        a: "No. Free web services spin down after 15 minutes without inbound traffic and cannot use a persistent disk, which Hermes needs for scheduled tasks and persistent memory. You need at minimum Render's Standard compute plan ($25/month, 1 CPU, 2 GB RAM).",
      },
      {
        q: "Is Render faster to set up than a raw VPS for Hermes?",
        a: "Slightly — you skip OS-level setup. But you still need to configure everything at the application layer including the Chromium dependencies, memory volumes, and monitoring. Hivra still needs far less setup.",
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
      "OpenClaw is a powerful open-source framework. If you have been using it, you have put real work into your agent setup — prompts, tools, workflows, memory.",
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
      { criterion: "Update management", hermesOs: "Tested before rollout", other: "Manual — sometimes breaking", hermosWins: true },
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
    h1: "Every option for hosting a persistent AI agent.",
    metaDescription:
      "AI agent hosting in 2026 compared: self-hosted VPS, Railway, Render, OpenClaw, and Hivra. An honest look at cost, setup, and upkeep for a persistent agent.",
    tagline: "Every option. Honest tradeoffs. No fluff.",
    intro: [
      "Running a persistent AI agent in 2026 is still harder than it should be. The agent frameworks have matured rapidly, but the hosting infrastructure has not kept up. Most options require significant DIY work.",
      "This is a complete, honest comparison of every viable approach — from raw VPS to managed platforms. We built Hivra, so we have an incentive to recommend it. We will tell you when other options make more sense.",
    ],
    sections: [
      {
        heading: "Option 1: Raw VPS (Hetzner, DigitalOcean, Vultr)",
        paragraphs: [
          "A raw VPS gives you the most flexibility. Hetzner's CX23 at €5.49/month before VAT is among the cheapest viable servers for Hermes — 2 vCPU, 4 GB RAM, enough for the agent plus light browser automation. DigitalOcean's 4 GB Droplet is $24/month.",
          "Setup takes 6-8 hours for someone comfortable with Linux: Ubuntu install, Docker/Compose setup, Caddy for reverse proxy and SSL, environment configuration, monitoring, and backup configuration. Once running, it is the most powerful and cheapest cash option.",
          "The catch: ongoing maintenance is real and non-trivial. Budget 1-2 hours per month. When things break (and they will), add debugging time on top. Best for: developers who want maximum control and treat the infrastructure work as part of the project.",
        ],
      },
      {
        heading: "Option 2: Railway and Render",
        paragraphs: [
          "Railway and Render are PaaS platforms designed for web applications. Both can theoretically run the Hermes Docker container, but neither is built for agent workloads — no native scheduling integration with the agent's memory context, no multi-agent tooling, no agent dashboard.",
          "Render's free tier spins services down after inactivity, which is incompatible with persistent agents, and its 2 CPU, 4 GB compute plan is $85/month. Railway bills for the CPU and memory you use, so an always-on agent's cost moves with its workload. Both require a custom Dockerfile and manual configuration of the memory persistence layer.",
          "Best for: teams already on these platforms for other services who want to avoid adding another platform. But the setup work is substantial.",
        ],
      },
      {
        heading: "Option 3: OpenClaw (self-hosted desktop app)",
        paragraphs: [
          "OpenClaw is an open-source (MIT) personal agent created by Peter Steinberger and its community, with hundreds of thousands of GitHub stars. It runs a gateway on your laptop or a server, works with hosted and local model providers, and you reach it from messaging apps such as Telegram, Discord, and WhatsApp. The community builds and shares skills for it.",
          "The framework is Node.js-based, well-documented, and actively maintained. For technical developers who want full local control with zero subscription fees beyond API costs, it is a capable and honest choice.",
          "Its main cost is operational: 24/7 operation requires keeping your machine on or running it on a VPS yourself (which is then effectively the same as Option 1). It has its own memory and scheduler, but they only work while that machine is up. Hivra can also host OpenClaw for you on paid plans (see Option 5). Best for: power users who want full control and treat agent infrastructure as a technical project.",
        ],
      },
      {
        heading: "Option 4: Serverless runtimes (Modal, Daytona, Fly.io)",
        paragraphs: [
          "Modal and Daytona offer serverless compute with near-zero idle cost — you pay only when the agent is actively executing. This suits agents with infrequent but compute-intensive tasks: a weekly deep-research run, a monthly data pipeline, batch processing jobs. Modal's GPU instances are particularly relevant for teams running local model inference alongside the agent.",
          "The limitation is cold-start latency and the lack of native agent tooling. You are deploying a container and building all monitoring, memory persistence, and scheduling logic yourself. Not suitable for sub-minute cron tasks or real-time response agents.",
          "Best for: developers already using Modal or Daytona for other compute workloads who want to add agent execution in the same billing account without a monthly fixed fee.",
        ],
      },
      {
        heading: "Option 5: Hivra",
        paragraphs: [
          "Hivra is managed hosting for AI agents: Hermes, OpenClaw, Claude Code, Codex, and others. For Hermes, the container, browser environment, memory persistence layer, and dashboard are all pre-configured. Sign up, add an API key or login, and launch.",
          "Hosting is $9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM. Automatic updates and 24/7 monitoring are included; backups are not guaranteed, so keep an export of anything you cannot lose. The trade: you are not running on your own infrastructure, and $9.99/month is higher than a Hetzner CX23's raw server cost.",
          "Best for: anyone who wants a running agent without spending days on infrastructure and ongoing maintenance hours every month.",
        ],
      },
      {
        heading: "How to choose",
        paragraphs: [
          "If you have specific requirements about data control, infrastructure cost is more important than your time, and you are comfortable with Linux: raw VPS is the right answer.",
          "If you already use Railway or Render for other services and want everything on one platform: the extra setup work may be justified by operational simplicity.",
          "If you want a running agent today and your time is the scarce resource: Hivra.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "No server setup", other: "2–8+ hours for alternatives", hermosWins: true },
      { criterion: "Hermes-specific tooling", hermesOs: "Native dashboard, multi-agent", other: "None in any alternative", hermosWins: true },
      { criterion: "Monthly cost floor", hermesOs: "Hosting from $9.99/mo (2 vCPU, 4 GB)", other: "€5.49/mo VPS before VAT (+ setup time)", hermosWins: false },
      { criterion: "Ongoing maintenance", hermesOs: "Server upkeep handled for you", other: "Regular on self-hosted options", hermosWins: true },
      { criterion: "Persistent memory", hermesOs: "Built-in, on the agent's own disk", other: "DIY on all alternatives", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Manual on all alternatives", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "DIY or not available", hermosWins: true },
      { criterion: "Full infrastructure control", hermesOs: "Dashboard + container shell", other: "Full on VPS options", hermosWins: false },
      { criterion: "Money-back guarantee", hermesOs: "Yes, 7 days, card payments only", other: "No", hermosWins: true },
    ],
    verdict:
      "Hivra is the right choice for anyone who wants a persistent agent running without becoming a part-time sysadmin. Self-hosted VPS is the right choice for developers who want complete control and do not mind the setup cost. Railway and Render are built for web apps — not persistent agent workloads.",
    faqs: [
      {
        q: "What is the cheapest way to host a Hermes AI agent in 2026?",
        a: "For the lowest cash cost, a Hetzner CX23 at €5.49/month before VAT is hard to beat, but you still need to factor in 6-8 hours of setup time and ongoing maintenance. Hivra hosting at $9.99/month (2 vCPU, 4 GB) is usually cheaper when you count your time.",
      },
      {
        q: "Can I run a Hermes agent on a free tier service?",
        a: "Not reliably on generic free tier hosts. Hermes requires a persistent process. Render's free web services spin down after 15 minutes without traffic, and Railway's free plan comes with only $1 of usage credit a month, which do not suit persistent agent operation and scheduled tasks. Hivra's paid plans are never paused for inactivity, so scheduled tasks keep running.",
      },
      {
        q: "What is the best AI agent hosting for beginners?",
        a: "Hivra — no Linux knowledge, no Docker, no networking required. If you are comfortable with a terminal and want full control, a Hetzner VPS is the most cost-effective option with the highest ceiling.",
      },
      {
        q: "Is Hivra the only managed Hermes agent hosting service?",
        a: "We do not track every provider, so we will not claim to be the only one. What Hivra focuses on is running several agents side by side, including Hermes, OpenClaw, Claude Code, and Codex, at a flat monthly price.",
      },
      {
        q: "What about running Hermes on Fly.io or Kamal?",
        a: "Both are valid options for developers who want PaaS-style deployment with more control than Railway/Render. Fly.io in particular has good support for persistent volumes. Neither provides agent-specific tooling or a dashboard — you are still building the platform layer yourself.",
      },
    ],
    relatedComparisons: [
      { slug: "vs-self-hosted", title: "Hivra vs Self-Hosted VPS" },
      { slug: "vs-railway", title: "Hivra vs Railway" },
      { slug: "openclaw-to-hermes", title: "OpenClaw to Hermes Migration" },
    ],
    relatedBlog: [
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    ],
  },
};

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
    <section><h2>Feature comparison</h2><div className={styles.tableScroll} role="region" aria-label="Feature comparison" tabIndex={0}><table><thead><tr><th scope="col">Criterion</th><th scope="col">Hivra</th><th scope="col">Alternative</th></tr></thead><tbody>{comparison.vsTable.map(({ criterion, hermesOs, other, hermosWins }) => <tr key={criterion}><th scope="row">{criterion}</th><td>{hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{hermesOs}</td><td>{!hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{other}</td></tr>)}</tbody></table></div></section><section className={styles.verdict}><h2>Verdict</h2><p>{comparison.verdict}</p></section><EditorialQuestions questions={comparison.faqs} /></div></div><EditorialCTA title={<>Ready to <strong>stop managing infra?</strong></>} label="Deploy My Agent" /><EditorialRelated links={[...comparison.relatedComparisons.map(({ slug, title }) => ({ label: title, href: `/compare/${slug}` })), ...(comparison.relatedBlog ?? []).map(({ slug, title }) => ({ label: `Blog: ${title}`, href: `/blog/${slug}` })), ...(comparison.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })), ...(comparison.externalRelated ?? []), { label: "Pricing", href: "/pricing" }, { label: "All Features", href: "/features" }]} /></main></PublicSite>);
}
