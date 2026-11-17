import type { DocSection } from "./types";

// The hub's order: start, then models, then each agent, then computers, then running one day to day.
export const DOC_SECTIONS: readonly DocSection[] = [
  {
    id: "start",
    title: "Get started",
    blurb: "Make an account, launch your first agent and decide where it runs.",
    docs: ["getting-started", "dashboard-tour", "connect-your-own-server", "plans-and-billing", "glossary"],
  },
  {
    id: "models",
    title: "Models",
    blurb: "How an agent reaches its AI model: Hivra credits, your own key, or your own account.",
    docs: ["models-and-credits"],
  },
  {
    id: "agents",
    title: "Agents",
    blurb: "One page per agent: what it is, how you open it, how it gets its model and how you update it.",
    docs: ["hermes", "claude-code", "codex", "openclaw", "agent-zero", "aeon", "deepseek-harness", "openbot", "nuphos"],
  },
  {
    id: "computers",
    title: "Computers",
    blurb: "Computers you can launch without an agent, for yourself or for an agent to use.",
    docs: ["ubuntu-desktop", "linux-computer", "linux-sandbox", "omarchy", "windows"],
  },
  {
    id: "run",
    title: "Run and update",
    blurb: "Day to day: opening an agent, keeping it current and who can reach it.",
    docs: ["open-an-agent", "telegram", "update-an-agent", "security-and-access", "troubleshooting"],
  },
];
