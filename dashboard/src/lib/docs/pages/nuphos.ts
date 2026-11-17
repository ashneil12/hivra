import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "nuphos",
  section: "agents",
  title: "Nuphos on Hivra (preview)",
  metaTitle: "Nuphos on Hivra (preview)",
  metaDescription: "Nuphos is in preview on Hivra and not in the Launch list yet. What it needs, whose account it uses and how you update it.",
  summary: "Nuphos gives a Nuphos runtime a computer of its own. It is in preview on Hivra and not in the Launch list yet.",
  lastReviewed: "2026-11-17",
  status: "preview",
  blocks: [
    {
      heading: "Preview status",
      paragraphs: [
        "Nuphos is in preview on Hivra. It is not in the Launch list yet, so you cannot launch it from there today. This page describes how it works so you know what to expect.",
      ],
    },
    {
      heading: "What it is",
      paragraphs: [
        "Nuphos makes the runtime. Hivra runs Nuphos's official runtime image (Claude Code variant) on a private computer, adds no modifications, and serves the runtime's own console behind your Hivra sign-in.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud only, on a paid plan (see [pricing](/pricing)). It needs at least 1 vCPU and 3 GB of RAM.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "Hivra provides the computer, not the model. You use your own Nuphos account and your own Claude sign-in, and Hivra credits are not used.",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open the console, set a password, then press Connect to Nuphos. After that you chat from the Nuphos apps, not from a Hivra chat view.",
      ],
    },
    {
      heading: "Update it",
      paragraphs: [
        "Press the Update button on the agent's page.",
      ],
    },
    {
      heading: "Who makes it",
      paragraphs: [
        "Hivra is an independent hosting service and is not affiliated with or endorsed by Nuphos. Nuphos is a separate product from its makers.",
      ],
    },
  ],
  articles: ["nuphos-claude-code-team-chat"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
