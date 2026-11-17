import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "aeon",
  section: "agents",
  title: "Aeon on Hivra",
  metaTitle: "Run Aeon on Hivra",
  metaDescription: "What Aeon is, where its dashboard runs on Hivra, why its scheduled tasks run on your own GitHub Actions, and how it gets its model.",
  summary: "Aeon runs scheduled tasks. On Hivra, its dashboard lives on a small computer and the tasks run on your own GitHub Actions.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Aeon is a scheduled-task agent, made by the Aeon project. Hivra hosts its dashboard on a small computer. The tasks themselves run on your own GitHub Actions, so GitHub sets the compute limits and any Actions charges. The [Aeon page](/agents/aeon) has the longer pitch.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud, which needs a paid plan (see [pricing](/pricing)), or a Proxmox server you connected. A free Hivra account is enough for your own server. See [Run agents on your own server](/docs/connect-your-own-server). The dashboard needs only 0.5 vCPU and 1 GB of RAM.",
      ],
    },
    {
      heading: "Connect GitHub",
      paragraphs: [
        "After launch you connect your GitHub account. The token needs read and write access to Secrets, Actions, Contents and Workflows, and the connect stops with a message if it cannot write secrets.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "Aeon uses the AI provider key you set on your GitHub fork. The launch also offers Hivra credits. See [Models and credits](/docs/models-and-credits).",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. The Dashboard tab shows Aeon's own dashboard. The agent's page also has Terminal, Files and Manage tabs for the computer. Your scheduled tasks keep running on GitHub whether or not your browser is open.",
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
        "Hivra is an independent hosting service and is not affiliated with or endorsed by the Aeon project. Aeon is their software.",
      ],
    },
  ],
  articles: ["what-is-aeon-agent"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
