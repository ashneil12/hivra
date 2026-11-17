import type { DocPage } from "../types";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "@/lib/blog/runtime-facts";

export const doc: DocPage = {
  slug: "open-an-agent",
  section: "run",
  title: "Open your agent",
  metaTitle: "Open your agent and find its views",
  metaDescription: "Open an agent from your Home page and find its views: chat, terminal, files and manage for Claude Code and Codex, or its own web app for the others.",
  summary: "Open an agent from your Home page. What you see depends on the agent: a chat and terminal, or the agent's own web app.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "Open it",
      paragraphs: [
        "When an agent's computer is ready, the agent appears on your Home page. Open it. Each agent has a computer of its own, with its own files and working environment, and the page you land on is organised around that.",
      ],
    },
    {
      heading: "Claude Code and Codex",
      paragraphs: [
        "These two open with views grouped as the agent, its browser, its computer and Manage:",
        "- **Chat** to talk to the agent, and a Claude Code session or Codex session for the agent's own command line.\n- **Browser**, a view-only look at the browser the agent drives, where the agent has one.\n- **Terminal** and **Files** for the computer itself, and **Desktop**, which explains how to give the agent a desktop.\n- **Manage** for the agent's settings. For Claude Code there is also a **Telegram** view, which connects your own bot to the computer.",
      ],
    },
    {
      heading: "Hermes, OpenClaw, Agent Zero, Aeon and DeepSeek Harness",
      paragraphs: [
        "These open into the agent's own web app, reached through Hivra's authenticated gateway. You use the agent the way its makers designed it. For OpenClaw, Agent Zero and Aeon the page shows that app as **Dashboard**, with **Terminal**, **Files** and **Manage** beside it.",
        "Which model the agent uses is set at launch or in the agent's own settings. See [how your agent gets its model](/docs/models-and-credits).",
      ],
    },
    {
      heading: "What keeps running",
      paragraphs: [
        CLI_RUN_LIFETIME,
        SERVER_SIDE_AGENTS_KEEP_WORKING,
        "Your files, repos and logins stay on the computer when you close the tab or the laptop.",
      ],
    },
    {
      heading: "Computers",
      paragraphs: [
        "A computer you launched without an agent shows a shorter list. [Ubuntu Desktop](/docs/ubuntu-desktop) offers Desktop, Terminal and Files, and a [Linux computer](/docs/linux-computer) has no desktop.",
      ],
    },
  ],
  articles: ["keep-claude-code-running-24-7", "run-codex-24-7-in-the-cloud", "run-ai-agents-24-7"],
  next: ["update-an-agent", "security-and-access", "models-and-credits"],
};
