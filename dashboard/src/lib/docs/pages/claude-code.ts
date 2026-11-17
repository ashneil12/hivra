import type { DocPage } from "../types";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";

export const doc: DocPage = {
  slug: "claude-code",
  section: "agents",
  title: "Claude Code on Hivra",
  metaTitle: "Run Claude Code on Hivra",
  metaDescription: "What Claude Code is, where it runs on Hivra, how it gets its model, how you open it and what keeps running after you close the tab.",
  summary: "Claude Code is Anthropic's coding agent. On Hivra it runs on a computer of its own, with a chat, a terminal and your files.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Claude Code is Anthropic's coding agent. Hivra runs the Claude Code CLI on a computer of its own, so your repos, tools and login stay put between visits. The [Claude Code page](/agents/claude-code) has the longer pitch.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud, which needs a paid plan (see [pricing](/pricing)), or a Proxmox server you connected. A free Hivra account is enough for your own server. See [Run agents on your own server](/docs/connect-your-own-server).",
        "Each agent gets its own computer, with its own files and working environment.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "Sign in with your own Claude account inside Claude Code after it opens, or launch it on Hivra credits. With credits, Hivra translates Claude Code's requests for Venice's Claude models and bills your credits. Pasting an API key is not an option for Claude Code. [Models and credits](/docs/models-and-credits) covers the choice.",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. You see Hivra's own views: a Chat tab, a Claude Code session tab for its own command line, a Files tab, a Terminal tab, plus Skills, Telegram and Manage.",
      ],
    },
    {
      heading: "What keeps running",
      paragraphs: [
        CLI_RUN_LIFETIME,
      ],
    },
    {
      heading: "Update it",
      paragraphs: [
        "Updating is covered on [Update an agent](/docs/update-an-agent).",
      ],
    },
    {
      heading: "Who makes it",
      paragraphs: [
        "Hivra is an independent hosting service and is not affiliated with or endorsed by Anthropic. Claude Code is Anthropic's product.",
      ],
    },
  ],
  articles: ["keep-claude-code-running-24-7", "control-claude-code-from-telegram"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
