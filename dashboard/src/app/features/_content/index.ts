import type { FeaturePageContent } from "./types";
import { BROWSER_AUTOMATION } from "./browser-automation";
import { MULTI_AGENT } from "./multi-agent";
import { NO_DOCKER_HOSTING } from "./no-docker-hosting";
import { OPENCLAW_ALTERNATIVE } from "./openclaw-alternative";
import { PERSISTENT_MEMORY } from "./persistent-memory";
import { SCHEDULED_TASKS } from "./scheduled-tasks";

export type { FeatureBlock, FeatureFaqItem, FeaturePageContent, FeatureSection } from "./types";

/** The six feature pages, in the order the directory lists them. */
export const FEATURE_PAGES: readonly FeaturePageContent[] = [
  PERSISTENT_MEMORY,
  BROWSER_AUTOMATION,
  MULTI_AGENT,
  NO_DOCKER_HOSTING,
  OPENCLAW_ALTERNATIVE,
  SCHEDULED_TASKS,
];

export function featurePageContent(slug: string): FeaturePageContent | undefined {
  return FEATURE_PAGES.find((page) => page.slug === slug);
}
