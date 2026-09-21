export interface HermesWebSkill {
  name: string;
  description?: string;
  category?: string | null;
  enabled?: boolean;
  /**
   * Where the skill originated on the agent VM. Reported by the agent's
   * `/api/skills` endpoint when its `_find_all_skills` cross-references the
   * bundled manifest at `~/.hermes/skills/.bundled_manifest`. Older agents
   * predating that field will omit it; consumers must tolerate `undefined`.
   */
  source?: 'bundled' | 'custom';
  [key: string]: unknown;
}

export interface HermesWebToolset {
  name: string;
  label: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  available?: boolean;
  tools?: string[];
  [key: string]: unknown;
}

export interface HermesWebDashboardPlugin {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  version?: string;
  source?: string;
  slots?: string[];
  has_api?: boolean;
  tab?: {
    path?: string;
    position?: string;
    override?: string;
    hidden?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HermesWebSkillCategory {
  name: string;
  skill_count: number;
}

export interface HermesWebConfigUpdate {
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
}

const SESSION_TOKEN_PATTERN =
  /window\.__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']+)["']/;

export function extractHermesSessionToken(html: string): string | null {
  const match = html.match(SESSION_TOKEN_PATTERN);
  return match?.[1]?.trim() || null;
}

export function buildSkillCategories(
  skills: HermesWebSkill[],
): HermesWebSkillCategory[] {
  const counts = new Map<string, number>();

  for (const skill of skills) {
    const category =
      typeof skill.category === "string" ? skill.category.trim() : "";
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, skill_count]) => ({ name, skill_count }));
}

export function findSkillByName<T extends { name: string }>(
  skills: T[],
  name: string,
): T | null {
  return skills.find((skill) => skill.name === name) ?? null;
}

export function buildHermesWebConfigPayload(
  currentConfig: Record<string, unknown>,
  update: HermesWebConfigUpdate,
): Record<string, unknown> {
  const nextConfig = { ...currentConfig };
  const currentContextLength =
    typeof nextConfig.model_context_length === "number"
      ? nextConfig.model_context_length
      : 0;

  delete nextConfig.model_context_length;

  const nextModel: Record<string, unknown> = {};
  const model = typeof update.model === "string" ? update.model.trim() : "";
  const provider =
    typeof update.provider === "string" ? update.provider.trim() : "";
  const baseUrl =
    typeof update.baseUrl === "string" ? update.baseUrl.trim() : "";

  if (model) {
    nextModel.default = model;
  }
  if (provider) {
    nextModel.provider = provider;
  }
  if (provider && baseUrl) {
    nextModel.base_url = baseUrl;
  }
  if (currentContextLength > 0) {
    nextModel.context_length = currentContextLength;
  }

  nextConfig.model = Object.keys(nextModel).length > 0 ? nextModel : "";
  return nextConfig;
}
