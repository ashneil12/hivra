import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "connect-your-own-server",
  section: "start",
  title: "Run agents on your own server",
  metaTitle: "Connect your own server to Hivra",
  metaDescription: "Connect a Proxmox VE server with SSH details, or an Ubuntu server with one command for Linux Sandbox. What each runs, and what a free account can do.",
  summary: "Connect a server you already run and launch onto it with a free account. How much it can run depends on how you connect it.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "Two ways to connect",
      paragraphs: [
        "Open [Infrastructure](/dashboard/infrastructure) and choose to connect your own machine. There are two routes, and they run different things:",
        "| How you connect | Server | What it can run |\n| --- | --- | --- |\n| SSH details | Proxmox VE | Claude Code, Codex, OpenClaw, Agent Zero, Aeon and Ubuntu Desktop, plus Windows from your own licensed image |\n| One command | Ubuntu 22.04 or 24.04 on x86 | Linux Sandbox only |",
        "Hermes and DeepSeek Harness run on Hivra Cloud only, so a connected server cannot run them.",
      ],
    },
    {
      heading: "Connect Proxmox VE with SSH details",
      paragraphs: [
        "Choose **Connect with SSH details**. You give Hivra the server's address and a key that already lets you sign in, and you check the server's fingerprint so Hivra connects to the right machine. Proxmox VE connects with a root login for now.",
        "Hivra then inspects what the server can run without changing it. Preparing the server and launching onto it are separate steps, and you approve each one. A cloud VM needs nested KVM to host the hardware VMs that agents run in, and connecting does not guarantee a server is compatible.",
      ],
    },
    {
      heading: "Connect Ubuntu with one command",
      paragraphs: [
        "Choose the setup command, copy it and paste it into a terminal on the server, as root or as a user who can use sudo. It asks for a one-time code, and your terminal asks you to check your account code. The code is single use and expires. If you want to read the script first, the page can show it to you.",
        "The server needs a public IPv4 address and must accept SSH from the internet. A machine at home or in an office usually cannot be reached from hosted Hivra.",
        "The command creates a user named hivra that signs in only with Hivra's key and can use sudo, so Hivra gets administrator access to that server. Nothing else is installed by the command.",
        "An Ubuntu server connected this way runs [Linux Sandbox](/docs/linux-sandbox) only. For the agents above, connect Proxmox VE with SSH details instead.",
      ],
    },
    {
      heading: "What a free account can do",
      paragraphs: [
        "A free account works with a computer or server you connect yourself. Connecting costs nothing, and the paid plan applies to computers Hivra Cloud runs. See [what you pay for](/docs/plans-and-billing).",
        "Whoever controls the connected host can access its infrastructure. Hivra does not become the host operator. [Security and access](/docs/security-and-access) covers who can reach what.",
      ],
    },
  ],
  articles: ["run-managed-agents-on-your-own-computer", "managed-vs-self-hosted-ai-agents"],
  next: ["linux-sandbox", "ubuntu-desktop", "plans-and-billing", "security-and-access"],
};
