// /agents: the directory page. Wording from Ash's batch 02 file 01-agents-directory.md, with the edits
// listed in the lane ledger (price phrasing, refund wording, AI usage note). The browser title and the
// search description are literals in page.tsx, where the title scanners read them.

import { AGENTS_HUB_AFFILIATION } from "@/lib/hivra/agent-seo-catalog";
import { REPOSITORY_URL, fill } from "./shared";
import type { HubContent } from "./types";

export const HUB_CONTENT: HubContent = {
  h1: "Pick your agent. We'll give it a computer.",
  lead: [
    "Some agents write code. Others work through your messages, run scheduled jobs or tackle open-ended tasks. What they have in common is that they need somewhere reliable to work.",
    "Hivra gives each deployment a computer in the cloud, with the tools and interfaces it needs to do its job. You choose the agent and connect the accounts or model provider you want to use. Every Hivra Cloud computer needs a paid plan, and a paid computer stays available after you close your laptop.",
  ],
  heroLinks: [
    { label: "Explore agents", target: "directory" },
    { label: "See pricing", target: "pricing" },
  ],
  intro: {
    heading: "You bring the intelligence. We handle the computer.",
    paragraphs: [
      fill(
        "Hivra isn't a new model subscription or a replacement for the agents you already like. It's where you run them. For Claude Code, that means signing into your own Anthropic account. For Codex, it's your ChatGPT sign-in or an OpenAI API key, and both are subject to the provider's terms. Other agents use their own model configuration and integrations. {aiNote}",
      ),
      "We take care of provisioning the computer and giving you a practical way to reach it. Depending on the agent, that could mean a chat view, web terminal, files, a live browser or the project's own dashboard.",
    ],
    topics: [
      {
        heading: "A computer that doesn't sleep with your laptop",
        paragraphs: [
          "A paid Hivra computer isn't paused for inactivity. Your files and configuration stay there between visits. Long terminal-based coding jobs can continue in `tmux`, while agent frameworks with their own schedulers can keep doing recurring work. The exact behaviour depends on the agent: closing a browser tab does **not** make an ordinary interactive command persistent by itself.",
        ],
      },
      {
        heading: "Private by design, not magically inaccessible",
        paragraphs: [
          "Each deployment has its own isolated VM or computer environment. That's a much better starting point than giving an agent unrestricted access to the laptop where you keep everything else. It is still a hosted service: model providers receive the prompts you send them according to their terms, credentials can live inside your VM, and Hivra administrators retain infrastructure-level access to managed hosts. Keep secrets scoped and review agent permissions.",
        ],
      },
      {
        heading: "Start with the resources you need",
        paragraphs: [
          fill(
            "Every computer that Hivra Cloud runs for you needs a paid plan, from **{entry}**. A free account works with a computer or server you connect yourself. The **{largerPrice} a month** option gives you {largerCompute}. Model usage, GitHub Actions consumption or third-party services can be billed separately by their providers. {refund}",
          ),
        ],
      },
    ],
  },
  directory: {
    heading: "Choose an agent",
    cards: [
      {
        slug: "claude-code",
        name: "Claude Code",
        tagline: "For people building software with Anthropic's coding agent.",
        body: "Run the official Claude Code CLI on a computer you can reach from a browser. Bring your Anthropic sign-in, work with repos and files, and use a web terminal for longer sessions. An optional live browser lets you watch and take over browser work.",
        goodFit: "coding projects, debugging, repo-wide changes and development sessions you want to resume from another device.",
        linkLabel: "Run Claude Code",
      },
      {
        slug: "codex",
        name: "Codex",
        tagline: "For developers who prefer OpenAI's coding agent.",
        body: "Run the official Codex CLI on its own cloud computer. Sign in through ChatGPT or use your OpenAI key, work on repositories and leave long terminal jobs running in `tmux`.",
        goodFit: "code implementation, testing, debugging and repository maintenance.",
        linkLabel: "Run Codex",
      },
      {
        slug: "hermes",
        name: "Hermes",
        tagline: "For a personal, general-purpose agent you can build routines around.",
        body: "Hermes, from Nous Research, brings memory, skills and scheduled tasks together. Give it its own workspace, connect a supported model provider and let it pick up work where it left off.",
        goodFit: "recurring research, personal workflows, tool use and a more persistent working relationship with an agent.",
        linkLabel: "Run Hermes",
      },
      {
        slug: "aeon",
        name: "Aeon",
        tagline: "For recurring work that belongs in your GitHub account.",
        body: "This one works differently. Hivra hosts Aeon's dashboard, but the scheduled tasks execute through **your GitHub Actions** on your own fork. The dashboard computer counts as one of your agents but uses none of your plan's shared CPU and RAM.",
        goodFit: "scheduled scans, PR review and research digests that you want to run through GitHub.",
        linkLabel: "Run Aeon",
      },
      {
        slug: "openclaw",
        name: "OpenClaw",
        tagline: "For an agent you can message like a contact.",
        body: "Deploy the open-source OpenClaw gateway, connect supported messaging channels such as Telegram, WhatsApp or Signal, and set routines that can run while you're away. Its own Control UI remains behind Hivra's authenticated gateway.",
        goodFit: "messaging-based assistants, reminders, recurring routines and workflows triggered away from your desk.",
        linkLabel: "Run OpenClaw",
      },
      {
        slug: "agent-zero",
        name: "Agent Zero",
        tagline: "For more open-ended work with a browser and computer.",
        body: "Run the open-source Agent Zero stack with its own tools and dashboard. Give it a goal, choose a model and let it work through the steps on a separate computer rather than your everyday machine.",
        goodFit: "research, browser-driven tasks, code execution and experimentation with a general-purpose agent.",
        linkLabel: "Run Agent Zero",
      },
    ],
  },
  choose: {
    heading: "Which one should I choose?",
    paragraphs: [
      "If most of your work is coding, start with **Claude Code or Codex**, whichever model and workflow you already prefer. For a personal agent with memory and repeat jobs, look at **Hermes**. If you want to interact through messaging apps, **OpenClaw** is built around that experience. For more exploratory autonomous tasks, consider **Agent Zero**. And if the work is naturally scheduled inside GitHub, **Aeon** makes particular sense.",
      "You aren't choosing a lifelong ecosystem. You're choosing a good starting point for the work you want done.",
    ],
  },
  boundaries: {
    heading: "What Hivra does, and what it doesn't",
    items: [
      {
        term: "We provide the computer and hosting interface.",
        text: "The underlying agents come from their respective creators.",
      },
      {
        term: "You connect your own accounts or supported model provider.",
        text: "Provider charges and usage limits still apply. You can also pay with Hivra credits where the agent supports it.",
      },
      {
        term: "Paid computers stay available.",
        text: "Some jobs need to be started in a persistent session or configured with the agent's scheduler.",
      },
      {
        term: `You can inspect [Hivra's source](${REPOSITORY_URL}).`,
        text: `The platform is open source, and you can explore [self-hosting](${REPOSITORY_URL}) if you prefer to manage the infrastructure yourself.`,
      },
      {
        term: "Isolation reduces risk, but doesn't replace judgement.",
        text: "An agent with credentials or broad permissions can still make mistakes or take unwanted actions.",
      },
    ],
  },
  closing: {
    heading: "Ready to give one a home?",
    paragraph:
      "Start with an agent you already know, or pick one above to explore. You can always learn the interface before giving it important access.",
    links: [
      { label: "Start now", target: "deploy" },
      { label: "Compare plans", target: "pricing" },
      { label: "Explore Hivra features", target: "features" },
    ],
  },
  affiliation: AGENTS_HUB_AFFILIATION,
};
