import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "ubuntu-desktop-in-the-cloud",
  title: "A cloud Ubuntu desktop for you or your AI agent",
  metaTitle: "A cloud Ubuntu desktop for you or your AI agent",
  metaDescription:
    "Hivra's Ubuntu Desktop is an isolated Ubuntu computer you open in the browser, with a terminal and files. What it has, what it needs and who it is for.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "A real Linux desktop that is not your computer.",
  intro:
    "Some work needs a whole desktop, not just a chat or a terminal: a browser window, a file manager, apps that expect a screen. Ubuntu Desktop on Hivra is that, on a computer separate from yours, opened from a browser tab.",
  shortAnswer:
    "Ubuntu Desktop is an isolated Ubuntu computer on Hivra, opened in your browser as a desktop, with a shared terminal and files. It is Ubuntu 22.04 LTS with 2 vCPU, 4 GB of RAM and a 40 GB disk. It runs on Hivra Cloud, which needs a paid plan, or on a server you connect.",
  sections: [
    {
      heading: "What it is",
      paragraphs: [
        "Ubuntu Desktop is a virtual machine running Ubuntu 22.04 LTS with a desktop on it. You do not install anything on your own machine. You open it in a browser tab, and you see and use a Linux desktop that lives on a computer in the cloud.",
        "Alongside the desktop you get a terminal and a files view, both reached through the same Hivra sign-in. The desktop is delivered to the browser through that authenticated gateway, so you do not set up a remote desktop service yourself.",
        "Your agent needs computer access. It doesn't need your computer. The same is true of you: a throwaway desktop for risky downloads, a clean environment for a tool you do not trust yet, or a machine you can leave running, all without touching your own.",
      ],
    },
    {
      heading: "What you get",
      paragraphs: [
        "The computer is isolated from your own. Its floor is 2 vCPU and 4 GB of RAM, with a 40 GB disk. That is a real desktop, with room for a browser and a few apps, not a thin shell.",
        "It runs on Hivra Cloud on a paid plan, or on a Proxmox server you connected. Ubuntu Desktop is the full desktop. If you only need a terminal and files without a screen, the Linux computer is the lighter option, and [its docs page](/docs/linux-computer) covers it.",
        "Because its floor equals the whole compute of the entry plan, a desktop on that plan uses all of it. Hivra Cloud paid plans start at " + ENTRY_PLAN_PRICE + " a month for " + ENTRY_PLAN_SIZE + ", and a larger plan gives you room to run it alongside an agent.",
      ],
    },
    {
      heading: "Why a desktop at all",
      paragraphs: [
        "Terminal agents cover a lot, but some tasks want a screen: signing in to a site once and staying signed in, using a graphical tool, watching what a browser is doing, or poking at an app that has no command line. A desktop gives those tasks a place to run.",
        "It is also a comfortable place to keep long-lived work. A computer that stays on keeps its files, its logins and its open windows. You can close your laptop, open the desktop from your phone or another machine, and carry on where it was.",
        "For an AI agent, a desktop is one more kind of environment to work in. Whether a given agent tool can use a graphical desktop is up to that tool, so check what it supports. If you want an agent that brings its own browser, [Agent Zero](/blog/what-is-agent-zero) ships one in its container.",
      ],
    },
    {
      heading: "Keeping it safe",
      paragraphs: [
        "Isolation helps, but it is not a guarantee. A separate virtual machine keeps what happens on it away from your own files. It does not stop you or an agent from installing something harmful on it, signing in to an account and exposing it, or storing a secret you should not.",
        "Credentials may be stored on the agent computer, and Hivra administrators retain infrastructure access on Hivra-managed computers. Use accounts that are limited to what the work needs, and do not store anything on it you would not put on a shared machine.",
        "Hivra does not guarantee backups, so keep copies of anything you cannot recreate. The wider questions of leaving something running are in [is it safe to leave an AI agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended).",
      ],
    },
    {
      heading: "Using it",
      paragraphs: [
        "Launch Ubuntu Desktop from your dashboard, pick Hivra Cloud or a server you connected, and open it when it is ready. The setup steps and current details are on [the Ubuntu Desktop docs page](/docs/ubuntu-desktop).",
        "Treat it like any Ubuntu machine. Install what you need with the package manager, keep project files in a folder you can find, and use the terminal when it is faster than the mouse. When you are done, the computer stays where you left it.",
      ],
    },
    {
      heading: "Who it is for",
      paragraphs: [
        "Ubuntu Desktop suits developers and AI power users who want a clean Linux machine they can reach from anywhere: for trying tools, for isolated browsing, or as a base for their own agent setups. It is not a replacement for your main computer, and it is not a place to run something you would not run on a shared machine.",
        "To see how it fits next to the agents, read [how to run managed agents on your own computer](/blog/run-managed-agents-on-your-own-computer). Hivra is an independent hosting service and is not affiliated with or endorsed by Ubuntu or its publisher.",
      ],
    },
  ],
  faqs: [
    {
      q: "What does Ubuntu Desktop run?",
      a: "Ubuntu 22.04 LTS with a desktop, on an isolated virtual machine with 2 vCPU, 4 GB of RAM and a 40 GB disk.",
    },
    {
      q: "How do I connect to it?",
      a: "From your browser. The desktop, a shared terminal and a files view are reached through the Hivra sign-in, so you do not set up a remote desktop service yourself.",
    },
    {
      q: "Does it need a paid plan?",
      a: "On Hivra Cloud, yes: every Hivra Cloud computer needs a paid plan. You can also launch on your own Proxmox server if your account is eligible to connect it.",
    },
    {
      q: "Can an AI agent use it?",
      a: "It is a normal Ubuntu desktop with a terminal, so agent tools you install can use it. Whether a given tool works with a graphical desktop depends on the tool.",
    },
    {
      q: "Is it the same as the Linux computer?",
      a: "No. The Linux computer is a headless Ubuntu computer with a terminal and files and no desktop. Ubuntu Desktop adds the full desktop.",
    },
  ],
  relatedArticles: [
    { slug: "run-managed-agents-on-your-own-computer", title: "Run managed agents on your own computer" },
    { slug: "ai-agent-vps", title: "AI agent VPS: what to know" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended?" },
    { slug: "ai-agent-browser-automation-tools", title: "AI agent browser automation tools" },
  ],
};
