// Welcome agent catalog — first-run choices shown after plan activation.
//
// Pure data/logic so signup, checkout recovery, landing links, and the welcome
// flow can preserve the same agent intent without importing React components.

export const WELCOME_AGENT_TYPE_STORAGE_KEY = "hermes:welcome_agent_type";

export type WelcomeAgentTypeKey = "general" | "claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero";
type WelcomeAgentIconKey = "bot" | "code" | "terminal" | "infinity" | "messages" | "orbit";

interface WelcomeAgentDeployCard {
  eyebrow: string;
  title: string;
  summary: string;
  included: [string, string, string];
  starterTasks: [string, string, string];
  guardrails: [string, string, string];
  ctaLabel: string;
}

export interface WelcomeAgentTypeDefinition {
  key: WelcomeAgentTypeKey;
  name: string;
  eyebrow: string;
  tagline: string;
  description: string;
  defaultName: string;
  recommendedTier: "Free" | "Pro" | "Power";
  features: [string, string, string];
  icon: WelcomeAgentIconKey;
  defaultProviderId?: string;
  systemPrompt?: string;
  deployCard: WelcomeAgentDeployCard;
}

export const WELCOME_AGENT_TYPES: WelcomeAgentTypeDefinition[] = [
  {
    key: "general",
    name: "Hermes Agent",
    eyebrow: "General operator",
    tagline: "A clean HermesOS agent you shape yourself.",
    description:
      "Start with the standard cloud agent: provider setup, persistent memory, browser/tools, scheduling, and root-enabled build room inside its VM.",
    defaultName: "MY_FIRST_AGENT",
    recommendedTier: "Free",
    features: ["Bring any supported model", "Add skills and integrations later", "Best first deploy for builders"],
    icon: "bot",
    deployCard: {
      eyebrow: "General-purpose deploy card",
      title: "Launch a blank Hermes Agent.",
      summary:
        "This is the flexible starter. Pick the model provider, name the agent, and Hivra provisions the managed HermesOS workspace without forcing a niche template.",
      included: ["Persistent HermesOS workspace", "Browser, terminal, files, skills, and cron", "Provider and memory settings editable after launch"],
      starterTasks: ["Research a topic and return a sourced brief", "Automate a recurring workflow", "Build or debug inside the agent workspace"],
      guardrails: ["You stay in control of provider keys", "Destructive actions still require approval", "No specialist assumptions are baked in"],
      ctaLabel: "Deploy Hermes Agent",
    },
  },
  {
    key: "claude-code",
    name: "Claude Code",
    eyebrow: "Coding agent",
    tagline: "A first-launch coding workspace backed by your Anthropic sign-in.",
    description:
      "Start with the official Claude Code path: Hivra provisions the agent workspace, then the box asks you to sign in with your own Anthropic account.",
    defaultName: "CLAUDE_CODE_AGENT",
    recommendedTier: "Pro",
    features: ["Anthropic sign-in after launch", "Official Claude Code CLI", "Best first deploy for coding work"],
    icon: "code",
    defaultProviderId: "anthropic",
    deployCard: {
      eyebrow: "Claude Code deploy card",
      title: "Launch Claude Code.",
      summary:
        "This card uses the command-center Claude Code deployment path. Name the box, choose resources, and sign in with Anthropic after the agent opens.",
      included: ["Official Claude Code CLI", "Anthropic sign-in happens inside the box", "Terminal, files, skills, and optional browser"],
      starterTasks: ["Open a repository and inspect the codebase", "Implement a focused change with tests", "Debug a failing command from inside the workspace"],
      guardrails: ["You use your own Anthropic account", "Managed-host administrators retain infrastructure access", "Runs unmodified from the upstream CLI"],
      ctaLabel: "Deploy Claude Code",
    },
  },
  {
    key: "codex",
    name: "Codex",
    eyebrow: "Coding agent",
    tagline: "A coding workspace using your ChatGPT account or OpenAI API key.",
    description:
      "Launch the official OpenAI Codex CLI, then sign in with ChatGPT or provide your own OpenAI API key inside Codex.",
    defaultName: "CODEX_AGENT",
    recommendedTier: "Free",
    features: ["ChatGPT or API key after launch", "Official OpenAI Codex CLI", "Optional live self-hosted browser"],
    icon: "terminal",
    deployCard: {
      eyebrow: "Codex deploy card",
      title: "Launch Codex.",
      summary:
        "Name the box and choose resources. When Codex opens, sign in with ChatGPT or provide your own OpenAI API key.",
      included: ["Official OpenAI Codex CLI", "Account or API-key setup inside Codex", "Terminal, files, skills, and optional browser"],
      starterTasks: ["Open a repository and inspect the codebase", "Implement a focused change with tests", "Debug a failing command from inside the workspace"],
      guardrails: ["Use your own ChatGPT account or OpenAI API key", "Managed-host administrators retain infrastructure access", "Runs unmodified from the upstream CLI"],
      ctaLabel: "Deploy Codex",
    },
  },
  {
    key: "aeon",
    name: "Aeon",
    eyebrow: "Autonomous framework",
    tagline: "Set-and-forget autonomous agent that runs on your own GitHub.",
    description:
      "Aeon runs recurring tasks — monitoring, code review, research digests, security scans — unattended on your own GitHub Actions. Hivra hosts its dashboard; you connect with a GitHub token after launch.",
    defaultName: "AEON_AGENT",
    recommendedTier: "Free",
    features: ["Runs on your own GitHub Actions", "Near-zero compute — never touches your pool", "Connect with a GitHub token after launch"],
    icon: "infinity",
    deployCard: {
      eyebrow: "Aeon deploy card",
      title: "Launch Aeon.",
      summary:
        "This hosts the Aeon dashboard on a tiny managed box. Name it and launch — then connect your GitHub and configure skills inside Aeon's own dashboard.",
      included: ["Hosted Aeon dashboard", "GitHub sign-in happens inside the box", "Tasks run on your GitHub Actions, not the box"],
      starterTasks: ["Schedule a daily research digest", "Auto-review pull requests on your repos", "Run recurring security or market scans"],
      guardrails: ["You use your own GitHub account", "Managed-host administrators retain infrastructure access", "Runs the Aeon project unmodified"],
      ctaLabel: "Deploy Aeon",
    },
  },
  {
    key: "openclaw",
    name: "OpenClaw",
    eyebrow: "Always-on agent",
    tagline: "A personal agent you message like a contact — it runs unattended.",
    description:
      "OpenClaw runs a persistent agent on your box, wired to your messaging apps with a heartbeat scheduler. Hivra hosts its Control UI; you set your model and channels inside it after launch.",
    defaultName: "OPENCLAW_AGENT",
    recommendedTier: "Pro",
    features: ["Reach it from Telegram, WhatsApp, Signal & more", "Heartbeat scheduler runs routines unattended", "Set your model and channels in its Control UI"],
    icon: "messages",
    deployCard: {
      eyebrow: "OpenClaw deploy card",
      title: "Launch OpenClaw.",
      summary:
        "This hosts the OpenClaw Control UI on a managed box. Name it and launch — then connect your model provider and messaging channels inside OpenClaw's own dashboard.",
      included: ["Hosted OpenClaw Control UI", "Persistent agent daemon + heartbeat scheduler", "Model and channel setup inside the dashboard"],
      starterTasks: ["Wire it to Telegram or WhatsApp and chat from your phone", "Set a heartbeat to run a daily routine", "Add skills from the OpenClaw skill registry"],
      guardrails: ["You configure your own model credentials", "Managed-host administrators retain infrastructure access", "Runs the OpenClaw project unmodified"],
      ctaLabel: "Deploy OpenClaw",
    },
  },
  {
    key: "agent-zero",
    name: "Agent Zero",
    eyebrow: "Autonomous agent",
    tagline: "Give it a goal and it plans, browses, codes, and runs — from its own dashboard.",
    description:
      "Agent Zero is a general-purpose autonomous agent with its own web dashboard, browser, and computer. Hivra hosts it on an isolated computer. Choose model access during setup or configure your own provider in Agent Zero's Settings before giving it tasks.",
    defaultName: "AGENT_ZERO",
    recommendedTier: "Pro",
    features: ["Its own dashboard, browser and computer", "Plans and runs multi-step tasks autonomously", "Model provider configuration in Settings"],
    icon: "orbit",
    deployCard: {
      eyebrow: "Agent Zero deploy card",
      title: "Launch Agent Zero.",
      summary:
        "Name the computer and launch, then open Agent Zero's own dashboard. Model access must be configured before you can run a task; you can use your own provider in Settings.",
      included: ["Hosted Agent Zero dashboard", "Its own browser and computer sandbox", "Model provider configuration in Settings"],
      starterTasks: ["Ask it to research a topic and write up the findings", "Have it build and run a small script end to end", "Give it a multi-step task and watch it work"],
      guardrails: ["Runs the Agent Zero project unmodified", "Its web UI is locked behind our authenticated gateway", "Swap in your own model credentials any time"],
      ctaLabel: "Deploy Agent Zero",
    },
  },
];

export const DEFAULT_WELCOME_AGENT_TYPE_KEY: WelcomeAgentTypeKey = "general";

export function resolveWelcomeAgentTypeKey(value: string | null | undefined): WelcomeAgentTypeKey | null {
  if (!value) return null;
  return WELCOME_AGENT_TYPES.some((agentType) => agentType.key === value)
    ? (value as WelcomeAgentTypeKey)
    : null;
}

export function getWelcomeAgentTypeDefinition(
  key: WelcomeAgentTypeKey | null | undefined,
): WelcomeAgentTypeDefinition | null {
  if (!key) return null;
  return WELCOME_AGENT_TYPES.find((agentType) => agentType.key === key) ?? null;
}

export function buildAgentTypeQuery(agentTypeKey: WelcomeAgentTypeKey | null | undefined): string {
  return agentTypeKey ? `&agentType=${encodeURIComponent(agentTypeKey)}` : "";
}
