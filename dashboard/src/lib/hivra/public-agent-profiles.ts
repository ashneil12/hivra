import { getAgent } from "./agent-catalog";
import { isCatalogAppLaunchable, UNIVERSAL_CATALOG_MANIFESTS } from "./catalog-manifests";
import { isNuphosAgentEnabled } from "./nuphos-flag";
import { isOpenBotAgentEnabled } from "./openbot-flag";

type AgentProfile = {
  slug: string;
  name: string;
  tag?: string;
  title: string;
  description: string;
  goodFit: string;
  setup: string[];
  guide?: string;
};

export const PUBLIC_AGENT_PROFILES_LAST_MODIFIED = "2026-11-27";
export const AGENT_DIRECTORY_SUMMARY = "Compare launchable AI agents, including Claude Code, Codex, Hermes and DeepSeek Harness.";

export const AGENT_ARTICLE_SLUGS: Readonly<Partial<Record<string, string>>> = {
  "claude-code": "claude-code-on-linux",
  codex: "how-to-install-codex-cli",
  hermes: "what-is-hermes-agent",
  openclaw: "how-to-self-host-openclaw",
  "agent-zero": "what-is-agent-zero",
  aeon: "what-is-aeon-agent",
  "deepseek-harness": "deepseek-harness-coding-agent",
  zeroclaw: "what-is-zeroclaw",
  openbot: "openbot-ai-coworkers",
  nuphos: "nuphos-claude-code-team-chat",
};

export function getPublicAgentProfiles(): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  if (getAgent("deepseek-harness")?.available) {
    profiles.push({
      slug: "deepseek-harness",
      name: "DeepSeek Harness",
      tag: "Alpha",
      title: "DeepSeek Harness Hosting on Hivra",
      description: "Run DeepSeek’s coding agent in its own interface on Hivra Cloud. Choose Hivra credits or your own Venice API key at launch.",
      goodFit: "Reviewing a repository, debugging a small change or trying DeepSeek V4.1 Flash in a dedicated coding workspace.",
      setup: [
        "Choose DeepSeek Harness in Launch. It runs on a paid Hivra Cloud plan, not on a server you connect.",
        "Choose Hivra credits or enter your own Venice API key before launch. Hivra configures DeepSeek V4.1 Flash for you.",
        "Open the agent’s own interface and start with a small coding task. This is an alpha release and it does not include a browser for the agent.",
      ],
      guide: "/docs/deepseek-harness",
    });
  }
  if (isOpenBotAgentEnabled()) {
    profiles.push({
      slug: "openbot",
      name: "OpenBot",
      title: "OpenBot Hosting on Hivra",
      description: "Run CopilotKit’s OpenBot in its own web workspace on Hivra Cloud.",
      goodFit: "Working with OpenBot in its own workspace, with files and a browser on its computer.",
      setup: [
        "Choose OpenBot in Launch on a paid Hivra Cloud plan.",
        "Open the workspace and enter your CopilotKit Intelligence key. The key is required before OpenBot starts.",
      ],
      guide: "/docs/openbot",
    });
  }
  if (isNuphosAgentEnabled()) {
    profiles.push({
      slug: "nuphos",
      name: "Nuphos",
      title: "Nuphos Hosting on Hivra",
      description: "Run Claude Code on a Hivra computer and reach it from your team’s Nuphos app.",
      goodFit: "Teams that use Nuphos and want a Claude Code workspace they can reach from the Nuphos app.",
      setup: [
        "Choose Nuphos in Launch on a paid Hivra Cloud plan.",
        "Set the console password and choose Connect to Nuphos. Use your own Nuphos account and Claude sign-in.",
      ],
      guide: "/docs/nuphos",
    });
  }
  for (const manifest of UNIVERSAL_CATALOG_MANIFESTS) {
    if (manifest.category !== "agent" || !isCatalogAppLaunchable(manifest)) continue;
    profiles.push({
      slug: manifest.id,
      name: manifest.name,
      title: `${manifest.name} Hosting on Hivra`,
      description: manifest.id === "zeroclaw"
        ? "Run ZeroClaw, a personal agent written in Rust, on a Hivra computer. Open its chat, terminal and workspace files from Hivra."
        : `Run ${manifest.name} by ${manifest.vendor} on a Hivra computer from Launch.`,
      goodFit: manifest.id === "zeroclaw"
        ? "Trying a personal assistant in Hivra chat while keeping its tools and files off your personal computer."
        : `A separate working environment for ${manifest.name} on Hivra Cloud.`,
      setup: [
        `Choose ${manifest.name} in Launch and review the computer and model options it shows.`,
        `Once it starts, open ${manifest.name} from your dashboard.`,
      ],
    });
  }
  return profiles;
}
