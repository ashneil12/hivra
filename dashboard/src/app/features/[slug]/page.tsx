import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialCTA, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle } from "lucide-react";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";

type FeatureSection = {
  heading: string;
  paragraphs: string[];
};

type FeatureData = {
  title: string;
  h1: string;
  metaDescription: string;
  tagline: string;
  intro: string[];
  sections: FeatureSection[];
  bullets: string[];
  relatedFeatures: Array<{ slug: string; title: string }>;
  relatedBlog?: Array<{ slug: string; title: string }>;
  /** Off-site references, such as upstream docs a paragraph relies on. */
  externalRelated?: Array<{ label: string; href: string }>;
  faqs: Array<{ q: string; a: string }>;
};

// Hermes' own OpenClaw migration guide (`hermes claw migrate`), checked
// 2026-09-24. Hivra has no OpenClaw import of its own.
const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";

const FEATURES: Record<string, FeatureData> = {
  "persistent-memory": {
    title: "Persistent Memory for AI Agents",
    h1: "Your agent remembers everything.",
    metaDescription:
      "Host a Hermes AI agent with persistent memory across every session. No resets, no re-explaining: your agent builds on what it learned, on Hivra.",
    tagline: "Every session. Every project. Every lesson retained.",
    intro: [
      "Most AI tools reset the moment you close the tab. Every new conversation starts from zero — you re-explain your stack, your preferences, your context. It compounds into wasted hours.",
      "Hermes agents are different. They live on a persistent server. When you come back tomorrow, next week, or six months from now, the agent knows your name, your projects, your decisions, and what it was working on.",
    ],
    sections: [
      {
        heading: "What \"persistent\" actually means here",
        paragraphs: [
          "Context windows — the amount of text a language model can process at once — are not persistence. A 200,000-token context window still resets to zero when you start a new session. The model does not remember the previous conversation unless you manually paste it back in.",
          "Persistent memory is a separate system that runs alongside the model. Between sessions, a memory layer stores what the agent has learned about you, your projects, and its own task history. At the start of a new session, relevant memories are retrieved and loaded into context. The agent does not start from scratch — it picks up where it left off.",
          "This is how Hermes Agent is designed to work, and it is the main reason people use it over a general-purpose chatbot.",
        ],
      },
      {
        heading: "Three memory types Hermes uses",
        paragraphs: [
          "The user model is a structured record of who you are: your technical preferences, your communication style, the projects you are running, your time zone, how you like results reported. This loads at the start of every session and shapes how the agent responds without you having to re-explain.",
          "Skill Documents are procedural memory — records of how the agent solved a particular class of problem. When Hermes successfully scrapes a tricky website, processes a specific data format, or debugs a pattern of error, it can synthesize that experience into a reusable document. The next similar task takes less time and requires less guidance because the agent already knows a working approach.",
          "Event memory is a timestamped log: tasks undertaken, decisions made, results achieved, failures encountered and how they were handled. This is what lets the agent tell you what it did last Tuesday, or explain why it made a particular call three weeks ago.",
        ],
      },
      {
        heading: "Why this requires a server that stays on",
        paragraphs: [
          "Memory stored in a local application disappears if you reinstall, switch machines, or the application crashes. For memory to be genuinely useful over months of agent use, it needs to live somewhere persistent — a server with its own storage, separate from your local environment.",
          "This is why running an agent locally on your laptop is fundamentally limited for memory-intensive use. You get the capability during the session, but you lose the compounding effect that makes the agent genuinely useful over time.",
          "Hivra keeps the memory on the agent's own cloud server, not on your laptop. If you switch to a new computer, your agent's memory is exactly where you left it. Nothing is tied to a local process. Backup coverage depends on the runtime and provider and is not guaranteed, so keep an export of anything you cannot afford to lose.",
        ],
      },
      {
        heading: "Memory isolation across agent profiles",
        paragraphs: [
          "If you run multiple agent profiles — a research agent, a coding agent, a customer support agent — each profile has a completely separate memory store. They do not share context and cannot contaminate each other's working memory.",
          "The one shared piece is optional account memory for Claude Code and Codex agents: notes you write once on the dashboard's shared memory page are copied into each new Claude Code or Codex agent you launch. Hermes agents do not receive it. After that, each agent's memory evolves on its own. Agents do not coordinate or share memory automatically; if you want one agent to use another's notes, you pass them across yourself.",
        ],
      },
      {
        heading: "Memory review and correction",
        paragraphs: [
          "Hermes keeps its memory in plain files (USER.md and MEMORY.md) rather than a hidden store. If the agent learned an incorrect assumption — a wrong belief about how a system works, a mistaken preference — you can ask it to correct or remove that memory directly rather than waiting for it to get overwritten through repeated correction in conversation.",
          "You can also download those memory files from the agent's file explorer. Claude Code and Codex agents add an Export data link on the agent's page that downloads their chats and memory as one JSON file. If you ever want to move to a self-hosted setup or a different hosting provider, you are not locked in by accumulated state.",
        ],
      },
    ],
    bullets: [
      "Full conversation and task history retained across sessions",
      "User model lives in USER.md — goals, preferences, communication style, project context",
      "General knowledge lives in MEMORY.md — curated facts the agent reads at session start",
      "Skill Documents: agentskills.io open format, procedural memory that compounds over time",
      "Event log: timestamped record of every task and decision",
      "Optional Honcho integration: cross-session AI-native user modeling across tools",
      "Checkpoint and rollback support — /rollback command reverts file changes",
      "Memory isolated per agent profile — multiple agents, no cross-contamination",
      "Shared account memory for new Claude Code and Codex agents, edited once in the dashboard",
      "Memory files you can download from the file explorer, so you are not locked in",
    ],
    relatedFeatures: [
      { slug: "multi-agent", title: "Multiple Agents" },
      { slug: "scheduled-tasks", title: "Scheduled Tasks" },
      { slug: "browser-automation", title: "Browser Automation" },
    ],
    relatedBlog: [
      { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
      { slug: "what-is-hermes-agent", title: "What is Hermes Agent?" },
    ],
    faqs: [
      {
        q: "How long does persistent memory last on Hivra?",
        a: "Your agent's memory stays on its server for as long as the agent exists. Backups are not guaranteed, so download an export of anything you cannot afford to lose.",
      },
      {
        q: "Can I reset or wipe an agent's memory?",
        a: "Yes. Ask the agent to remove a specific memory, or delete the agent to wipe everything. Selective removal is supported — you do not have to wipe everything to correct one wrong memory.",
      },
      {
        q: "Does memory work across different agent profiles?",
        a: "Each agent has its own memory. Agents do not share memory automatically; the only shared piece is optional account memory, which is copied into each new Claude Code or Codex agent when you launch it.",
      },
      {
        q: "What format is the memory export?",
        a: "Hermes memory is plain Markdown files (USER.md and MEMORY.md), which you can download from the agent's file explorer. Claude Code and Codex agents also have an Export data link on the agent's page that downloads chats plus memory as a single JSON file with a versioned schema, so your data is yours to keep, read, or move.",
      },
      {
        q: "Is the memory encrypted?",
        a: "Connections to your agent use HTTPS. The memory files themselves live on the agent's server disk, and Hivra does not promise separate encryption for them, so do not keep secrets in agent memory.",
      },
      {
        q: "Can the agent's memory get too large and slow things down?",
        a: "Not usually. Hermes keeps its core memory files short and curated, and uses full-text search over past sessions to recall older work, so it does not load months of history into every session.",
      },
    ],
  },

  "browser-automation": {
    title: "AI Agent Browser Automation on Hivra Cloud",
    h1: "Your agent can actually use the internet.",
    metaDescription:
      "Give a Hermes AI agent a real browser in the cloud. Research, scrape, fill forms and use websites on its own, 24/7. Included on paid plans.",
    tagline: "Research. Scrape. Fill forms. All while you sleep.",
    intro: [
      "Running browser automation locally means your laptop has to stay on, your VPN has to stay connected, and you have to babysit the process. It is a fragile, exhausting setup.",
      "Hivra deploys your agent to a persistent cloud server with a full browser environment pre-configured. Your agent can browse, click, fill forms, extract data, and interact with any website — 24 hours a day, from a stable cloud IP.",
    ],
    sections: [
      {
        heading: "What browser automation actually enables",
        paragraphs: [
          "The most common agent tasks people run with browser access: competitive monitoring (checking competitor pricing or feature pages on a schedule), research briefs (collecting content from a defined list of sources and summarizing it), lead enrichment (looking up a company or person from publicly available pages), and form submission automation for repetitive workflows.",
          "Less obvious but equally useful: the agent can maintain a logged-in session on a website. If you have a tool that lacks an API but has a web interface, the agent can interact with it directly — exporting a report, updating a record, checking a status. This covers a large surface area of tools that developers often have to scrape around.",
          "The agent also uses screenshots as a verification step. Before taking an action on a page, it can take a screenshot, analyze it, and confirm it is on the right page and in the right state. This catches the common failure mode where a site's layout has changed and a previous CSS selector no longer applies.",
        ],
      },
      {
        heading: "The infrastructure the browser runs in",
        paragraphs: [
          "Hermes supports several browser backends, selectable per task or globally, including: Browserbase (managed cloud browsers with residential IPs, anti-detection fingerprinting, and CAPTCHA solving), Browser Use cloud (a third-party cloud browser service built for agent workflows), local Chrome via Chrome DevTools Protocol (CDP) for users who want to connect a browser instance they control, and local Chromium headless for fully self-contained execution.",
          "On Hivra's paid plans, the default is a persistent Chromium on the agent's own cloud computer, which the agent controls over the Chrome DevTools Protocol (CDP) and you can watch in a live view. If you add your own Browserbase or Browser Use key, you can switch to their cloud browsers, which handle bot detection better than a raw cloud IP. Hermes also blocks cloud-browser requests to private and internal addresses by default, which guards against server-side request forgery.",
          "Because the default browser is persistent, a multi-step form or a research workflow that follows links keeps its state, and sites you have logged in to stay logged in between tasks. The browser steps are recorded in the agent's session history.",
        ],
      },
      {
        heading: "IP address and anti-bot considerations",
        paragraphs: [
          "The agent runs from a stable cloud IP in a data center. For most standard websites — news sites, corporate pages, SaaS pricing pages, public databases — this works without any special configuration. The browser sends standard Chromium headers and behaves like a real user session.",
          "Some sites use aggressive anti-bot systems (Cloudflare's higher-level bot protection, PerimeterX, Akamai Bot Manager) that can detect cloud IP ranges and headless browsers regardless of header spoofing. For these sites, results vary. The agent will tell you when it hits a challenge page rather than silently scraping wrong data.",
          "If you are targeting sites with known bot detection, point Hermes at a cloud browser service such as Browserbase with your own key. It brings its own residential IPs and fingerprinting, which a data-center browser cannot match.",
        ],
      },
      {
        heading: "Combining browser automation with scheduled tasks",
        paragraphs: [
          "Browser automation and scheduling are designed to work together. A daily competitive monitoring brief, for example, is a scheduled task that triggers browser navigation to each target URL, extracts the relevant data, compares it to a stored baseline, and sends you a summary over Telegram or email if anything changed.",
          "You can also build conditional schedules — run a deeper browser research pass only when a trigger condition is met, rather than on a fixed interval. For lightweight monitoring that just checks for a changed value, the agent can use a simpler HTTP request before spinning up the full browser, keeping API token usage down for high-frequency checks.",
        ],
      },
      {
        heading: "What it does not do",
        paragraphs: [
          "The browser automation is not JavaScript injection or a security tool. The agent navigates as a user would — it cannot bypass authentication it does not have credentials for, access data behind user-specific sessions it has not been given access to, or bypass server-side access controls.",
          "It also does not work for sites that stream content exclusively through native apps with no web interface. If there is no publicly accessible URL for the data you want, browser automation cannot reach it.",
        ],
      },
    ],
    bullets: [
      "A persistent Chromium on the agent's computer by default, with a live view",
      "Browserbase and Browser Use cloud browsers with your own key",
      "Runs 24/7 from cloud infrastructure — not your laptop",
      "Autonomous web research, form filling, and data extraction",
      "Screenshot verification before and after actions",
      "Session persistence for multi-step flows",
      "SSRF safeguards blocking internal network access from browser tasks",
      "Vision paste: send any screenshot from clipboard directly to agent",
      "Combine with scheduled tasks for timed automation",
    ],
    relatedFeatures: [
      { slug: "persistent-memory", title: "Persistent Memory" },
      { slug: "scheduled-tasks", title: "Scheduled Tasks & Cron" },
      { slug: "no-docker-hosting", title: "No Docker Required" },
    ],
    relatedBlog: [
      { slug: "ai-agent-automation-examples", title: "7 things your agent can automate overnight" },
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    ],
    faqs: [
      {
        q: "What browser does the Hermes agent use for automation?",
        a: "On Hivra's paid plans, Hermes drives a persistent Chromium browser on the agent's own cloud computer. The agent controls it over the Chrome DevTools Protocol, and you can watch it in a live view.",
      },
      {
        q: "Can my Hermes agent log in to websites and maintain sessions?",
        a: "Yes. The agent maintains browser sessions across tasks and handles authentication flows, cookies, and session management.",
      },
      {
        q: "Will browser automation work with sites that block bots?",
        a: "For most standard websites, yes. For sites with aggressive anti-bot protection (Cloudflare enterprise tiers, PerimeterX), results vary. For those, point Hermes at a cloud browser service such as Browserbase with your own key.",
      },
      {
        q: "Can I see screenshots from what the agent did in the browser?",
        a: "Browser steps are recorded in the agent's session history, so you can review what the agent did on each run. You can also ask the agent to send you a screenshot of the page it is on.",
      },
      {
        q: "Does browser automation increase API costs significantly?",
        a: "Screenshots are the main cost multiplier — each screenshot sent to the model for analysis uses tokens. For long research tasks that process many pages, this adds up. Text-only extraction runs are much cheaper. You can configure tasks to limit screenshot usage to verification steps only.",
      },
    ],
  },

  "multi-agent": {
    title: "Run Multiple AI Agents From One Account",
    h1: "One account. Several agents, each on its own computer.",
    metaDescription:
      "Run several AI agents from one Hivra account: Hermes, OpenClaw, Claude Code, Codex and more, each on its own computer. From $9.99/mo (2 vCPU, 4 GB).",
    tagline: "Researcher. Operator. Support. All on one plan.",
    intro: [
      "Most managed AI tools charge per agent. You end up paying for three or four separate subscriptions to run specialized agents — a researcher, an operator, a support triage bot.",
      "Hivra takes a different approach: paid plans give you a compute pool, not per-seat pricing. Each agent gets its own computer, memory, tools, and role, and they share your plan's compute: $9.99/mo for 2 vCPU and 4 GB RAM, or $19.99/mo for 4 vCPU and 8 GB RAM.",
    ],
    sections: [
      {
        heading: "Why multiple agents outperform one generalist",
        paragraphs: [
          "A single agent that handles everything — research, coding, customer support, content writing — has to context-switch constantly. Its system prompt grows bloated trying to cover every role. The memory store accumulates unrelated history that competes for context space on every task.",
          "Specialized agents are more focused. A research agent configured for competitive intelligence has a system prompt, tool set, and memory structure optimized for that job. A coding agent has different tool access and different working memory. Each one is sharper at its task than a generalist would be.",
          "This is how larger AI teams are being built in practice in 2026 — not one big agent, but a portfolio of focused ones with defined handoff points between them.",
        ],
      },
      {
        heading: "Isolated memory, one compute pool",
        paragraphs: [
          "Each agent profile on Hivra has a completely separate memory store. The research agent does not see the coding agent's task history and vice versa. This prevents the interference that happens when a generalist agent tries to apply patterns from one domain to an unrelated task.",
          "Each agent still runs on its own computer. At the plan level, those computers draw from one compute pool: you split your plan's vCPU and RAM across them rather than paying for each one separately.",
          "The agents run side by side, not as a team. Hivra does not coordinate work between them today; built-in orchestration is planned, not shipped. When one agent's output should feed another, you set up that handoff yourself.",
        ],
      },
      {
        heading: "Practical configurations",
        paragraphs: [
          "A common setup on the $9.99/mo size (2 vCPU, 4 GB RAM): a research agent and a coding agent on different schedules. Morning: the research agent runs its daily brief. Afternoon: the coding agent handles a batch of file processing tasks. Overlap is minimal, so the shared pool goes further.",
          "The $19.99/mo size (4 vCPU, 8 GB RAM) adds room for parallel work: a support agent triages incoming messages while a research agent runs daily briefs and a coding agent handles a batch of file-processing tasks.",
        ],
      },
    ],
    bullets: [
      "More than one agent on paid plans, with no per-seat pricing",
      "Each agent has isolated memory, tools, and configuration",
      "Manage all agents from a single dashboard",
      "Individual scheduling per agent profile",
      "Agents split one plan's compute pool",
      "Mix agent types: Hermes, OpenClaw, Claude Code, Codex and more",
    ],
    relatedFeatures: [
      { slug: "persistent-memory", title: "Persistent Memory" },
      { slug: "scheduled-tasks", title: "Scheduled Tasks" },
      { slug: "browser-automation", title: "Browser Automation" },
    ],
    relatedBlog: [
      { slug: "ai-agent-automation-examples", title: "7 things your agent can automate overnight" },
    ],
    faqs: [
      {
        q: "Is there a limit on how many agent profiles I can create?",
        a: "Yes. Each plan has a cap on active agents that matches its compute pool, and the checkout shows the cap for each plan before you pay.",
      },
      {
        q: "Do the agents work together automatically?",
        a: "Not yet. Each agent runs on its own. Built-in orchestration is planned but not shipped, so today you decide how work passes from one agent to another.",
      },
      {
        q: "Can different agents use different AI models?",
        a: "Yes. Each agent profile can be configured with its own model preference. One agent can use Claude Sonnet while another uses Haiku for cheaper high-frequency tasks — all from the same API key.",
      },
      {
        q: "What changes on a larger plan size?",
        a: "More vCPU, more RAM, and room for more agents running at once. Hosting is $9.99/mo for 2 vCPU and 4 GB RAM, or $19.99/mo for 4 vCPU and 8 GB RAM.",
      },
      {
        q: "Can two agents write to the same output — like a shared document or spreadsheet?",
        a: "This depends on your external tool configuration. Agents can be given access to the same Google Sheet, Notion database, or file share. Coordination on write timing is handled at the task level — you define which agent writes first and what the handoff looks like.",
      },
    ],
  },

  "no-docker-hosting": {
    title: "Host Hermes Agent Without Docker",
    h1: "Deploy without touching a terminal.",
    metaDescription:
      "Host a Hermes AI agent without Docker, VPS, or Linux config. Hivra handles the full infrastructure stack. From $9.99/mo (2 vCPU, 4 GB).",
    tagline: "No VPS. No Docker. No config files.",
    intro: [
      "Self-hosting Hermes requires provisioning a VPS, installing Docker, configuring Caddy or Nginx, managing environment variables, and maintaining everything when it breaks. It can easily take a full weekend.",
      "Hivra takes all of that away. The entire infrastructure layer — server provisioning, container runtime, networking, SSL, monitoring — is handled before you sign in.",
    ],
    sections: [
      {
        heading: "What self-hosting actually requires",
        paragraphs: [
          "To run Hermes Agent on your own VPS, you need a server running Linux (Ubuntu 22.04 or 24.04 is recommended), Docker and Docker Compose installed and configured, a domain name with DNS pointed at the server, a reverse proxy (Caddy or Nginx) configured for SSL termination, and environment variables correctly set across a ~30-variable `.env` file.",
          "You also need a backup strategy for the persistent memory volume, monitoring so you know when the container crashes, and a restart policy so the agent comes back up after reboots. None of this is extraordinarily difficult if you know Linux, but it is a full afternoon of work minimum, and it is ongoing — each major Hermes update potentially requires migration steps, dependency updates, or config changes.",
          "When it breaks at midnight because the Docker daemon failed or the SSL certificate did not auto-renew, you are the one who fixes it.",
        ],
      },
      {
        heading: "What Hivra handles instead",
        paragraphs: [
          "Server provisioning is automatic. When you launch an agent, Hivra creates its server and starts the Hermes Agent container, configured and tested for stability. You do not select an OS, configure SSH keys, or install anything.",
          "Networking and SSL are handled. Your agent's web interface is served over HTTPS on a Hivra address, with no Nginx config files.",
          "Monitoring runs in the background. If the agent process crashes, it restarts automatically. Recovery from a host failure depends on the runtime and provider and is not guaranteed.",
          "Updates are managed. When Nous Research ships a new Hermes Agent version, we test it on a canary agent before rolling it out. Your memory and configuration carry forward.",
        ],
      },
      {
        heading: "The sign-up to running agent flow",
        paragraphs: [
          "Create an account and choose a plan. Infrastructure provisions automatically, and a status indicator shows progress while your agent comes up.",
          "Go to the Keys section and paste your AI provider API key (Anthropic, OpenAI, or an OpenRouter key). This is the only credential you need to configure.",
          "Optionally set up your agent's system prompt to tell it who you are and what you want it to do. This can be done at any time — the agent runs with sensible defaults immediately.",
          "That is the full setup. The agent is live and accessible from the dashboard. Scheduled tasks, integrations, and additional configuration happen in the UI without touching a config file.",
        ],
      },
      {
        heading: "For users who do want terminal access",
        paragraphs: [
          "If you want to inspect the container, add custom tools, or configure something not exposed in the UI, the dashboard exposes log viewing, the agent's tool directory, and a container shell — without managing your own SSH keys or sshd.",
          "This is opt-in. You do not need it to use the platform, and enabling it does not change anything about the standard managed behavior. It is there for users who want the managed hosting baseline but also want escape hatches to the infrastructure.",
        ],
      },
    ],
    bullets: [
      "No VPS to provision or maintain",
      "No Docker, Compose, or container management",
      "No Nginx, Caddy, or reverse proxy configuration",
      "No SSL certificate management",
      "Automatic container restarts and health monitoring",
      "Hermes updates tested before rollout",
      "Status indicator while your agent's server comes up",
      "Dashboard escape hatches: log viewer, tool directory, container shell",
    ],
    relatedFeatures: [
      { slug: "persistent-memory", title: "Persistent Memory" },
      { slug: "openclaw-alternative", title: "OpenClaw Alternative" },
      { slug: "multi-agent", title: "Multiple Agents" },
    ],
    relatedBlog: [
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
      { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    ],
    faqs: [
      {
        q: "Do I need any technical knowledge to use Hivra?",
        a: "Basic familiarity with AI tools is enough. You do not need Docker, Linux, or networking knowledge. The sign-up flow walks you through everything.",
      },
      {
        q: "What if I want to customize the underlying container config?",
        a: "Advanced users can access container configuration, the agent's tool directory, and a container shell through the dashboard. You are not locked out — we just do not require it.",
      },
      {
        q: "Is Hivra just a VPS with a UI wrapper?",
        a: "No. Hivra is managed infrastructure for AI agents, including Hermes, OpenClaw, Claude Code and Codex: a pre-configured runtime, pre-installed browser automation, managed updates, and a dashboard built for agents. A generic VPS does none of this for you.",
      },
      {
        q: "What region is my server in?",
        a: "Hivra chooses where hosted agents run; there is no region picker at signup today. If location matters to you, you can connect your own Hetzner Cloud project (in preview) and pick the location there.",
      },
      {
        q: "What happens if Hermes releases an update that breaks my configuration?",
        a: "We test Hermes updates on a canary agent before rolling them out. If an update still breaks your setup, contact support and we will help you fix it.",
      },
    ],
  },

  "openclaw-alternative": {
    title: "OpenClaw Alternative: Managed Hermes Agent Hosting",
    h1: "Everything OpenClaw gives you. None of the maintenance.",
    metaDescription:
      "Run OpenClaw on Hivra without self-hosting it, or switch to Hermes. Hivra also hosts Claude Code, Codex and more. From $9.99/mo (2 vCPU, 4 GB).",
    tagline: "Keep OpenClaw, or move to Hermes. No server to run either way.",
    intro: [
      "OpenClaw is a powerful open-source personal agent that works with many model providers. But run yourself, it needs a machine that stays on, updates you apply and test, and someone on the team who is comfortable in a terminal.",
      "Hivra is the managed alternative, in two ways. It can run OpenClaw itself for you on paid plans, or you can move to Hermes, which Hivra also hosts. Either way we handle the server, updates, monitoring, and restarts. Hivra is not affiliated with the OpenClaw project.",
    ],
    sections: [
      {
        heading: "What OpenClaw is and who uses it",
        paragraphs: [
          "OpenClaw is an open-source (MIT) personal agent created by Peter Steinberger and its community, with hundreds of thousands of GitHub stars. It runs a gateway on your laptop or a server, works with hosted and local model providers, and you reach it from messaging apps such as Telegram, Discord, Slack and WhatsApp. It has an active community building skills for it.",
          "The typical OpenClaw user: a technical developer comfortable in a terminal, willing to invest setup time in exchange for control and avoiding subscription fees. The framework is well-built and well-documented. The community is active and productive.",
          "The operational cost: someone has to keep the machine it runs on awake, apply updates and test them for regressions, and back up its state. OpenClaw has its own memory and a built-in scheduler, but both only work while that machine is running.",
        ],
      },
      {
        heading: "The core trade OpenClaw users are making",
        paragraphs: [
          "OpenClaw users typically know the trade they are making: they get maximum control and zero subscription fees beyond API costs, in exchange for handling all operations themselves. That trade makes sense for developers who genuinely value the control and have the time.",
          "The trade breaks down in a few common situations: when the setup time starts competing with the work the agent is supposed to be enabling, when the developer wants the agent available 24/7 without keeping their machine on, or when they want to run multiple agent profiles without managing separate instances.",
          "Hivra is built for exactly these situations. You bring your API key — the same one you were using with OpenClaw — and get a managed cloud environment that runs the agent for you, whether that agent is OpenClaw or Hermes.",
        ],
      },
      {
        heading: "What migrates and what does not",
        paragraphs: [
          "Hivra does not have a one-click OpenClaw import, so moving is a manual step. If you keep OpenClaw, launch it on Hivra and copy your configuration across yourself. If you move to Hermes, Hermes has its own migration command, `hermes claw migrate`. It reads your OpenClaw setup and imports your persona (SOUL.md), memory, skills, model settings and messaging tokens; API keys come across only if you ask for them. Run it with `--dry-run` first to preview what will change.",
          "Some things do not come across. Hermes' migration guide lists cron jobs, plugins, webhooks and channel bindings as archived for you to set up again by hand, and WhatsApp needs pairing again. Browser session history and stored cookies for logged-in sites are machine-local by nature. On Hivra, you re-authenticate the first time the agent needs access to a site, and the session is then stored on the cloud server for subsequent runs.",
          "Your Anthropic API key from your OpenClaw setup works identically on Hivra. You are not changing providers or re-configuring model access. You are moving the execution environment from your machine to persistent cloud infrastructure.",
        ],
      },
      {
        heading: "Capabilities comparison",
        paragraphs: [
          "Browser automation: both can drive a browser. On Hivra the browser runs on the agent's cloud computer, with a persistent Chromium by default and Browserbase or Browser Use cloud if you add a key. Self-hosted OpenClaw browses from whatever machine it runs on.",
          "Memory: both keep long-term memory in files (OpenClaw and Hermes both use a MEMORY.md). Hermes also keeps USER.md for your profile and Skill Documents in the agentskills.io format for procedural memory. On Hivra, that memory lives on a server that stays on instead of on your laptop.",
          "Scheduling: both have a built-in scheduler. Scheduled jobs only run while the machine is on, which is the part Hivra takes care of.",
          "Multiple agents: Hivra lets you run more than one agent from one account on paid plans, each keeping its own memory and tools, and they do not all have to be the same kind of agent.",
          "Model support: both work with many providers. With Hermes on Hivra you bring your own key for Anthropic, OpenAI or OpenRouter, with no markup.",
        ],
      },
    ],
    bullets: [
      "OpenClaw itself available on paid plans",
      "Or move to Hermes with its own `hermes claw migrate` command (a manual step)",
      "Persistent cloud hosting — not a local process",
      "Dashboard, monitoring, and restart management included",
      "Hermes updates tested and applied for you",
      "Run more than one agent from one account",
    ],
    relatedFeatures: [
      { slug: "persistent-memory", title: "Persistent Memory" },
      { slug: "no-docker-hosting", title: "No Docker Required" },
      { slug: "multi-agent", title: "Multiple Agents" },
    ],
    relatedBlog: [
      { slug: "what-is-hermes-agent", title: "What is Hermes Agent?" },
      { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    ],
    externalRelated: [
      { label: "Hermes docs: Migrate from OpenClaw", href: HERMES_OPENCLAW_MIGRATION_GUIDE },
    ],
    faqs: [
      {
        q: "How different is Hivra from OpenClaw?",
        a: "OpenClaw is an open-source agent you normally run yourself. Hivra is a managed place to run agents, and OpenClaw is one of them, alongside Hermes, Claude Code, Codex and others. Hivra takes care of the server, restarts, and updates so the agent keeps running when your laptop is closed.",
      },
      {
        q: "Can I migrate my existing OpenClaw setup to Hivra?",
        a: "Yes, but it is a manual step: Hivra has no one-click import. To keep OpenClaw, launch it on Hivra and copy your configuration across. To move to Hermes, run Hermes' own `hermes claw migrate` command, which imports your persona, memory, skills, and settings.",
      },
      {
        q: "Do I lose anything by switching from OpenClaw to Hivra?",
        a: "You gain managed hosting and an agent that stays on without your laptop. The main trade is that you are no longer running locally — which means your API key is stored on a server rather than your machine. Local browser sessions and stored credentials do not migrate, and if you move to Hermes, cron jobs and plugins need setting up again.",
      },
      {
        q: "I built custom tools for OpenClaw. Will they work on Hivra?",
        a: "If you run OpenClaw on Hivra, your OpenClaw skills stay OpenClaw skills. If you move to Hermes, `hermes claw migrate` brings skills across, but OpenClaw plugins do not migrate. Tools that depend on local machine resources (local files, running processes on your machine) will need to be adapted to work on a cloud server.",
      },
    ],
  },

  "scheduled-tasks": {
    title: "AI Agent Scheduled Tasks & Cron Jobs",
    h1: "Your agent works while you sleep.",
    metaDescription:
      "Run AI agent cron jobs and scheduled tasks in the cloud with Hivra: email triage, competitor research, data sync. Automated, persistent, no infra to run.",
    tagline: "Cron jobs. Recurring tasks. Automated pipelines.",
    intro: [
      "The most powerful thing about a persistent AI agent is not what it does when you are talking to it. It is what it does when you are not.",
      "Hivra supports full cron-style scheduling out of the box. Define a task, set a schedule, and your agent runs it autonomously — whether that is every hour, every day, or every Monday at 9am.",
    ],
    sections: [
      {
        heading: "How scheduled tasks work on Hivra",
        paragraphs: [
          "You define a task in the agent's Tasks tab in the Hivra dashboard. Give it a name and write the task instruction in plain language: what the agent should do, what it should produce, and where the result should go. Then pick how often it runs (hourly, daily, weekly or monthly) and at what time, and on which days for a weekly task. A task that already has a custom cron schedule keeps it and shows the cron expression for editing. You can also pause, resume, or edit a task's schedule mid-run without losing its task history.",
          "At the scheduled time, the agent's scheduler wakes it, loads the relevant memory context, and starts the task. The agent runs through it autonomously and logs the result — output text, files generated, actions taken — to the task history. If the task produces a report or notification, it sends it where you chose: Telegram, Discord, or email, or it stays in the run history.",
          "Event hooks add conditional triggering on top of cron. Gateway hooks fire on every incoming and outgoing message — useful for logging, real-time alerting, and webhook forwarding to external monitoring. Plugin hooks intercept tool calls before and after execution, enabling metrics collection, guardrail checks, and custom business logic without modifying the agent's core configuration.",
        ],
      },
      {
        heading: "What runs well as a scheduled task",
        paragraphs: [
          "Anything repetitive and verifiable: the agent needs to be able to tell when it has done the task correctly. Competitive monitoring, daily summaries, data extraction from a defined set of sources, nightly code processing, weekly reporting — these all have clear success criteria and run reliably.",
          "Tasks that are time-sensitive but not urgent in real time: a morning brief that arrives before you sit down is more useful than one that arrives while you are already buried in email. Scheduling it to run at 6:30am lets the agent do the research while you are sleeping and have the result ready.",
          "Tasks that chain together: a monitoring task that triggers a follow-up research task when a condition is met, or a data extraction task whose output is automatically passed to a formatting task for the final report. These multi-step scheduled workflows replace what would otherwise be manual pipe-and-process scripts.",
        ],
      },
      {
        heading: "Example tasks",
        paragraphs: [
          "Daily competitor brief: monitor 5 competitor pricing pages, check their changelog or blog RSS for product updates, and summarize any changes. Runs at 7am, arrives in Telegram as a formatted message by 7:15am.",
          "Weekly codebase review: pull the last 7 days of merged PRs, check for patterns matching a defined list of technical debt indicators, and generate a markdown report linked to specific files. Runs every Monday at 6am, available for the standup.",
          "Hourly error monitoring: check Sentry for new error classes, compare to a known-errors list, and alert via Telegram if a new error pattern appears. Runs every hour on the hour and sends a notification only when something genuinely new emerges.",
          "Monthly lead enrichment cleanup: take all CRM contacts added in the past 30 days that still have empty company fields, look up each one from public sources, and update the records. Runs on the 1st of each month and produces a report of what it filled in.",
        ],
      },
      {
        heading: "Combining scheduling with persistent memory",
        paragraphs: [
          "When the same task runs repeatedly using the same agent profile, it compounds. A competitive monitoring agent that has been running for three months has a stored history of how competitor pricing has evolved. When it runs this week, it contextualizes the current pricing against that history rather than treating each observation in isolation.",
          "This compounding effect is what separates a persistent scheduled agent from a cron script. The script runs the same logic every time. The agent improves its execution of the task as it builds up experience — faster navigation of familiar sites, better categorization of changes it has seen patterns of before, more relevant framing of results for your specific interests.",
        ],
      },
    ],
    bullets: [
      "Full cron scheduling pre-configured — no crontab editing required",
      "Write the task in plain language, then pick hourly, daily, weekly or monthly",
      "Results logged and visible in the Hivra dashboard",
      "Last status, last error, and a Run now button on every task",
      "Agents run even when your laptop is closed",
      "Combine with browser automation for scheduled scraping",
      "Combine with persistent memory for tasks that improve over time",
      "Send results to Telegram, Discord, or email",
    ],
    relatedFeatures: [
      { slug: "persistent-memory", title: "Persistent Memory" },
      { slug: "browser-automation", title: "Browser Automation" },
      { slug: "multi-agent", title: "Multiple Agents" },
    ],
    relatedBlog: [
      { slug: "ai-agent-automation-examples", title: "7 things your agent can automate overnight" },
      { slug: "persistent-memory-explained", title: "How persistent memory compounds over time" },
    ],
    faqs: [
      {
        q: "How do I set up a scheduled task in Hivra?",
        a: "Open your agent's Tasks tab in the dashboard, write the task instruction in plain language, pick how often it runs (hourly, daily, weekly or monthly) and when, and save. The agent handles execution automatically at the specified time.",
      },
      {
        q: "Can scheduled tasks use browser automation?",
        a: "Yes. Scheduled tasks have full access to all agent capabilities including browser automation, API calls, file operations, and tool use.",
      },
      {
        q: "What happens if a scheduled task fails?",
        a: "Failed runs are logged, and the task shows its last error. The task runs again at its next scheduled time, or you can use Run now to retry straight away.",
      },
      {
        q: "Can I trigger a task manually outside its schedule?",
        a: "Yes. Any scheduled task can be triggered manually from the dashboard. Useful for testing a new task configuration before its first scheduled run.",
      },
      {
        q: "Is there a limit on how many scheduled tasks I can run?",
        a: "Paid plans have no set limit on the number of tasks. Concurrent execution depends on your plan size — tasks that run simultaneously share the agent's vCPU and RAM. On the 2 vCPU, 4 GB size, stagger heavy tasks rather than running many at once.",
      },
    ],
  },
};

interface FeaturePageParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: FeaturePageParams): Promise<Metadata> {
  const { slug } = await params;
  const feature = FEATURES[slug];
  if (!feature) return {};

  return {
    title: feature.title,
    description: feature.metaDescription,
    ...buildWebsiteMetadata({
      path: `/features/${slug}`,
      title: feature.title,
      description: feature.metaDescription,
    }),
  };
}

export function generateStaticParams() {
  return Object.keys(FEATURES).map((slug) => ({ slug }));
}

export default async function FeaturePage({ params }: FeaturePageParams) {
  const { slug } = await params;
  const feature = FEATURES[slug];
  if (!feature) notFound();

  const featureUrl = `${SITE_URL}/features/${slug}`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Hivra",
        applicationCategory: "DeveloperApplication",
        description: feature.metaDescription,
        url: SITE_URL,
        featureList: [feature.title],
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Features", item: `${SITE_URL}/features` },
          { "@type": "ListItem", position: 3, name: feature.title, item: featureUrl },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: feature.faqs.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  const contents = feature.sections.map((section, index) => ({ id: `section-${index + 1}`, label: section.heading }));
  return (<PublicSite className={styles.page} data-page="features-detail"><StructuredData schema={schema} /><main className={styles.main} id="main-content">
    <Breadcrumbs items={[{ label: "Features", href: "/features" }, { label: feature.title }]} />
    <header className={styles.masthead}><span className={styles.eyebrow}>{feature.tagline}</span><h1>{feature.h1}</h1></header>
    <div className={styles.articleLayout}><ArticleNavigation items={contents} /><div className={styles.articleBody}><div className={styles.detailIntro}>{feature.intro.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    {feature.sections.map((section, index) => <section key={section.heading} id={contents[index].id}><h2>{section.heading}</h2>{section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}
    <section className={styles.included}><h2>What&apos;s included</h2><ul>{feature.bullets.map((bullet) => <li key={bullet}><CheckCircle size={16} aria-hidden="true" />{bullet}</li>)}</ul></section><EditorialQuestions questions={feature.faqs} /></div></div><EditorialCTA /><EditorialRelated links={[...feature.relatedFeatures.map(({ slug, title }) => ({ label: title, href: `/features/${slug}` })), ...(feature.relatedBlog ?? []).map(({ slug, title }) => ({ label: `Blog: ${title}`, href: `/blog/${slug}` })), ...(feature.externalRelated ?? []), { label: "Pricing", href: "/pricing" }, { label: "Compare Alternatives", href: "/compare" }]} /></main></PublicSite>);
}
