import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "security-and-access",
  section: "run",
  title: "Security and access",
  metaTitle: "Security and access: who can reach your agent",
  metaDescription: "Agent interfaces sit behind Hivra's authenticated gateway. Credentials can live on the agent's computer, and who has host access depends on where it runs.",
  summary: "Who can reach your agent, what stays on its computer, and who can reach the host.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "Reaching your agent",
      paragraphs: [
        "An agent's interface is reached through Hivra's authenticated gateway, so you sign in to Hivra to open it. For OpenClaw and Agent Zero the app listens on the computer's localhost only, and the gateway is how you get to it. The Terminal, Files and desktop views also go through the same sign-in.",
      ],
    },
    {
      heading: "What is on the computer",
      paragraphs: [
        "Each agent runs on a computer of its own. Credentials may be stored on that computer: a key you sent it, or a login you made inside the agent, for example. Treat the computer as a place that holds secrets, and give an agent only the access you are comfortable with.",
        "A Claude Code or Codex agent can sign in with your own account inside the agent. That sign-in is between you and the provider.",
      ],
    },
    {
      heading: "On Hivra Cloud",
      paragraphs: [
        "Hivra administrators retain infrastructure access on Hivra-managed hosts. That means the machine your agent's computer runs on, not your account sign-in.",
      ],
    },
    {
      heading: "On a server you connected",
      paragraphs: [
        "Whoever controls the connected host can access its infrastructure. Hivra does not become the host operator.",
        "If you connect Ubuntu with the one-command setup, it creates a user named hivra that signs in only with Hivra's key and can use sudo, so Hivra gets administrator access to that server. Connecting with SSH details uses the key you provide. See [Run agents on your own server](/docs/connect-your-own-server).",
        "Linux Sandbox uses gVisor, which gives an application-kernel boundary. Your server operator still controls the host kernel.",
      ],
    },
    {
      heading: "More",
      paragraphs: [
        "The [security page](/security) has the wider picture. For how an agent's model access and keys are handled, see [how your agent gets its model](/docs/models-and-credits).",
      ],
    },
  ],
  articles: ["is-it-safe-to-leave-an-ai-agent-running-unattended"],
  next: ["connect-your-own-server", "open-an-agent", "update-an-agent"],
};
