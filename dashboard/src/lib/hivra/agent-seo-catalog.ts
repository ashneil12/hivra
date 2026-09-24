// Agent SEO catalog: copy + structured-data source for the public /agents pages.
//
// Keyed to agent-catalog ids and limited to agents that are launchable today
// (available: true). Pure data (no React) so the pages, the sitemap
// (lib/seo-urls.ts) and the tests can all import it. Product facts trace back
// to agent-catalog.ts (runtime availability, resource floors, browser add-on),
// welcome-agent-catalog.ts (sign-in and connect flows) and the billing plans in
// lib/subscription. If a fact isn't in code, it doesn't get claimed here.
//
// Pricing rules (owner decision 2026-09-14): the public ladder and checkout
// sell the same two entry sizes at the same prices under different names, so
// copy names a plan by PRICE AND SIZE ("$9.99 a month for 2 vCPU and 4 GB"),
// never by plan name. No trial, no hosted free plan, no agent-count limits.
// "Always on" is only claimed for paid plans, which are never paused for
// inactivity. The tests in __tests__/agent-seo-catalog.test.ts hold these rules.

import type { AgentId } from "@/lib/hivra/agent-catalog";
import type { WelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";

/** Subset of the ops catalog that gets a public landing page. */
export type AgentSeoSlug = Extract<
  AgentId,
  "hermes" | "claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero"
>;

export interface AgentSeoFaq {
  q: string;
  a: string;
}

export interface AgentSeoStep {
  title: string;
  detail: string;
}

export interface AgentSeoEntry {
  slug: AgentSeoSlug;
  /** The /get-started agentType key (Hermes launches as "general"). */
  agentType: WelcomeAgentTypeKey;
  h1: string;
  subhead: string;
  /** Page title before the root " | Hivra" template suffix. */
  metaTitle: string;
  metaDescription: string;
  /** One line for the /agents hub card and the OG card subtitle. */
  cardSummary: string;
  /** 2-3 paragraphs rendered under the hero. */
  longDescription: string[];
  heroBullets: [string, string, string];
  howItWorks: AgentSeoStep[];
  faqs: AgentSeoFaq[];
  /** Honest DIY-vs-managed bullets. */
  vsSelfHosted: string[];
  /** Explicit non-affiliation line naming only this page's vendor. */
  affiliation: string;
  /** Blog slugs to cross-link. Each must exist in lib/blog-data.ts. */
  relatedBlogSlugs: string[];
}

/** Date these pages last changed substantively (sitemap lastmod). */
export const AGENT_PAGES_LAST_MODIFIED = "2026-09-24";

/**
 * Entry monthly price for every agent page, as the JSON-LD Offer price. It is
 * checkout's $9.99 plan (PLANS.operator, 2 vCPU / 4 GB) and the public ladder's
 * $9.99 size; the catalog test pins both so neither can drift from this.
 */
export const AGENT_OFFER_PRICE_USD = "9.99";

/** Primary CTA on the hub: sign-up with the $9.99 plan preselected. */
export const AGENTS_HUB_DEPLOY_HREF = "/get-started?plan=operator";

/** Secondary CTA everywhere. */
export const PRICING_HREF = "/pricing";

const SELF_HOST_FAQ: AgentSeoFaq = {
  q: "Can I run Hivra on my own server instead?",
  a: "Hivra's own source is public under the Apache-2.0 license at github.com/ashneil12/hivra, and self-hosting is available as a preview for a single operator. The managed plans are for people who would rather not run the server themselves.",
};

export const AGENT_SEO_ENTRIES: AgentSeoEntry[] = [
  {
    slug: "claude-code",
    agentType: "claude-code",
    h1: "Claude Code, running 24/7 in the cloud.",
    subhead:
      "The official Anthropic CLI on a private VM that stays on, with a live browser, a web terminal, and your own Claude sign-in. Start a run from Telegram or inside tmux and it keeps going after you close your laptop.",
    metaTitle: "Run Claude Code in the Cloud 24/7",
    metaDescription:
      "Run Claude Code 24/7 on a managed cloud VM with your own Anthropic sign-in. Live browser, web terminal and files. Plans from $9.99/mo.",
    cardSummary: "The official Anthropic CLI with a live browser, a web terminal and your own Claude sign-in.",
    longDescription: [
      "Claude Code on your laptop stops when your laptop does. The lid closes, the session dies, and the refactor you kicked off at 6pm is gone by dinner. Keeping it alive means a spare machine, or a VPS with tmux and SSH keys you now get to maintain.",
      "Hivra runs the official Claude Code CLI on a private cloud VM that stays on. You sign in with your own Anthropic account inside the box after launch, the same way you would on your laptop. Then you get chat, a web terminal, files, and an optional live browser in one tab, from any device.",
      "The computer keeps your files, sessions and Claude login between visits. Start long work from Telegram or inside tmux in the Box Terminal, close the laptop, and it keeps going while you're away. A run you start in the browser chat or the Claude Code Terminal stops when you close that tab. Plans start at $9.99 a month for 2 vCPU and 4 GB RAM, enough to run Claude Code with the live browser on. Paid plans are never paused for inactivity.",
    ],
    heroBullets: [
      "Official Claude Code CLI, unmodified. Your own Anthropic sign-in.",
      "Live self-hosted browser you can watch and take over.",
      "Web terminal, files, and skills in one tab, from any device.",
    ],
    howItWorks: [
      {
        title: "Pick Claude Code on the get-started page",
        detail: "Choose a plan, name the box, and choose resources. The live browser is optional.",
      },
      {
        title: "Hivra provisions a private VM",
        detail: "The official CLI is already installed when your box comes up.",
      },
      {
        title: "Sign in with your Anthropic account",
        detail: "The sign-in happens inside the box, the same way it does on your laptop. Your session is stored on that computer.",
      },
      {
        title: "Hand off long runs",
        detail: "Chat with it while you watch. Start long runs from Telegram or inside tmux in the Box Terminal, and they keep going after you close the tab.",
      },
    ],
    faqs: [
      {
        q: "What does it cost to run Claude Code in the cloud?",
        a: "Plans start at $9.99 a month for 2 vCPU and 4 GB RAM, which is enough for Claude Code with the live browser on. A $19.99 plan gives you 4 vCPU and 8 GB. Claude usage itself bills through your own Anthropic account. Card payments come with a 7-day money-back guarantee.",
      },
      {
        q: "Do I need an Anthropic API key?",
        a: "No key required. You sign in with your own Anthropic account inside the box after launch, the same way you would on your laptop. The session is stored on that computer, and Hivra administrators keep infrastructure access to Hivra-managed hosts.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "The computer stays on and keeps your files, sessions and Claude login, and paid plans are never paused for inactivity. A run you start from Telegram, or inside tmux in the Box Terminal, keeps going with the lid shut, so you can check the result from your phone later. A run in the browser chat or the Claude Code Terminal stops when you close that tab.",
      },
      {
        q: "Can Claude Code use a browser on Hivra?",
        a: "Yes. The box ships an optional live self-hosted browser. You watch it work in a live view and can log into sites yourself. The browser adds 1 vCPU and 2 GB RAM to the box, which fits within the $9.99 plan.",
      },
      {
        q: "Is this a modified version of Claude Code?",
        a: "No. It's the official CLI from Anthropic, running unmodified on a private VM. Hivra is an independent hosting service and isn't affiliated with or endorsed by Anthropic.",
      },
      {
        q: "How is this different from tmux on a VPS?",
        a: "Same CLI and the same tmux, without the server work. tmux is already installed, there are no SSH keys to manage, and you reach the box from any browser. Plus chat, a files view, Telegram and a live browser a bare VPS doesn't have.",
      },
      SELF_HOST_FAQ,
    ],
    vsSelfHosted: [
      "DIY works: rent a VPS, install the CLI, keep a tmux session alive, SSH in from your phone. You maintain all of it.",
      "Hivra provisions the VM, keeps it on, and runs the chat and terminal as services that restart if they crash.",
      "You get surfaces a bare VPS doesn't have: chat, web terminal, files, and a live browser view.",
      "Same official CLI, same Anthropic sign-in, same usage billing either way. The difference is who does the ops.",
    ],
    affiliation: "Hivra is independent and is not affiliated with Anthropic.",
    relatedBlogSlugs: ["keep-claude-code-running-24-7", "byo-api-key-explained", "cost-of-running-ai-agent"],
  },
  {
    slug: "codex",
    agentType: "codex",
    h1: "Codex, on a computer that stays on when you log off.",
    subhead:
      "The official OpenAI Codex CLI on a private cloud VM with your own ChatGPT sign-in. The computer stays on with any paid plan, from $9.99 a month, and a run you start inside tmux keeps going after you log off.",
    metaTitle: "Codex Hosting: Run OpenAI Codex 24/7 in the Cloud",
    metaDescription:
      "Run the official OpenAI Codex CLI 24/7 on a managed cloud VM with your own ChatGPT sign-in or API key. Optional live browser. From $9.99/mo.",
    cardSummary: "OpenAI's official Codex CLI on a private VM, with your own ChatGPT sign-in or API key.",
    longDescription: [
      "Codex is OpenAI's coding agent. On your machine it works while the terminal is open and stops when it isn't. Long tasks need a computer that stays on, and most people don't want to run one.",
      "Hivra hosts the official Codex CLI on a private VM that stays on. Sign in with your own ChatGPT account, or use your own OpenAI API key, inside the box after launch. Then hand it real work: a repo to inspect, a change to implement, a failing build to debug.",
      "Start long work inside tmux in the Box Terminal and it keeps going after you log off. A run you start in the browser chat or the Codex Terminal stops when you close that tab. Plans start at $9.99 a month for 2 vCPU and 4 GB RAM, with room for the optional live browser, and paid plans are never paused for inactivity. When you sign in with ChatGPT or your own OpenAI key, Codex usage bills through that account, not through Hivra.",
    ],
    heroBullets: [
      "Official OpenAI Codex CLI, unmodified. Sign in with ChatGPT or your own API key.",
      "Optional live self-hosted browser for research and logged-in sites.",
      "Web terminal, files, and skills, reachable from any device.",
    ],
    howItWorks: [
      {
        title: "Pick Codex on the get-started page",
        detail: "Choose a plan, name the box, and choose resources. The live browser is optional.",
      },
      {
        title: "Hivra provisions a private VM",
        detail: "The official CLI is already installed when your box comes up.",
      },
      {
        title: "Sign in with your ChatGPT account",
        detail: "The sign-in happens inside the box, or you can use your own OpenAI API key instead. Your session is stored on that computer.",
      },
      {
        title: "Hand off long runs",
        detail: "Chat with it while you watch. Start long runs inside tmux in the Box Terminal, and they keep going while you're offline.",
      },
    ],
    faqs: [
      {
        q: "What does it cost to run Codex in the cloud?",
        a: "Plans start at $9.99 a month for 2 vCPU and 4 GB RAM. A $19.99 plan gives you 4 vCPU and 8 GB. Codex usage bills through your own ChatGPT or OpenAI account. Card payments come with a 7-day money-back guarantee.",
      },
      {
        q: "Do I need an OpenAI API key?",
        a: "No. You can sign in with your own ChatGPT account inside the box after launch, or use your own OpenAI API key if you prefer. Either way the credentials live on your agent computer, and Hivra administrators keep infrastructure access to Hivra-managed hosts.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "The computer stays on and keeps your files, sessions and ChatGPT login, and paid plans are never paused for inactivity. A run you start inside tmux in the Box Terminal keeps going, and you pick up the result later from any device. A run in the browser chat or the Codex Terminal stops when you close that tab.",
      },
      {
        q: "Can Codex browse the web on Hivra?",
        a: "Yes. The box ships the same live browser stack as our Claude Code boxes. Turn it on for web research or logged-in sites. It adds 1 vCPU and 2 GB RAM to the box, which fits within the $9.99 plan.",
      },
      {
        q: "Is this a modified version of Codex?",
        a: "No. It's the official CLI from OpenAI, running unmodified on a private VM. Hivra is an independent hosting service and isn't affiliated with or endorsed by OpenAI.",
      },
      SELF_HOST_FAQ,
    ],
    vsSelfHosted: [
      "DIY: a VPS, the CLI install, a tmux session you keep alive, and updates you apply by hand.",
      "Hivra provisions the box and keeps it on around the clock on any paid plan, with tmux already installed for long runs.",
      "You get chat, a web terminal, files, and an optional live browser instead of a bare shell.",
      "Same official CLI and the same ChatGPT billing either way. You're paying Hivra to skip the ops.",
    ],
    affiliation: "Hivra is independent and is not affiliated with OpenAI.",
    relatedBlogSlugs: ["run-codex-24-7-in-the-cloud", "byo-api-key-explained", "ai-agent-automation-examples"],
  },
  {
    slug: "hermes",
    agentType: "general",
    h1: "Your own Hermes agent, on a computer that stays on.",
    subhead:
      "The open-source agent from Nous Research on a managed cloud VM. Persistent memory, skills, browser, and cron. From $9.99 a month.",
    metaTitle: "Hermes Agent Hosting: Run It 24/7 in the Cloud",
    metaDescription:
      "Deploy the open-source Hermes agent on a managed cloud VM. Persistent memory, skills, browser and cron, with your own model key. From $9.99/mo.",
    cardSummary: "The open-source agent from Nous Research, with persistent memory, skills, browser and cron.",
    longDescription: [
      "Hermes is the general-purpose agent you shape yourself. It remembers you between sessions, picks up skills as it works, and runs scheduled tasks while you sleep. On Hivra it lives on a private virtual machine that stays on, so nothing resets when you close the tab.",
      "You bring the model provider you already pay for. Paste a key, name the agent, and start giving it work: research briefs, recurring workflows, builds inside its own workspace. Hivra adds its chat, terminal, files, and skills views around the open-source agent.",
      "Plans start at $9.99 a month for 2 vCPU and 4 GB RAM. When you want more compute, $19.99 a month gets you 4 vCPU and 8 GB. Paid plans are never paused for inactivity.",
    ],
    heroBullets: [
      "Bring any supported model provider. Your key, your usage, no markup.",
      "Add skills and integrations as you go.",
      "Persistent workspace with browser, terminal, files, and cron.",
    ],
    howItWorks: [
      {
        title: "Pick Hermes on the get-started page",
        detail: "Choose a plan and name your agent. Plans start at $9.99 a month.",
      },
      {
        title: "Hivra provisions a private VM",
        detail: "No VPS, no Docker, no config files.",
      },
      {
        title: "Connect a model provider",
        detail: "Paste the API key you already have. The agent runs on your provider account.",
      },
      {
        title: "Give it work",
        detail: "Chat with it, schedule recurring tasks, and let it keep working after you log off.",
      },
    ],
    faqs: [
      {
        q: "What does it cost to run Hermes on Hivra?",
        a: "Plans start at $9.99 a month for 2 vCPU and 4 GB RAM. $19.99 a month gets you 4 vCPU and 8 GB. Model usage bills through your own provider account. Card payments come with a 7-day money-back guarantee.",
      },
      {
        q: "Can I use my own API key?",
        a: "Yes. Hermes runs on the model provider you connect. Paste your own key and usage bills through your provider account, with no markup from Hivra.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "Nothing stops. The agent runs on a managed cloud VM, not your machine, and paid plans are never paused for inactivity. Scheduled tasks fire and long jobs keep going whether you're online or not.",
      },
      {
        q: "Does Hermes keep memory between sessions?",
        a: "Yes. Memory lives on the VM's persistent storage. Come back tomorrow or next month and the agent still knows your projects, preferences, and task history.",
      },
      {
        q: "Is Hivra affiliated with Nous Research?",
        a: "No. Hermes is an open-source project from Nous Research. Hivra is an independent hosting service that runs it on a private VM and adds chat, terminal, files and skills views around it.",
      },
      SELF_HOST_FAQ,
    ],
    vsSelfHosted: [
      "Self-hosting Hermes means a VPS, Docker, a reverse proxy, SSL, and you on call when it breaks at midnight.",
      "Hivra provisions the box and keeps the agent running for you.",
      "You keep control: the same open-source agent and your own provider key.",
      "A DIY setup costs a VPS bill plus the weekend you spend configuring it. Hivra starts at $9.99 a month.",
    ],
    affiliation: "Hivra is independent and is not affiliated with Nous Research.",
    relatedBlogSlugs: ["what-is-hermes-agent", "what-can-hermes-agent-actually-do", "hermes-agent-skills-guide"],
  },
  {
    slug: "aeon",
    agentType: "aeon",
    h1: "Aeon, set once. It runs on your GitHub.",
    subhead:
      "Hivra hosts the Aeon dashboard on a tiny managed box. The agent's recurring tasks run unattended on your own GitHub Actions.",
    metaTitle: "Aeon Agent Hosting: Runs on Your GitHub",
    metaDescription:
      "Host the Aeon autonomous agent on Hivra. Tasks run on your own GitHub Actions: research digests, PR reviews and scans, unattended. From $9.99/mo.",
    cardSummary: "An autonomous agent framework whose recurring tasks run on your own GitHub Actions.",
    longDescription: [
      "Aeon is an autonomous agent framework that runs recurring work on your own GitHub Actions: monitoring, code review, research digests, security scans. Set a task once and it runs on schedule without you.",
      "Hivra hosts Aeon's dashboard on a tiny managed box. Connect with a GitHub token after launch, and the box sets up your own fork of Aeon on GitHub. Then configure tasks inside Aeon's own dashboard. The heavy lifting happens on your fork's GitHub Actions, not the box.",
      "Because the box is so light, Aeon does not draw on your plan's shared CPU and RAM. Plans start at $9.99 a month.",
    ],
    heroBullets: [
      "Tasks run on your own GitHub Actions, not on the box.",
      "Near zero compute. It does not draw on your plan's CPU and RAM.",
      "Connect with a GitHub token after launch, inside the box.",
    ],
    howItWorks: [
      {
        title: "Pick Aeon on the get-started page",
        detail: "Choose a plan and name the box. Aeon barely uses any compute.",
      },
      {
        title: "Hivra provisions a tiny box",
        detail: "It hosts Aeon's dashboard behind an authenticated gateway.",
      },
      {
        title: "Connect your GitHub",
        detail:
          "Enter a GitHub token inside the box. The box uses it to create your Aeon fork (or sync the one you have), turn on its Actions, and store your task secrets there. Give the token Read and write access to Secrets, Actions, Contents and Workflows.",
      },
      {
        title: "Schedule tasks in Aeon's dashboard",
        detail: "Daily digests, PR review, recurring scans. They run on your GitHub Actions, unattended.",
      },
    ],
    faqs: [
      {
        q: "What does Aeon cost on Hivra?",
        a: "Plans start at $9.99 a month. The box only hosts Aeon's dashboard, so it does not draw on your plan's shared CPU and RAM. Task minutes run on your own GitHub Actions account.",
      },
      {
        q: "What do I need to connect?",
        a: "A GitHub token, entered inside the box after launch. The box uses it to create an Aeon fork in your GitHub account (or sync the fork you already have), turn on Actions for it, point the dashboard at it, and store your task secrets on it as repository secrets. The token needs Read and write access to Secrets, Actions, Contents and Workflows on that fork, or the connect stops and tells you what to change. Credentials may be stored on that computer, and Hivra administrators keep infrastructure access to Hivra-managed hosts.",
      },
      {
        q: "Where do Aeon's tasks actually run?",
        a: "On your own GitHub Actions, in your Aeon fork. The Hivra box hosts the dashboard; the recurring work runs in your GitHub account with credentials you control.",
      },
      {
        q: "What kind of work does Aeon do?",
        a: "Recurring, unattended tasks: daily research digests, automatic pull-request review on your repos, and recurring security or market scans.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "Nothing changes. The dashboard stays hosted and the tasks run on GitHub's infrastructure on their schedule.",
      },
      {
        q: "Is this a modified version of Aeon?",
        a: "No. The box runs the Aeon project exactly as it ships. Hivra is an independent hosting service and isn't affiliated with the Aeon project.",
      },
    ],
    vsSelfHosted: [
      "You can self-host Aeon's dashboard on any box. Then you own uptime, updates, and the reverse proxy.",
      "Hivra stands the dashboard up behind an authenticated gateway.",
      "Either way the tasks run on your own GitHub Actions with your own credentials.",
      "On Hivra it barely touches your plan's compute, so there's little to save by self-hosting.",
    ],
    affiliation: "Hivra is independent and is not affiliated with the Aeon project.",
    relatedBlogSlugs: ["what-is-an-ai-agent", "ai-agent-automation-examples", "hermes-agent-cron-scheduled-tasks"],
  },
  {
    slug: "openclaw",
    agentType: "openclaw",
    h1: "OpenClaw, hosted and always on for $9.99 a month.",
    subhead:
      "The open-source OpenClaw agent on a private managed VM. Message it from Telegram, WhatsApp, or Signal. It runs while you sleep. Needs a paid plan.",
    metaTitle: "OpenClaw Hosting: Always-On Managed Box for $9.99/mo",
    metaDescription:
      "Host OpenClaw on a managed cloud VM from $9.99/mo. An always-on agent you reach from Telegram, WhatsApp or Signal, with an optional live browser.",
    cardSummary: "The open-source agent you message like a contact, with a heartbeat that runs routines on schedule.",
    longDescription: [
      "OpenClaw is the open-source agent you message like a contact. It runs a persistent gateway with a heartbeat scheduler, so routines fire on time whether you're online or not. That only works on a machine that stays on, which is exactly what your laptop is not.",
      "Hivra runs OpenClaw on a private managed VM. The Control UI runs exactly as the project ships it, behind Hivra's authenticated gateway. Choose your model provider, wire up Telegram, WhatsApp, or Signal inside it, set a heartbeat, and the agent keeps working after you close the tab.",
      "OpenClaw needs a paid plan. The $9.99 plan gives you 2 vCPU and 4 GB RAM, enough for OpenClaw with the live browser on, and paid plans are never paused for inactivity.",
    ],
    heroBullets: [
      "The open-source OpenClaw agent, unmodified, on a private VM.",
      "Reach it from Telegram, WhatsApp, Signal, and more.",
      "Heartbeat scheduler runs routines unattended, around the clock.",
    ],
    howItWorks: [
      {
        title: "Pick OpenClaw on the get-started page",
        detail: "It needs a paid plan, from $9.99 a month. Name the box and launch.",
      },
      {
        title: "Hivra provisions a private VM",
        detail: "Your box comes up with OpenClaw's Control UI behind an authenticated gateway.",
      },
      {
        title: "Connect your model and channels",
        detail: "Open the Control UI, choose your model provider, and wire up Telegram, WhatsApp, or Signal.",
      },
      {
        title: "Set routines and walk away",
        detail: "Heartbeat tasks run on schedule. The agent stays reachable from your phone, day and night.",
      },
    ],
    faqs: [
      {
        q: "How much does OpenClaw hosting cost on Hivra?",
        a: "OpenClaw needs a paid plan. Plans start at $9.99 a month for 2 vCPU and 4 GB RAM. OpenClaw itself needs 1 vCPU and 2 GB, or 2 vCPU and 4 GB with the live browser on. Card payments come with a 7-day money-back guarantee.",
      },
      {
        q: "Is this an official OpenClaw product?",
        a: "No. Hivra hosts the open-source OpenClaw agent (MIT-licensed) unmodified on a private VM. The Control UI runs exactly as the project ships it. Hivra is an independent hosting service and isn't affiliated with or endorsed by the OpenClaw project.",
      },
      {
        q: "What do I need to bring?",
        a: "A paid plan and a model provider. You choose the model and connect messaging channels inside the Control UI with your own accounts. Those credentials may be stored on your agent computer, and Hivra administrators keep infrastructure access to Hivra-managed hosts.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "Nothing stops. The agent and its heartbeat scheduler run on a managed cloud VM, not your machine. Routines fire on schedule and your messaging channels stay live.",
      },
      {
        q: "Can OpenClaw use a browser on Hivra?",
        a: "Yes, optionally. The box ships a live self-hosted browser OpenClaw can attach to. You log into your accounts in a live view and the agent acts in that session. Turning it on adds 1 vCPU and 2 GB RAM to the box.",
      },
      {
        q: "Why not just self-host OpenClaw on a VPS?",
        a: "You can, and our self-hosting guide walks through it. You'll manage the VPS, the install, updates, and uptime yourself. Hivra does that part for you, from $9.99 a month.",
      },
    ],
    vsSelfHosted: [
      "Self-hosting works: a VPS, the OpenClaw install, a gateway you secure, and updates you apply by hand.",
      "Hivra provisions the box, runs the gateway as a service, and restarts it if it crashes.",
      "Either way you run the same open-source project, with your own channels and your own credentials.",
      "A VPS is a monthly bill plus your time. On Hivra, plans start at $9.99 a month.",
    ],
    affiliation: "Hivra is independent and is not affiliated with the OpenClaw project.",
    relatedBlogSlugs: ["agent-zero-vs-openclaw-hosting", "hermes-vs-openclaw", "how-to-self-host-openclaw"],
  },
  {
    slug: "agent-zero",
    agentType: "agent-zero",
    h1: "Agent Zero, deployed on a cloud computer of its own.",
    subhead:
      "The open-source autonomous agent with its own dashboard, browser, and computer, on a private managed VM. Give it a goal. It plans, runs, and reports. Needs a paid plan.",
    metaTitle: "Agent Zero Hosting: Deploy It in the Cloud for $9.99/mo",
    metaDescription:
      "Deploy Agent Zero on a managed cloud VM. Its own dashboard, browser and computer, behind an authenticated gateway. Paid plans from $9.99/mo.",
    cardSummary: "A general autonomous agent with its own dashboard, browser and computer. Give it a goal.",
    longDescription: [
      "Agent Zero is a general autonomous agent. You give it a goal in its web dashboard and it plans the steps, writes and runs code, browses with its own browser, and reports back. Running it yourself means Docker, a server that stays on, and a public endpoint you have to secure.",
      "Hivra hosts the full Agent Zero stack on a private managed VM: the agent loop, its tools, and its own browser and computer, exactly as the project ships. The dashboard sits behind an authenticated gateway with a login created at provision. Configure your own model provider in Agent Zero's Settings, or use a supported managed model option.",
      "It needs a paid plan. Agent Zero's minimum footprint is 1 vCPU and 2 GB RAM, and the $9.99 plan gives you 2 vCPU and 4 GB. Paid plans are never paused for inactivity.",
    ],
    heroBullets: [
      "The open-source Agent Zero, unmodified, with its own browser and computer.",
      "Dashboard locked behind Hivra's authenticated gateway.",
      "Use your own model provider in Settings, or a managed option.",
    ],
    howItWorks: [
      {
        title: "Pick Agent Zero on the get-started page",
        detail: "It needs a paid plan, from $9.99 a month. Name the box and launch.",
      },
      {
        title: "Hivra provisions a private VM",
        detail: "The full Agent Zero stack comes up in a container, with at least 1 vCPU and 2 GB RAM.",
      },
      {
        title: "Open its dashboard and set a model",
        detail:
          "It's reachable only through Hivra's authenticated gateway, with a login created at provision. Configure model access before your first task.",
      },
      {
        title: "Give it a goal",
        detail: "It plans, browses, writes and runs code, and reports back. It keeps working after you close the tab.",
      },
    ],
    faqs: [
      {
        q: "How much does it cost to deploy Agent Zero?",
        a: "Agent Zero needs a paid plan. Plans start at $9.99 a month for 2 vCPU and 4 GB RAM, and Agent Zero's minimum footprint is 1 vCPU and 2 GB. Model usage bills through whichever provider you use. Card payments come with a 7-day money-back guarantee.",
      },
      {
        q: "Is this an official Agent Zero product?",
        a: "No. Hivra hosts the open-source Agent Zero unmodified, in a container on a private VM, exactly as the project ships it. Hivra is an independent hosting service and isn't affiliated with or endorsed by the Agent Zero project.",
      },
      {
        q: "What do I need to bring?",
        a: "A paid plan and model access. The dashboard login is created for you at provision. Configure your own model provider in Agent Zero's Settings, or use a supported managed model option, before you give it a task. Provider credentials may be stored on your agent computer, and Hivra administrators keep infrastructure access to Hivra-managed hosts.",
      },
      {
        q: "Does Agent Zero get a browser?",
        a: "Yes. Agent Zero ships its own browser and computer inside its container, and you watch both work from its dashboard. No extra setup and no separate browser add-on needed.",
      },
      {
        q: "What happens when I close my laptop?",
        a: "The agent keeps working. It runs on a managed cloud VM, not your machine, and paid plans are never paused for inactivity. Hand it a long task, log off, and check the result later from any device.",
      },
      {
        q: "How is this different from running Agent Zero in Docker locally?",
        a: "Same container, different machine. Locally it stops when your computer sleeps and exposing the web UI safely is on you. On Hivra the box stays on and the dashboard is only reachable through an authenticated gateway.",
      },
    ],
    vsSelfHosted: [
      "DIY: run the Docker container on a VPS, secure the web UI yourself, and keep it updated.",
      "Hivra stands it up behind an authenticated gateway and restarts the container if it crashes.",
      "Same open-source project either way, and you can point it at your own model provider in Settings.",
      "A VPS is a monthly bill plus your time. On Hivra, plans start at $9.99 a month.",
    ],
    affiliation: "Hivra is independent and is not affiliated with the Agent Zero project.",
    relatedBlogSlugs: ["agent-zero-vs-openclaw-hosting", "ai-agent-browser-automation-tools", "what-is-an-ai-agent"],
  },
];

/** Every slug with a public page, in page order (sitemap + static params). */
export const AGENT_SEO_SLUGS: AgentSeoSlug[] = AGENT_SEO_ENTRIES.map((entry) => entry.slug);

export function getAgentSeoEntry(slug: string): AgentSeoEntry | undefined {
  return AGENT_SEO_ENTRIES.find((entry) => entry.slug === slug);
}

/**
 * Primary CTA for an agent page: the signed-out sign-up funnel with the $9.99
 * plan and this runtime preselected. Every agent launches on that plan, so one
 * plan value serves all of them.
 */
export function agentDeployHref(entry: Pick<AgentSeoEntry, "agentType">): string {
  return `${AGENTS_HUB_DEPLOY_HREF}&agentType=${encodeURIComponent(entry.agentType)}`;
}

/**
 * Claims the /agents pages must never make today (owner decision 2026-09-14
 * plus what checkout sells). The catalog and page tests scan every copy string
 * and the rendered pages against this list.
 */
export const AGENT_COPY_BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /free trial/i, reason: "no trial exists" },
  { pattern: /\btrial\b/i, reason: "no trial exists" },
  { pattern: /card required|credit card|no card\b/i, reason: "no card-required or no-card offer" },
  { pattern: /never sleeps/i, reason: "sleep claims belong to plan terms, not agent pages" },
  { pattern: /always free|\bfree (plan|tier)\b|\$0\b/i, reason: "no hosted free plan is advertised" },
  { pattern: /unlimited/i, reason: "no unlimited-agents claim" },
  { pattern: /up to \d+ agents|\b\d+ agents\b|agent slots?\b/i, reason: "no agent-count limits" },
  { pattern: /one click|\bfew minutes\b|\b\d+ minutes\b|\bin minutes\b|\bin seconds\b/i, reason: "no unmeasured speed claims" },
  { pattern: /\bwindows\b/i, reason: "Windows is not generally available" },
  { pattern: /snapshot|\bclones?\b/i, reason: "snapshots and clones are not shipped" },
  { pattern: /backs? (it )?up|backups?/i, reason: "backups are not guaranteed" },
  { pattern: /never sees|never stores?|cannot read|can't read your|no access to your/i, reason: "Hivra administrators keep infrastructure access" },
  { pattern: /desktop app/i, reason: "no desktop app is published" },
  { pattern: /\b(aws|gcp|azure|digitalocean|google cloud)\b/i, reason: "no bring-your-own-cloud on those providers" },
  { pattern: /multi-agent coordination|orchestrat/i, reason: "coordination is not built in" },
  { pattern: /\b(Free|Pro|Power|Starter|Studio|Max|Command) plan\b/, reason: "plan names collide between checkout and the public ladder; use price and size" },
  { pattern: /[–—]/, reason: "no em or en dashes in page copy" },
  {
    pattern: /no SIGHUP|no tmux (required|needed)|survives? (laptop|lid) (sleep|close)|close your laptop\. it keeps/i,
    reason: "Claude Code and Codex runs started in the browser chat or agent terminal stop when that tab closes",
  },
];

