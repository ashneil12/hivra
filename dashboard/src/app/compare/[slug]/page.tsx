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
};

const COMPARISONS: Record<string, ComparisonData> = {
  "vs-self-hosted": {
    title: "Hivra vs Self-Hosted VPS: Which Should You Choose?",
    h1: "Self-hosting Hermes: the honest tradeoff.",
    metaDescription:
      "Hivra vs self-hosted VPS on Hetzner or DigitalOcean. Honest comparison of cost, setup time, maintenance, and reliability for running a persistent Hermes AI agent.",
    tagline: "Control vs. time. Here's what it actually costs.",
    intro: [
      "Self-hosting Hermes is technically possible and sometimes the right call. Hetzner's CX22 costs €7.49/mo for a VPS you fully control. You are not saving money with Hivra — you are saving time.",
      "The honest accounting: setting up a Hermes agent on a raw VPS takes 6-8 hours the first time. Docker, Caddy, networking, SSH keys, env files, monitoring. Then it breaks on the next update, and you spend another evening fixing it.",
    ],
    sections: [
      {
        heading: "What self-hosting actually costs over a year",
        paragraphs: [
          "The server itself is cheap. Hetzner's CX22 (~€7.49/month, 2 vCPU 4 GB RAM) is €90/year for a server you fully control. CX32 (€17.99/month, 4 vCPU 8 GB RAM) is the better choice once you are running browser automation or parallel subagents. DigitalOcean's equivalent is $24-48/month. Modal or Daytona serverless are a third option — near-zero idle cost at the expense of cold-start latency, suitable for infrequent heavy tasks but not sub-minute cron jobs.",
          "Initial setup: 4-8 hours for a developer who knows Linux. At $50/hour effective rate, that is $200-400 of time just to get started.",
          "Ongoing maintenance: budget 1-2 hours per month minimum — Hermes updates, Docker daemon issues, certificate renewals, dependency conflicts. Infrastructure failures and disk-fill events add time on top. Over a year: 15-20 hours. At $50/hour: $750-1000.",
          "Total real cost of self-hosting for one year at CX22 pricing, with time factored in: $1000-1300 against $90 in raw server fees. Hivra Pro at $9.99/month is $120/year, zero maintenance hours. The gap widens once you value your time honestly.",
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
          "Update management is the main pain point. Nous Research ships updates to Hermes Agent that sometimes change the memory storage schema, update required environment variables, or introduce new dependencies. On self-hosted setups, applying these requires manual steps and testing. On Hivra, updates are tested before rolling out and applied without breaking your configuration.",
          "Backup reliability is the second failure mode. The agent's memory volume needs regular off-host backups. Most self-hosters either do not set this up, or set it up incorrectly and discover the problem when they need to restore. Daily encrypted backups are automatic on Hivra.",
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
      { criterion: "Time to first running agent", hermesOs: "Under 5 minutes", other: "6–8 hours minimum", hermosWins: true },
      { criterion: "Monthly infrastructure cost", hermesOs: "$9.99–$19.99/mo (managed)", other: "€7.49–20/mo (unmanaged)", hermosWins: false },
      { criterion: "Agent dashboard", hermesOs: "Built-in, always running", other: "None — you build it", hermosWins: true },
      { criterion: "Automatic updates", hermesOs: "Tested, non-breaking", other: "Manual, sometimes breaking", hermosWins: true },
      { criterion: "Multi-agent slots", hermesOs: "3 on Pro, 5 on Power", other: "Manual configuration per agent", hermosWins: true },
      { criterion: "Monitoring & restarts", hermesOs: "Automatic", other: "You set it up or it does not exist", hermosWins: true },
      { criterion: "Persistent memory backups", hermesOs: "Automatic daily, encrypted", other: "You configure and maintain", hermosWins: true },
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
        a: "Yes. Hivra imports your existing agent configuration and memory. The migration takes about 15 minutes.",
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
        a: "On self-hosted, your agent's memory and logs stay on your server. On Hivra, they are stored on our infrastructure, encrypted at rest. API traffic always passes through your AI provider regardless of where the agent is hosted.",
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
      "Hivra vs Railway for hosting a Hermes AI agent. Railway is generic cloud — Hivra is purpose-built. Here's the honest difference in setup, cost, and capabilities.",
    tagline: "Generic cloud vs. purpose-built agent hosting.",
    intro: [
      "Railway is a genuinely good platform. If you are deploying a Node.js API or a Next.js app, it is excellent. Deploying a Hermes agent is a different problem.",
      "On Railway, you would write your own Dockerfile, configure your own persistent storage for agent memory, build your own monitoring, and get no agent dashboard or multi-agent tooling. You would also be paying roughly comparable rates for the compute once you account for what Hermes actually needs.",
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
          "The persistent volume configuration Railway provides works for databases, but the Hermes Agent memory system is more complex — it is not just file storage, it is a vector store with backup and recovery requirements. Configuring this correctly on Railway requires understanding the agent's internals and building the backup solution yourself.",
          "Railway does not have a natural construct for the agent's scheduled task system. You could use Railway Cron for individual scheduled tasks, but it requires a separate service per task, no shared state with the main agent, and no natural integration with the agent's memory context.",
          "There is also no agent dashboard on Railway. You deploy the container, you get logs. All the tooling that Hivra provides — session viewer, memory browser, multi-agent coordination, scheduled task management — you would build yourself.",
        ],
      },
      {
        heading: "Cost comparison at typical agent usage",
        paragraphs: [
          "Railway's pricing is usage-based: you pay per vCPU-hour and per GB-hour of RAM. For a Hermes agent running 24/7 with 2 vCPU and 4 GB RAM, the monthly compute cost on Railway is approximately $22-28/month. Add the persistent volume and the cost of any additional services (monitoring, separate cron jobs) and you are at $30-40/month.",
          "Hivra Power plan is $19.99/month for 4 vCPU and 8 GB RAM. More compute, more RAM, all agent tooling included, and no setup work. The Railway route costs more and gives you less for the specific use case.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Time to first running agent", hermesOs: "Under 5 minutes", other: "Hours of configuration", hermosWins: true },
      { criterion: "Hermes-specific configuration", hermesOs: "Pre-configured out of the box", other: "DIY from scratch", hermosWins: true },
      { criterion: "Agent dashboard & monitoring", hermesOs: "Built-in", other: "None", hermosWins: true },
      { criterion: "Multi-agent slots", hermesOs: "3 on Pro, 5 on Power", other: "Manual configuration", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Requires custom Docker setup", hermosWins: true },
      { criterion: "Memory persistence & backups", hermesOs: "Pre-configured, daily backups", other: "Manual volume + backup setup", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "Separate Railway Cron service", hermosWins: true },
      { criterion: "General-purpose app hosting", hermesOs: "Not the focus", other: "Excellent", hermosWins: false },
      { criterion: "Monthly cost for equivalent compute", hermesOs: "$19.99/mo (4 vCPU, 8 GB)", other: "$22–30/mo for 2 vCPU, 4 GB", hermosWins: true },
    ],
    verdict:
      "If you are deploying a Hermes AI agent, Hivra is the faster and cheaper choice with more agent-specific tooling. If you need to deploy other web services alongside it, run those on Railway and the agent on Hivra.",
    faqs: [
      {
        q: "Can I actually deploy Hermes Agent to Railway?",
        a: "Technically yes, with a custom Dockerfile. But you get no native agent support, no dashboard, no multi-agent tooling, and need to configure memory persistence and scheduled tasks yourself. It is significant DIY work for a comparable or higher monthly cost.",
      },
      {
        q: "Is Railway cheaper than Hivra?",
        a: "For the compute Hermes needs, Railway ends up at $22-30/month before adding services for monitoring and task scheduling. Hivra at $9.99/month includes all of that. Railway per-usage pricing only helps for services that can scale to zero between requests — which Hermes cannot.",
      },
      {
        q: "Does Hivra support multiple regions like Railway?",
        a: "Hivra currently provisions agents in US East, US West, EU Central, and EU West. Multi-region agent coordination across instances is on the roadmap.",
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
          "Render's free tier spins down services after 15 minutes of inactivity. Hermes Agent cannot be cold-started — it needs to be always on to run scheduled tasks, maintain browser sessions, and serve the dashboard. Free tier is unusable for any real agent deployment on Render.",
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
          "Render's Starter plan ($7/month) has 512 MB RAM — far too little for Hermes. The Standard plan at $25/month gives 2 GB RAM, which is workable for light use but will hit memory pressure during browser automation tasks. The Pro plan at $85/month gives 4 GB RAM — the realistic minimum for reliable browser use.",
          "Add a Render Disk for persistent memory storage: $0.25/GB/month. Add RAM overhead when you factor in the Chromium process during browser tasks. The realistic monthly cost on Render for a properly configured Hermes agent is $85-100/month before any extra services.",
          "Hivra Power plan: $19.99/month, 4 vCPU, 8 GB RAM, browser pre-configured, backups included. The cost comparison is not close when you look at equivalent specs.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Pre-configured for Hermes", hermesOs: "Yes — fully", other: "No — build it yourself", hermosWins: true },
      { criterion: "Persistent memory storage", hermesOs: "Pre-configured, backed up daily", other: "Manual disk/volume setup", hermosWins: true },
      { criterion: "Agent dashboard", hermesOs: "Built-in dashboard", other: "None", hermosWins: true },
      { criterion: "Browser automation environment", hermesOs: "Pre-installed", other: "Complex Docker setup required", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "Render Cron (limited, separate)", hermosWins: true },
      { criterion: "Always-on (no sleep)", hermesOs: "Pro never pauses; Free runs 4 idle days", other: "Sleeps in minutes; always-on paid only", hermosWins: true },
      { criterion: "Monthly cost for 4 GB RAM+", hermesOs: "$19.99/mo (8 GB included)", other: "$85–100/mo equivalent", hermosWins: true },
      { criterion: "Static site hosting", hermesOs: "Not supported", other: "Excellent and free", hermosWins: false },
      { criterion: "Free tier", hermesOs: "Yes — free plan for one guarded agent", other: "Yes (with sleep, unusable for agents)", hermosWins: true },
    ],
    verdict:
      "For running a persistent Hermes AI agent, Hivra wins on setup speed, agent tooling, and cost at equivalent specs. Render makes more sense for web apps and APIs — not for autonomous agent workloads requiring persistent processes and browser access.",
    faqs: [
      {
        q: "Does Render's free tier work for Hermes?",
        a: "No. Free tier services spin down after 15 minutes of inactivity and cannot be cold-started in the way Hermes requires for scheduled tasks and persistent memory. You need at minimum Render's Standard plan ($25/month, 2 GB RAM).",
      },
      {
        q: "Is Render faster to set up than a raw VPS for Hermes?",
        a: "Slightly — you skip OS-level setup. But you still need to configure everything at the application layer including the Chromium dependencies, memory volumes, and monitoring. Hivra is still significantly faster.",
      },
      {
        q: "What does Render lack that Hivra provides?",
        a: "Agent dashboard, multi-agent profile management, pre-configured browser automation, Hermes-specific memory persistence and backups, scheduled task management, and native OpenClaw migration.",
      },
      {
        q: "Can I run Hermes on Render's cheapest plan with 512 MB RAM?",
        a: "No. Even without browser automation, Hermes needs at least 1.5-2 GB RAM to run stably. The Starter plan at 512 MB will crash under normal agent operation.",
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
      "How to migrate from OpenClaw to Hivra managed hosting. Keep your agents, prompts, and tools — drop the self-hosting maintenance. Native migration built in.",
    tagline: "Migrate in minutes. Leave the maintenance behind.",
    intro: [
      "OpenClaw is a powerful open-source framework. If you have been using it, you have put real work into your agent setup — prompts, tools, workflows, memory.",
      "Hivra has a native migration path that imports your existing OpenClaw configuration. Your prompts, skills, and tools come with you. What you leave behind is the maintenance burden.",
    ],
    sections: [
      {
        heading: "What OpenClaw does well",
        paragraphs: [
          "OpenClaw's main strength is computer use — giving Claude control of a browser and desktop environment to navigate websites, fill forms, and interact with interfaces the way a human would. For technical developers who want this capability and are comfortable self-hosting, OpenClaw is a capable tool with an active community.",
          "The ecosystem includes contributed tool libraries, community configurations for common use cases, and active development. If you are deeply embedded in the OpenClaw community and your work benefits from following the upstream development closely, that is a real value.",
        ],
      },
      {
        heading: "Where the operational friction accumulates",
        paragraphs: [
          "OpenClaw runs as a desktop application — which means your computer needs to be on for the agent to work. For any use case requiring 24/7 operation or scheduled tasks, this is a hard architectural limitation. You cannot run a 6am daily brief from an application that requires your laptop to be awake.",
          "Memory is session-scoped in OpenClaw's default configuration. There is no native long-term memory that persists across sessions. Community solutions exist, but they require additional setup and are fragile.",
          "Update management is manual. When a new version of OpenClaw ships or when Anthropic's computer use API changes its response format, you update the application. Occasionally these updates are breaking and require debugging your configuration.",
        ],
      },
      {
        heading: "What to expect during migration",
        paragraphs: [
          "Hermes v0.5.0 ships a native OpenClaw import tool accessible from the CLI: `hermes import --from openclaw --path /path/to/export`. It reads exported OpenClaw configuration and imports agent prompts, API key settings, and skill documents automatically — no manual reformatting required. The migration wizard runs interactively and confirms each imported component before committing.",
          "Tool configurations in the agentskills.io format import directly. Custom tools written as shell scripts or Python can be uploaded to a dedicated tool directory via the dashboard's upload interface.",
          "Browser session credentials do not migrate because they are machine-local. The first time the agent needs to access an authenticated site on Hivra, it logs in and the session is then stored on the cloud server persistently. The full migration — from export to a running agent on Hivra — takes 15-30 minutes for a typical OpenClaw setup.",
        ],
      },
      {
        heading: "What Hivra adds that OpenClaw does not have",
        paragraphs: [
          "Persistent memory across sessions, with daily encrypted backups. Scheduled task execution that runs whether your machine is on or not — with event hooks for conditional triggering of follow-up tasks. Multi-agent slots on a single subscription, with 3 active agents on Pro and 5 on Power. A purpose-built dashboard with session streaming, memory browser (`MEMORY.md`/`USER.md` review), task history, and checkpoint rollback.",
          "Model support is also broader: OpenClaw is Node.js-based and optimized for Claude via Anthropic's API (the community primarily uses Sonnet 4.6 and Haiku 4.5). Hivra supports the full Claude family, GPT-5.4 ($2.50/$15 per MTok, 1M context, native computer use), GPT-5 mini ($0.25/$2 per MTok), and 300+ models via OpenRouter — switchable per agent profile without changing platforms.",
        ],
      },
    ],
    vsTable: [
      { criterion: "Hosting model", hermesOs: "Cloud-hosted, persistent 24/7", other: "Local application on your machine", hermosWins: true },
      { criterion: "Update management", hermesOs: "Tested updates, non-breaking", other: "Manual — sometimes breaking", hermosWins: true },
      { criterion: "Memory across sessions", hermesOs: "Built-in (USER.md + MEMORY.md + Skills), backed up daily", other: "Session-scoped by default", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native cron + event hooks", other: "Not supported natively", hermosWins: true },
      { criterion: "Multi-agent slots", hermesOs: "3 on Pro, 5 on Power", other: "One session at a time", hermosWins: true },
      { criterion: "Agent dashboard", hermesOs: "Purpose-built, streaming + memory browser", other: "Community UIs — quality varies", hermosWins: true },
      { criterion: "OpenClaw community (214k+ stars)", hermesOs: "Separate ecosystem", other: "Active, large community", hermosWins: false },
      { criterion: "Model support", hermesOs: "Claude, GPT-5.4, GPT-5 mini, 300+ OpenRouter", other: "Claude-focused (Node.js optimized)", hermosWins: true },
      { criterion: "Cost", hermesOs: "From $9.99/mo", other: "Free (self-hosted) + API costs", hermosWins: false },
    ],
    verdict:
      "If you love tinkering with OpenClaw and do not mind the maintenance, stay. If you want your agents running reliably 24/7 without handling updates and infrastructure, Hivra is the natural next step.",
    faqs: [
      {
        q: "What exactly migrates from OpenClaw to Hivra?",
        a: "System prompts, agent instructions, tool configurations in agentskills.io format, and exported memory state. Custom shell/Python tools can be uploaded to the server's tool directory.",
      },
      {
        q: "Will all my OpenClaw tools work on Hivra?",
        a: "Core browser automation and API-calling tools work natively. Tools that depend on local machine resources need adapting for the cloud container environment. Most tool migrations take under an hour.",
      },
      {
        q: "What if I want to go back to OpenClaw after trying Hivra?",
        a: "Your agent configuration can be exported from Hivra at any time. There is no lock-in.",
      },
      {
        q: "OpenClaw uses Claude's computer use API. Does Hivra?",
        a: "Yes. Hivra supports Anthropic's computer use API for Claude models when you connect your Anthropic API key. You can also switch between models per agent profile.",
      },
      {
        q: "Do I lose the OpenClaw community features and plugins?",
        a: "The OpenClaw community plugin ecosystem is not directly compatible with Hivra. Many common tool capabilities are built into Hermes Agent's 40+ native tools, but community-specific plugins would need to be ported.",
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
  },

  "ai-agent-hosting-alternatives": {
    title: "Best AI Agent Hosting Platforms in 2026",
    h1: "Every option for hosting a persistent AI agent.",
    metaDescription:
      "The complete guide to AI agent hosting in 2026: self-hosted VPS, Railway, Render, OpenClaw, and Hivra. Honest comparison of cost, setup, and maintenance for persistent agent deployment.",
    tagline: "Every option. Honest tradeoffs. No fluff.",
    intro: [
      "Running a persistent AI agent in 2026 is still harder than it should be. The agent frameworks have matured rapidly, but the hosting infrastructure has not kept up. Most options require significant DIY work.",
      "This is a complete, honest comparison of every viable approach — from raw VPS to managed platforms. We built Hivra, so we have an incentive to recommend it. We will tell you when other options make more sense.",
    ],
    sections: [
      {
        heading: "Option 1: Raw VPS (Hetzner, DigitalOcean, Vultr)",
        paragraphs: [
          "A raw VPS gives you the most flexibility. Hetzner's CX22 at €7.49/month is the cheapest viable server for Hermes — 2 vCPU, 4 GB RAM, enough for the agent plus light browser automation. DigitalOcean's 4 GB Droplet is $24/month. Vultr and Linode fall in between.",
          "Setup takes 6-8 hours for someone comfortable with Linux: Ubuntu install, Docker/Compose setup, Caddy for reverse proxy and SSL, environment configuration, monitoring, and backup configuration. Once running, it is the most powerful and cheapest cash option.",
          "The catch: ongoing maintenance is real and non-trivial. Budget 1-2 hours per month. When things break (and they will), add debugging time on top. Best for: developers who want maximum control and treat the infrastructure work as part of the project.",
        ],
      },
      {
        heading: "Option 2: Railway and Render",
        paragraphs: [
          "Railway and Render are PaaS platforms designed for web applications. Both can theoretically run the Hermes Docker container, but neither is built for agent workloads — no native scheduling integration with the agent's memory context, no multi-agent tooling, no agent dashboard.",
          "Render's free tier spins services down after inactivity — incompatible with persistent agents. Railway's per-usage pricing works out comparable to or more expensive than Hivra for the compute Hermes needs. Both require a custom Dockerfile and manual configuration of the memory persistence layer.",
          "Best for: teams already on these platforms for other services who want to avoid adding another platform. But the setup work is substantial and the monthly cost is not lower.",
        ],
      },
      {
        heading: "Option 3: OpenClaw (self-hosted desktop app)",
        paragraphs: [
          "OpenClaw is an open-source agent framework built by Peter Steinberger's team, released in November 2025 and accumulating 214,000+ GitHub stars rapidly. It runs as a desktop application connecting to Claude models for computer use — browser control, code execution, file operations. The community has built 700+ community skills in the agentskills.io format.",
          "The framework is Node.js-based, well-documented, and actively maintained. For technical developers who want full local control with zero subscription fees beyond API costs, it is a capable and honest choice.",
          "Its limitations are architectural: it is a local process, not a server. 24/7 operation requires keeping your machine on or running it on a VPS yourself (which is then effectively the same as Option 1). No built-in persistent memory across installs. No native cron scheduling. Best for: power users who want full control and treat agent infrastructure as a technical project.",
        ],
      },
      {
        heading: "Option 4: Serverless runtimes (Modal, Daytona, Fly.io)",
        paragraphs: [
          "Modal and Daytona offer serverless compute with near-zero idle cost — you pay only when the agent is actively executing. This suits agents with infrequent but compute-intensive tasks: a weekly deep-research run, a monthly data pipeline, batch processing jobs. Modal's GPU instances are particularly relevant for teams running local model inference alongside the agent.",
          "The limitation is cold-start latency (3-15 seconds depending on image size) and the lack of native agent tooling. You are deploying a container and building all monitoring, memory persistence, and scheduling logic yourself. Not suitable for sub-minute cron tasks or real-time response agents.",
          "Best for: developers already using Modal or Daytona for other compute workloads who want to add agent execution in the same billing account without a monthly fixed fee.",
        ],
      },
      {
        heading: "Option 5: Hivra",
        paragraphs: [
          "Hivra is managed cloud hosting purpose-built for Hermes Agent. The container, browser environment, memory persistence layer, and dashboard are all pre-configured. Sign up, paste an API key, running agent in under 5 minutes.",
          "Plans start at $9.99/month (Pro: 2 vCPU, 4 GB RAM, 3 active agents) and $19.99/month (Power: 4 vCPU, 8 GB RAM, 5 active agents). Daily encrypted backups, automatic updates, and 24/7 monitoring included. The trade: you are not running on your own infrastructure, and $9.99/month is higher than a Hetzner CX22's raw server cost.",
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
      { criterion: "Time to first running agent", hermesOs: "5 minutes", other: "2–8+ hours for alternatives", hermosWins: true },
      { criterion: "Hermes-specific tooling", hermesOs: "Native dashboard, multi-agent", other: "None in any alternative", hermosWins: true },
      { criterion: "Monthly cost floor", hermesOs: "Free tier live; paid plans from $9.99/mo", other: "€7.49/mo VPS (+ 8h setup time)", hermosWins: true },
      { criterion: "Ongoing maintenance", hermesOs: "Zero — fully managed", other: "Regular on self-hosted options", hermosWins: true },
      { criterion: "Persistent memory", hermesOs: "Built-in, backed up daily", other: "DIY on all alternatives", hermosWins: true },
      { criterion: "Browser automation", hermesOs: "Pre-configured", other: "Manual on all alternatives", hermosWins: true },
      { criterion: "Scheduled tasks", hermesOs: "Native agent scheduling", other: "DIY or not available", hermosWins: true },
      { criterion: "Full infrastructure control", hermesOs: "Dashboard + SSH opt-in", other: "Full on VPS options", hermosWins: false },
      { criterion: "Money-back guarantee", hermesOs: "Yes (7-day)", other: "No", hermosWins: true },
    ],
    verdict:
      "Hivra is the right choice for anyone who wants a persistent agent running without becoming a part-time sysadmin. Self-hosted VPS is the right choice for developers who want complete control and do not mind the setup cost. Railway and Render are built for web apps — not persistent agent workloads.",
    faqs: [
      {
        q: "What is the cheapest way to host a Hermes AI agent in 2026?",
        a: "Hivra Free is the cheapest way to start with a managed persistent agent. For heavier workloads, Hetzner CX22 at €7.49/month can be the cheapest raw VPS cash cost, but you still need to factor in 6-8 hours of setup time and ongoing maintenance. Hivra Pro at $9.99/month is usually cheaper when you count your time.",
      },
      {
        q: "Can I run a Hermes agent on a free tier service?",
        a: "Not reliably on generic free tier hosts. Hermes requires a persistent process. Free tiers on Railway, Render, and Fly.io spin down inactive services within minutes, which is incompatible with persistent agent operation and scheduled tasks. Hivra Free runs a guarded starter agent that only sleeps after 4 idle days — and a single tap restores it. For an agent that never pauses for inactivity, Pro stays always-on.",
      },
      {
        q: "What is the best AI agent hosting for beginners?",
        a: "Hivra — no Linux knowledge, no Docker, no networking required. If you are comfortable with a terminal and want full control, a Hetzner VPS is the most cost-effective option with the highest ceiling.",
      },
      {
        q: "Is Hivra the only managed Hermes agent hosting service?",
        a: "As of early 2026, Hivra is the only purpose-built managed hosting platform for Hermes agents specifically.",
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
    <section><h2>Feature comparison</h2><div className={styles.tableScroll} role="region" aria-label="Feature comparison" tabIndex={0}><table><thead><tr><th scope="col">Criterion</th><th scope="col">Hivra</th><th scope="col">Alternative</th></tr></thead><tbody>{comparison.vsTable.map(({ criterion, hermesOs, other, hermosWins }) => <tr key={criterion}><th scope="row">{criterion}</th><td>{hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{hermesOs}</td><td>{!hermosWins ? <CheckCircle size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{other}</td></tr>)}</tbody></table></div></section><section className={styles.verdict}><h2>Verdict</h2><p>{comparison.verdict}</p></section><EditorialQuestions questions={comparison.faqs} /></div></div><EditorialCTA title={<>Ready to <strong>stop managing infra?</strong></>} label="Deploy My Agent" /><EditorialRelated links={[...comparison.relatedComparisons.map(({ slug, title }) => ({ label: title, href: `/compare/${slug}` })), ...(comparison.relatedBlog ?? []).map(({ slug, title }) => ({ label: `Blog: ${title}`, href: `/blog/${slug}` })), ...(comparison.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })), { label: "All Features", href: "/features" }]} /></main></PublicSite>);
}
