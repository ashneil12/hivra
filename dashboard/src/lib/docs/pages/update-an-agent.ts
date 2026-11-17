import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "update-an-agent",
  section: "run",
  title: "Update an agent",
  metaTitle: "Update an agent you run on Hivra",
  metaDescription: "Agents install from their official upstream, and you update them yourself. For Hermes, run hermes update or press Update on the agent's Manage tab.",
  summary: "Agents install from their official upstream. You decide when to update, and how depends on the agent.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "How updates work",
      paragraphs: [
        "Hivra installs a supported agent from its official upstream, using the agent's own installer or image. Where the agent has its own update path, as Hermes does, that is the path you use, and you choose when to update.",
        "This page says only what Hivra supports today. Each agent's own page has more.",
      ],
    },
    {
      heading: "Hermes",
      paragraphs: [
        "Update Hermes in either of two ways:",
        "- Open the agent's **Terminal** and run `hermes update`.\n- Open the agent's **Manage** tab and press the **Update** button, which runs Hermes's own update.",
        "Manage also shows the installed version.",
      ],
    },
    {
      heading: "Claude Code and Codex",
      paragraphs: [
        "Claude Code and Codex run as the vendors' own command line tools. Hivra's runtime update refreshes the computer's connection service and also schedules a move to the CLI version Hivra has tested.",
      ],
    },
    {
      heading: "OpenClaw, Agent Zero and Aeon",
      paragraphs: [
        "For these, Hivra's runtime update moves the app to the version Hivra has tested. Their own web apps are the place to configure them.",
      ],
    },
    {
      heading: "Before you update",
      paragraphs: [
        "Your files and logins live on the agent's computer, so an update changes the agent, not your work. Hivra does not guarantee backups, so keep copies of anything you cannot lose before a major update.",
        "On a server you connected, you also keep the host itself current.",
      ],
    },
  ],
  articles: ["openclaw-broken-after-update"],
  next: ["open-an-agent", "security-and-access", "connect-your-own-server"],
};
