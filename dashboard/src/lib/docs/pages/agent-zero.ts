import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "agent-zero",
  section: "agents",
  title: "Agent Zero on Hivra",
  metaTitle: "Run Agent Zero on Hivra",
  metaDescription: "What Agent Zero is, where it runs on Hivra, how it gets its model, how you open its dashboard and how much computer it needs.",
  summary: "Agent Zero is an open-source agent with its own dashboard. On Hivra it runs in a container on a computer of its own.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Agent Zero is an open-source agent, made by the Agent Zero project. Hivra hosts it in a container on a private computer. The [Agent Zero page](/agents/agent-zero) has the longer pitch.",
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
        "Choose a model provider in Agent Zero's own Settings after it opens, or pay with Hivra credits. See [Models and credits](/docs/models-and-credits).",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. Agent Zero's dashboard stays bound to the computer's localhost and reaches you through Hivra's sign-in. The agent's page also has Dashboard, Terminal, Files and Manage tabs.",
        "Nothing about Agent Zero needs your browser to stay open: it runs on the computer itself.",
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
        "Hivra is an independent hosting service and is not affiliated with or endorsed by the Agent Zero project. Agent Zero is their software.",
      ],
    },
  ],
  articles: ["what-is-agent-zero", "agent-zero-vs-openclaw-hosting"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