/**
 * Agents whose runs are tied to the browser tab they were started in. On these
 * boxes the browser Chat runs one CLI process per message and kills it when the
 * browser disconnects (provisioner/hivra-chat/server.js), and the agent terminal
 * execs the CLI under ttyd with no tmux (provisioner/hivra-agent-shell), so
 * closing the tab ends that run. The computer itself stays on and keeps files,
 * sessions and logins. A run started inside tmux in the Box Terminal (tmux is
 * installed on the box), or from the box's Telegram connect, keeps going.
 * Hermes, OpenClaw, Agent Zero and Aeon run their loops server-side and are
 * not in this list.
 */
export const TAB_BOUND_AGENT_SLUGS: ReadonlyArray<AgentSeoSlug> = ["claude-code", "codex"];

const KEEPS_RUNNING = /\b(keeps?|kept) (going|working|running)\b|\bnothing stops\b|\bwalk away\b|\bfinished work\b/i;
const DETACHED_RUN = /\btmux\b|\bTelegram\b/;

/**
 * Sentences that promise a tab-bound agent keeps working without saying how
 * (inside tmux or from Telegram). Pass `mentioning` to check only sentences
 * about those agents, for copy that also covers server-side agents.
 */
export function unqualifiedKeepRunningClaims(text: string, mentioning?: RegExp): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split(/\n+/)
    .filter((sentence) => KEEPS_RUNNING.test(sentence) && !DETACHED_RUN.test(sentence))
    .filter((sentence) => !mentioning || mentioning.test(sentence));
}

/** Hub-level non-affiliation line, naming every vendor the hub lists. */
export const AGENTS_HUB_AFFILIATION =
  "Hivra is independent and is not affiliated with Anthropic, OpenAI, Nous Research, or the Aeon, OpenClaw and Agent Zero projects.";
