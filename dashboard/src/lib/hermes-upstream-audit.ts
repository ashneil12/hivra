export interface HermesApiSurface {
  hasGatewaySkills: boolean;
  hasGatewaySkillCategories: boolean;
  hasGatewayConfig: boolean;
  hasProviderOAuth: boolean;
  hasRuns: boolean;
  hasHealthDetailed: boolean;
  hasSessionTokenInjection: boolean;
}

export interface DashboardContractFinding {
  endpoint: string;
  family: "config" | "skills" | "oauth" | "openai" | "jobs";
  path: string;
  viaAgentWebApi: boolean;
}

interface HermesRepoRef {
  repo: string;
  ref: string;
  version: string | null;
}

interface HermesAuditRisks {
  high: string[];
  medium: string[];
  low: string[];
}

interface HermesAuditNarrative {
  releaseHighlights: string[];
  whatMatters: string[];
  interestingChanges: string[];
  communityAngles: string[];
  currentSupport: string[];
  missingSupport: string[];
  productOpportunities: string[];
  implementationPlan: string[];
  decisionsNeeded: string[];
  exposeNow: string[];
  exposeLater: string[];
  keepAdvanced: string[];
  rolloutNotes: string[];
}

export interface HermesAuditReport {
  generatedAt: string;
  upstream: HermesRepoRef;
  fork: HermesRepoRef;
  upstreamGateway: HermesApiSurface;
  upstreamWeb: HermesApiSurface;
  forkGateway: HermesApiSurface;
  dashboardContracts: DashboardContractFinding[];
  narrative: HermesAuditNarrative;
  risks: HermesAuditRisks;
}

