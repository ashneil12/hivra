import type { AgentId } from "./agent-catalog";

export type FirstRunAgent = {
  id: AgentId;
  job: string;
  name: string;
  description: string;
  hosting?: string;
};

export const FIRST_RUN_AGENTS: readonly FirstRunAgent[] = [
  {
    id: "hermes",
    job: "Research and automation",
    name: "Hermes Agent",
    description: "Research, browse, write, use tools and automate recurring work.",
    hosting: "Runs on Hivra Cloud only.",
  },
  {
    id: "claude-code",
    job: "Build and code with Claude",
    name: "Claude Code",
    description: "Build software, fix bugs, run tests and work on coding projects.",
  },
  {
    id: "codex",
    job: "Build and code with Codex",
    name: "OpenAI Codex",
    description: "Write, review and test code in a dedicated computer environment.",
  },
];
