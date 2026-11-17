import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "linux-computer",
  section: "computers",
  title: "Linux computer",
  metaTitle: "Linux computer: a light Linux machine with a terminal",
  metaDescription: "A light headless Ubuntu computer with a terminal and files, and no desktop. It runs on Hivra Cloud with a paid plan. Here is what it does and does not do.",
  summary: "A light Linux computer with a terminal and files, and no desktop.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "A Linux computer is a headless Ubuntu computer. It shares its base with [Ubuntu Desktop](/docs/ubuntu-desktop) but leaves the desktop out, so it is small. You work in its Terminal and Files views.",
        "Use it for command line work, scripts and services that do not need a screen.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "It runs on Hivra Cloud, and every Hivra Cloud computer needs a paid plan. See [what you pay for](/docs/plans-and-billing).",
        "If you want to use a server of your own, see [Linux Sandbox](/docs/linux-sandbox) for a terminal workspace on a connected server.",
      ],
    },
    {
      heading: "Size",
      paragraphs: [
        "It needs as little as 0.5 CPU and 1 GB of memory. Launch offers CPU sizes of 0.5, 1, 2 and 4, and memory of 1, 2, 4 and 8 GB.",
      ],
    },
    {
      heading: "What it does not do yet",
      paragraphs: [
        "Attaching an agent to a Linux computer is not supported yet. An agent launched today gets a computer of its own. A Linux computer has no desktop, so Desktop never appears in its views.",
      ],
    },
    {
      heading: "Opening it",
      paragraphs: [
        "When it is ready, open it from your Home page and use Terminal and Files. Credentials you type into it may be stored on the computer, and Hivra administrators retain infrastructure access to Hivra-managed hosts. See [security and access](/docs/security-and-access).",
      ],
    },
  ],
  articles: ["ai-agent-vps"],
  next: ["ubuntu-desktop", "linux-sandbox", "open-an-agent"],
};