const VERSION_PATTERN = /^\s*version\s*=\s*["']([^"']+)["']/m;
const ENDPOINT_PATTERN =
  /["'`][^"'`]*(\/(?:api\/config(?:\/schema|\/defaults)?|api\/skills(?:\/categories)?|api\/providers\/oauth(?:\/[^"'`]*)?|v1\/models|v1\/responses|api\/jobs))[^"'`]*["'`]/g;

export function extractVersionFromPyproject(pyprojectText: string): string | null {
  const match = pyprojectText.match(VERSION_PATTERN);
  return match?.[1] ?? null;
}

export function scanApiSurface(sourceText: string): HermesApiSurface {
  return {
    hasGatewaySkills: sourceText.includes("/api/skills"),
    hasGatewaySkillCategories: sourceText.includes("/api/skills/categories"),
    hasGatewayConfig: sourceText.includes("/api/config"),
    hasProviderOAuth: sourceText.includes("/api/providers/oauth"),
    hasRuns: sourceText.includes("/v1/runs"),
    hasHealthDetailed: sourceText.includes("/health/detailed"),
    hasSessionTokenInjection: sourceText.includes("__HERMES_SESSION_TOKEN__"),
  };
}

export function extractContractsFromSource(
  path: string,
  sourceText: string,
): DashboardContractFinding[] {
  const seen = new Set<string>();
  const viaAgentWebApi = sourceText.includes("agentWebApi");
  const findings: DashboardContractFinding[] = [];

  for (const match of sourceText.matchAll(ENDPOINT_PATTERN)) {
    const endpoint = match[1];
    if (!endpoint || seen.has(endpoint)) continue;
    seen.add(endpoint);

    let family: DashboardContractFinding["family"];
    if (endpoint.startsWith("/api/config")) {
      family = "config";
    } else if (endpoint.startsWith("/api/skills")) {
      family = "skills";
    } else if (endpoint.startsWith("/api/providers/oauth")) {
      family = "oauth";
    } else if (endpoint.startsWith("/api/jobs")) {
      family = "jobs";
    } else {
      family = "openai";
    }

    findings.push({
      endpoint,
      family,
      path,
      viaAgentWebApi: viaAgentWebApi && family !== "openai",
    });
  }

  return findings;
}

function formatSurfaceRow(label: string, surface: HermesApiSurface): string {
  const markers = [
    ["gateway /api/skills", surface.hasGatewaySkills],
    ["gateway /api/skills/categories", surface.hasGatewaySkillCategories],
    ["gateway /api/config", surface.hasGatewayConfig],
    ["gateway /api/providers/oauth", surface.hasProviderOAuth],
    ["gateway /v1/runs", surface.hasRuns],
    ["gateway /health/detailed", surface.hasHealthDetailed],
    ["web session token injection", surface.hasSessionTokenInjection],
  ]
    .map(([name, present]) => `${present ? "yes" : "no"} ${name}`)
    .join(" | ");

  return `- ${label}: ${markers}`;
}

function formatRiskBlock(title: string, items: string[]): string[] {
  const safeItems = items.length > 0 ? items : ["None noted from this audit run."];
  return [`## ${title}`, ...safeItems.map((item) => `- ${item}`)];
}

function formatNarrativeBlock(title: string, items: string[]): string[] {
  const safeItems = items.length > 0 ? items : ["None noted from this audit run."];
  return [`## ${title}`, ...safeItems.map((item) => `- ${item}`)];
}

export function renderHermesAuditMarkdown(report: HermesAuditReport): string {
  const contractLines =
    report.dashboardContracts.length > 0
      ? report.dashboardContracts.map(
          (contract) =>
            `- ${contract.path}: ${contract.endpoint} (${contract.family}, ${
              contract.viaAgentWebApi ? "via agentWebApi" : "not via agentWebApi"
            })`,
        )
      : ["- No matching dashboard contracts found."];

  return [
    "# Hermes Upstream Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Repository State",
    `- Upstream: ${report.upstream.repo} @ ${report.upstream.ref} (version ${report.upstream.version ?? "unknown"})`,
    `- Fork: ${report.fork.repo} @ ${report.fork.ref} (version ${report.fork.version ?? "unknown"})`,
    "",
    ...formatNarrativeBlock("Release Highlights", report.narrative.releaseHighlights),
    "",
    ...formatNarrativeBlock("What Matters", report.narrative.whatMatters),
    "",
    ...formatNarrativeBlock("Interesting Changes", report.narrative.interestingChanges),
    "",
    ...formatNarrativeBlock("Community / Content Angles", report.narrative.communityAngles),
    "",
    ...formatNarrativeBlock("Current Hermes Deploy Support", report.narrative.currentSupport),
    "",
    ...formatNarrativeBlock("Missing Or Partial Support", report.narrative.missingSupport),
    "",
    ...formatNarrativeBlock("Product Opportunity Deep Dive", report.narrative.productOpportunities),
    "",
    ...formatNarrativeBlock("Implementation Plan", report.narrative.implementationPlan),
    "",
    ...formatNarrativeBlock("Recommended Decisions", report.narrative.decisionsNeeded),
    "",
    ...formatNarrativeBlock("Expose Now", report.narrative.exposeNow),
    "",
    ...formatNarrativeBlock("Expose Later", report.narrative.exposeLater),
    "",
    ...formatNarrativeBlock("Keep Advanced / Hidden For Now", report.narrative.keepAdvanced),
    "",
    ...formatNarrativeBlock("Rollout Notes", report.narrative.rolloutNotes),
    "",
    "## API Surface Drift",
    formatSurfaceRow("Upstream gateway", report.upstreamGateway),
    formatSurfaceRow("Upstream web server", report.upstreamWeb),
    formatSurfaceRow("Fork gateway", report.forkGateway),
    "",
    "## Dashboard Contracts",
    ...contractLines,
    "",
    ...formatRiskBlock("High risk", report.risks.high),
    "",
    ...formatRiskBlock("Medium risk", report.risks.medium),
    "",
    ...formatRiskBlock("Low risk", report.risks.low),
    "",
  ].join("\n");
}
