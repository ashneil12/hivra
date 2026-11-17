import type { DocPage } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";

export const doc: DocPage = {
  slug: "getting-started",
  section: "start",
  title: "Launch your first agent",
  metaTitle: "Launch your first AI agent on Hivra",
  metaDescription: "Make a Hivra account, pick an agent, choose how it reaches its model and where it runs, then open it from your browser.",
  summary: "Four choices take you from a new account to an agent running on a computer of its own.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "Before you start",
      paragraphs: [
        "A Hivra account costs nothing. What you pay for is the computer your agent runs on, and you have two ways to provide one:",
        `- **Hivra Cloud.** Hivra runs the computer for you. Every Hivra Cloud computer needs a paid plan, starting at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.\n- **Your own server.** Connect a server you already run and launch agents onto it with a free account. See [Run agents on your own server](/docs/connect-your-own-server).`,
      ],
    },
    {
      heading: "1. Choose your agent",
      paragraphs: [
        "[Sign up](/sign-up), then open **Launch**. Pick an agent such as [Hermes](/docs/hermes), [Claude Code](/docs/claude-code) or [Codex](/docs/codex), or a computer such as [Ubuntu Desktop](/docs/ubuntu-desktop). Each one gets its own computer, with its own files and working environment.",
        "Not sure which to pick? Hermes is a general agent that keeps memory and runs scheduled jobs. Claude Code and Codex are coding agents. The [Agents section](/docs#agents) has a page for each.",
      ],
    },
    {
      heading: "2. Connect its AI",
      paragraphs: [
        "An agent needs a model to think with. Depending on the agent, you can run it on Hivra credits, paste a supported API key, or sign in with an account you already have, such as Claude for Claude Code or ChatGPT for Codex. [Choose how your agent gets its model](/docs/models-and-credits) explains each option.",
      ],
    },
    {
      heading: "3. Choose where it runs",
      paragraphs: [
        "Pick Hivra Cloud, or a server you connected. Some agents run on Hivra Cloud only; each agent's page says where it can run.",
      ],
    },
    {
      heading: "4. Launch and open it",
      paragraphs: [
        "Review the summary and launch. When the computer is ready, the agent appears on your Home page. Open it to reach the agent in its own interface: a chat and terminal for Claude Code and Codex, or the agent's own web app for Hermes, OpenClaw and Agent Zero. [Open your agent](/docs/open-an-agent) covers what each view does.",
        "Your files and the agent's environment stay on its computer when you close the tab or the laptop.",
      ],
    },
  ],
  articles: ["what-is-an-ai-agent", "managed-vs-self-hosted-ai-agents"],
  next: ["models-and-credits", "connect-your-own-server", "open-an-agent"],
};
