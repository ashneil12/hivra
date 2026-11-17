import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "linux-sandbox",
  section: "computers",
  title: "Linux Sandbox",
  metaTitle: "Linux Sandbox: a terminal workspace on your own server",
  metaDescription: "A light Linux terminal and Python workspace isolated with gVisor on an Ubuntu server you connect with one command. Works with a free account.",
  summary: "A light Linux terminal and Python workspace on a server you connected, isolated with gVisor.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Linux Sandbox runs one Linux terminal and Python workspace on your connected host, isolated with gVisor. You open it and work in a terminal.",
        "It is small by design: no graphical desktop, no public ports, and the resources reserved for it are also its maximum limits. Sandboxes can use 0.5, 1, 2 or 4 CPU and 1, 2, 4 or 8 GB of memory.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "It runs on a server you connected, and only there. Hivra Cloud does not run it. Because the server is yours, a free account is enough. See [what you pay for](/docs/plans-and-billing).",
        "The one-command Ubuntu connect gives you Linux Sandbox only. It works with Ubuntu 22.04 or 24.04 on x86, root or sudo access, and cgroup v2. [Run agents on your own server](/docs/connect-your-own-server) walks through it.",
      ],
    },
    {
      heading: "How the isolation works",
      paragraphs: [
        "gVisor gives an application-kernel boundary. It is not a hardware virtual machine. Your server operator still controls the host kernel, and since you connected the server, that is you or whoever runs it.",
        "Hivra checks the server and sets up the sandbox runtime as separate steps you approve. If the sandbox release changes, Hivra asks you to set up Linux Sandbox on the server again, and your sandboxes keep running meanwhile.",
      ],
    },
    {
      heading: "What it is not",
      paragraphs: [
        "Linux Sandbox is for terminal work. If you want a desktop, use [Ubuntu Desktop](/docs/ubuntu-desktop) on a Proxmox VE server. If you want agents such as Claude Code or Codex on your own server, connect Proxmox VE with SSH details too.",
      ],
    },
    {
      heading: "Who can reach it",
      paragraphs: [
        "The one-command connect creates a user named hivra that signs in with Hivra's key and can use sudo, so Hivra gets administrator access to the server. See [security and access](/docs/security-and-access).",
      ],
    },
  ],
  articles: ["run-managed-agents-on-your-own-computer"],
  next: ["connect-your-own-server", "linux-computer", "security-and-access"],
};
