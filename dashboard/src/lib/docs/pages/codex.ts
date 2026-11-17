import type { DocPage } from "../types";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";

export const doc: DocPage = {
  slug: "codex",
  section: "agents",
  title: "Codex on Hivra",
  metaTitle: "Run Codex on Hivra",
  metaDescription: "What Codex is, where it runs on Hivra, how it gets its model, how you open it and what keeps running after you close the tab.",
  summary: "Codex is OpenAI's coding agent. On Hivra it runs on a computer of its own, with a chat, a terminal and your files.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Codex is OpenAI's coding agent. Hivra runs the Codex CLI on a computer of its own, so your repos, tools and login stay put between visits. The [Codex page](/agents/codex) has the longer pitch.",
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
        "Sign in with ChatGPT inside Codex after it opens, paste your own OpenAI API key, or pay with Hivra credits. [Models and credits](/docs/models-and-credits) compares the three.",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. You see Hivra's own views: a Chat tab, a Codex session tab for its own command line, a Files tab and a Terminal tab, plus Skills and Manage.",
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
        "Hivra is an independent hosting service and is not affiliated with or endorsed by OpenAI. Codex is OpenAI's product.",
      ],
    },
  ],
  articles: ["run-codex-24-7-in-the-cloud", "codex-pricing-by-chatgpt-plan"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
