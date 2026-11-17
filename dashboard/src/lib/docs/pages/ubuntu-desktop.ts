import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "ubuntu-desktop",
  section: "computers",
  title: "Ubuntu Desktop",
  metaTitle: "Ubuntu Desktop: a Linux computer you open in a browser",
  metaDescription: "An isolated Ubuntu computer with a desktop you open in your browser, plus files and a terminal. Runs on Hivra Cloud or a Proxmox server you connected.",
  summary: "An isolated Ubuntu computer with a desktop you open in your browser, with files and a terminal beside it.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Ubuntu Desktop is an isolated Ubuntu 22.04 LTS virtual machine. You get a desktop in your browser behind your Hivra sign-in, a shared terminal and a Files view. It is a computer of its own, so what you install and save there stays there.",
        "You can launch it without an agent, to use yourself or to give an agent a desktop to work on.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "- **Hivra Cloud.** Hivra runs the computer for you, on a paid plan. See [what you pay for](/docs/plans-and-billing).\n- **A Proxmox VE server you connected.** Connect it with SSH details and launch onto it with a free account. See [Run agents on your own server](/docs/connect-your-own-server).",
        "The one-command Ubuntu connect does not run Ubuntu Desktop. It gives you [Linux Sandbox](/docs/linux-sandbox) only.",
      ],
    },
    {
      heading: "What it needs",
      paragraphs: [
        "Ubuntu Desktop needs at least 2 CPU, 4 GB of memory and 40 GB of disk. On your own server, the host must be x86 with KVM, which Hivra checks before it launches.",
      ],
    },
    {
      heading: "Opening it",
      paragraphs: [
        "When the computer is ready, open it from your Home page. A computer shows a short list of views: Desktop, Terminal and Files, and Manage for its settings. [Open an agent or computer](/docs/open-an-agent) covers the views.",
        "If you want a headless computer with only a terminal and files, see [Linux computer](/docs/linux-computer).",
      ],
    },
    {
      heading: "Who can reach it",
      paragraphs: [
        "The desktop sits behind Hivra's authenticated gateway. Credentials you type into the computer may be stored on it. On Hivra Cloud, Hivra administrators retain infrastructure access to the host. On your own server, whoever controls the host can access it. See [security and access](/docs/security-and-access).",
      ],
    },
  ],
  articles: ["ubuntu-desktop-in-the-cloud", "run-managed-agents-on-your-own-computer"],
  next: ["linux-computer", "connect-your-own-server", "open-an-agent"],
};
