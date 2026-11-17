import type { ComparePage } from "./types";
import { page as vsClaudeCodeOnTheWeb } from "./products/vs-claude-code-on-the-web";
import { page as vsOpenaiCodexCloud } from "./products/vs-openai-codex-cloud";
import { page as vsCursorCloudAgents } from "./products/vs-cursor-cloud-agents";
import { page as vsGithubCodespaces } from "./products/vs-github-codespaces";
import { page as vsFlySprites } from "./products/vs-fly-sprites";
import { page as vsE2b } from "./products/vs-e2b";

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
};

export const PRODUCT_COMPARISON_SLUGS = Object.keys(PRODUCT_COMPARISONS);
