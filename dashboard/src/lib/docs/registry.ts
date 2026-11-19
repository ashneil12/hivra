import type { DocPage, DocSection } from "./types";
import { DOC_SECTIONS } from "./sections";
import { doc as gettingStarted } from "./pages/getting-started";
import { doc as connectYourOwnServer } from "./pages/connect-your-own-server";
import { doc as plansAndBilling } from "./pages/plans-and-billing";
import { doc as modelsAndCredits } from "./pages/models-and-credits";
import { doc as hermes } from "./pages/hermes";
import { doc as claudeCode } from "./pages/claude-code";
import { doc as codex } from "./pages/codex";
import { doc as openclaw } from "./pages/openclaw";
import { doc as agentZero } from "./pages/agent-zero";
import { doc as aeon } from "./pages/aeon";
import { doc as deepseekHarness } from "./pages/deepseek-harness";
import { doc as openbot } from "./pages/openbot";
import { doc as nuphos } from "./pages/nuphos";
import { doc as ubuntuDesktop } from "./pages/ubuntu-desktop";
import { doc as linuxComputer } from "./pages/linux-computer";
import { doc as linuxSandbox } from "./pages/linux-sandbox";
import { doc as omarchy } from "./pages/omarchy";
import { doc as windows } from "./pages/windows";
import { doc as openAnAgent } from "./pages/open-an-agent";
import { doc as updateAnAgent } from "./pages/update-an-agent";
import { doc as securityAndAccess } from "./pages/security-and-access";
import { doc as dashboardTour } from "./pages/dashboard-tour";
import { doc as glossary } from "./pages/glossary";
import { doc as telegram } from "./pages/telegram";
import { doc as troubleshooting } from "./pages/troubleshooting";
import { forFreePlanState } from "@/lib/copy/free-plan-copy";

const ALL: DocPage[] = [
  gettingStarted,
  connectYourOwnServer,
  plansAndBilling,
  modelsAndCredits,
  hermes,
  claudeCode,
  codex,
  openclaw,
  agentZero,
  aeon,
  deepseekHarness,
  openbot,
  nuphos,
  ubuntuDesktop,
  linuxComputer,
  linuxSandbox,
  omarchy,
  windows,
  openAnAgent,
  updateAnAgent,
  securityAndAccess,
  dashboardTour,
  glossary,
  telegram,
  troubleshooting,
];

export const DOCS: Record<string, DocPage> = Object.fromEntries(ALL.map((doc) => [doc.slug, forFreePlanState(doc)]));

export { DOC_SECTIONS };

export function getDoc(slug: string): DocPage | undefined {
  return DOCS[slug];
}

export function sectionForDoc(slug: string): DocSection | undefined {
  return DOC_SECTIONS.find((section) => section.docs.includes(slug));
}

/** Docs in hub order, so a page can link to the one before and after it. */
export const DOCS_IN_ORDER: DocPage[] = DOC_SECTIONS.flatMap((section) => section.docs.map((slug) => DOCS[slug]).filter(Boolean));

export const DOC_STATUS_LABEL = {
  available: "Available",
  alpha: "Available (alpha)",
  preview: "Preview, not in Launch yet",
  condition: "Available, with a condition",
} as const;

/** Newest review date across the docs: what changed on the hub. */
export function docsLastModified(): string {
  return ALL.reduce((newest, doc) => (doc.lastReviewed > newest ? doc.lastReviewed : newest), "2026-11-17");
}
