import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "openbot",
  section: "agents",
  title: "OpenBot on Hivra (preview)",
  metaTitle: "OpenBot on Hivra (preview)",
  metaDescription: "OpenBot from CopilotKit is in preview on Hivra and not in the Launch list yet. What it needs and how it would run.",
  summary: "OpenBot is CopilotKit's agent workspace. It is in preview on Hivra and not in the Launch list yet.",
  lastReviewed: "2026-11-17",
  status: "preview",
  blocks: [
    {
      heading: "Preview status",
      paragraphs: [
        "OpenBot is in preview on Hivra. It is not in the Launch list yet, so you cannot launch it from there today. This page describes how it works so you know what to expect.",
      ],
    },
    {
      heading: "What it is",
      paragraphs: [
        "OpenBot is made by CopilotKit. Hivra runs CopilotKit's official OpenBot image on a private computer, adds no modifications, and serves OpenBot's own workspace behind your Hivra sign-in.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud only, on a paid plan (see [pricing](/pricing)). It needs at least 1 vCPU and 3 GB of RAM.",
        "Once it is available to launch, the agent's page opens OpenBot at its own address on the computer, behind your Hivra sign-in.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "Models run through Venice on Hivra credits by default. You can change provider in OpenBot's own settings. OpenBot also will not start without a CopilotKit Intelligence key, so the first open shows a page to paste it. The key stays on the computer.",
      ],
    },
    {
      heading: "Update it",
      paragraphs: [
        "Press the Update button. It pulls the latest OpenBot image and puts the previous image and database back if the new one does not start.",
      ],
    },
    {
      heading: "Who makes it",
      paragraphs: [
        "Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit. OpenBot is their software.",
      ],
    },
  ],
  articles: ["openbot-ai-coworkers"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
