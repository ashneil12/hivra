import type { ComparePage } from "./types";
import { page as vsClaudeCodeOnTheWeb } from "./products/vs-claude-code-on-the-web";
import { page as vsOpenaiCodexCloud } from "./products/vs-openai-codex-cloud";
import { page as vsCursorCloudAgents } from "./products/vs-cursor-cloud-agents";
import { page as vsGithubCodespaces } from "./products/vs-github-codespaces";
import { page as vsFlySprites } from "./products/vs-fly-sprites";
import { page as vsE2b } from "./products/vs-e2b";
import { page as vsLobsterland } from "./products/vs-lobsterland";
import { page as vsConstructComputer } from "./products/vs-construct-computer";
import { page as vsOrgo } from "./products/vs-orgo";
import { page as vsMachine0 } from "./products/vs-machine0";
import { page as vsKiloclaw } from "./products/vs-kiloclaw";
import { page as vsSimularBox } from "./products/vs-simular-box";
import { page as vsCubicles } from "./products/vs-cubicles";

/**
 * Comparison pages against other agent products and sandbox platforms (not hosts of the same agents). Each page
 * lives in lib/compare/products/<slug>.ts with its own sources and the day its figures were collected
 * (products/checked.ts).
 */
export const PRODUCT_COMPARISONS: Record<string, ComparePage> = {
  "vs-claude-code-on-the-web": vsClaudeCodeOnTheWeb,
  "vs-openai-codex-cloud": vsOpenaiCodexCloud,
  "vs-cursor-cloud-agents": vsCursorCloudAgents,
  "vs-github-codespaces": vsGithubCodespaces,
  "vs-fly-sprites": vsFlySprites,
  "vs-e2b": vsE2b,
  "vs-lobsterland": vsLobsterland,
  "vs-construct-computer": vsConstructComputer,
  "vs-orgo": vsOrgo,
  "vs-machine0": vsMachine0,
  "vs-kiloclaw": vsKiloclaw,
  "vs-simular-box": vsSimularBox,
  "vs-cubicles": vsCubicles,
};

export const PRODUCT_COMPARISON_SLUGS = Object.keys(PRODUCT_COMPARISONS);
