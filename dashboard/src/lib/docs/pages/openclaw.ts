import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "openclaw",
  section: "agents",
  title: "OpenClaw on Hivra",
  metaTitle: "Run OpenClaw on Hivra",
  metaDescription: "What OpenClaw is, where it runs on Hivra, how it gets its model, how you open its Control UI and how much computer it needs.",
  summary: "OpenClaw is an open-source agent with its own Control UI. On Hivra it runs on a computer of its own.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "OpenClaw is an open-source agent, made by the OpenClaw project. Hivra hosts it on a private computer. The [OpenClaw page](/agents/openclaw) has the longer pitch.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud, which needs a paid plan (see [pricing](/pricing)), or a Proxmox server you connected. A free Hivra account is enough for your own server. See [Run agents on your own server](/docs/connect-your-own-server). It needs at least 1 vCPU and 2 GB of RAM.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "Choose a model provider inside OpenClaw's Control UI after it opens, or pay with Hivra credits. See [Models and credits](/docs/models-and-credits).",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. OpenClaw's Control UI stays bound to the computer's localhost and reaches you through Hivra's sign-in. The agent's page also has Dashboard, Terminal, Files and Manage tabs. Set up your messaging channels inside the Control UI.",
        "Nothing about OpenClaw needs your browser to stay open: it runs on the computer itself.",
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
        "Hivra is an independent hosting service and is not affiliated with or endorsed by the OpenClaw project. OpenClaw is their software.",
      ],
    },
  ],
  articles: ["how-to-self-host-openclaw", "hermes-vs-openclaw"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
