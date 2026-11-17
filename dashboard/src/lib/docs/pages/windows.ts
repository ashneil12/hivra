import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "windows",
  section: "computers",
  title: "Windows on your own server with your licensed image",
  metaTitle: "Windows on your own server, with your licensed image",
  metaDescription: "Run a persistent Windows computer on a Proxmox VE server you connected, built from your own licensed Windows ISO, with a browser setup console.",
  summary: "A persistent Windows computer on a Proxmox VE server you connected, built from your own licensed image.",
  lastReviewed: "2026-11-17",
  status: "condition",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "This is a persistent Windows computer with an interactive setup console in your browser. You bring the install image and the licence.",
      ],
    },
    {
      heading: "The condition",
      paragraphs: [
        "Windows is offered on your own server, from your own licensed image. A Windows computer that someone else hosts for you is not offered. If you do not run a server, this is not for you today.",
        "You supply your own licensed Windows ISO. Your licence terms with Microsoft apply to it.",
      ],
    },
    {
      heading: "What you need",
      paragraphs: [
        "- A Proxmox VE server connected with SSH details, with KVM available.\n- Your own licensed Windows ISO.\n- At least 4 CPU, 8 GB of memory and 64 GB of disk for the computer.",
        "The one-command Ubuntu connect cannot run it. That route gives [Linux Sandbox](/docs/linux-sandbox) only. See [Run agents on your own server](/docs/connect-your-own-server) for connecting Proxmox VE.",
      ],
    },
    {
      heading: "Cost",
      paragraphs: [
        "The server is yours, so a free account is enough. The paid plan is for computers Hivra Cloud runs. See [what you pay for](/docs/plans-and-billing).",
      ],
    },
    {
      heading: "Who can reach it",
      paragraphs: [
        "Whoever controls the connected host can access its infrastructure, including the computers on it. See [security and access](/docs/security-and-access).",
      ],
    },
  ],
  next: ["connect-your-own-server", "ubuntu-desktop", "security-and-access"],
};
