import {
  extractContractsFromSource,
  extractVersionFromPyproject,
  renderHermesAuditMarkdown,
  scanApiSurface,
} from "../hermes-upstream-audit";

describe("hermes-upstream-audit helpers", () => {
  it("extracts the project version from pyproject.toml", () => {
    const pyproject = `
[project]
name = "hermes-agent"
version = "0.10.3"
description = "Test"
`;

    expect(extractVersionFromPyproject(pyproject)).toBe("0.10.3");
  });

  it("returns null when the pyproject version is missing", () => {
    expect(extractVersionFromPyproject("[project]\nname = 'hermes-agent'\n")).toBeNull();
  });

  it("detects the relevant upstream API surface markers", () => {
    const source = `
router.add_api_route("/api/skills", handler)
router.add_api_route("/api/skills/categories", handler)
router.add_api_route("/api/config", handler)
router.add_api_route("/health/detailed", handler)
router.add_api_route("/v1/runs", handler)
window.__HERMES_SESSION_TOKEN__ = "token";
`;

    expect(scanApiSurface(source)).toEqual({
      hasGatewaySkills: true,
      hasGatewaySkillCategories: true,
      hasGatewayConfig: true,
      hasProviderOAuth: false,
      hasRuns: true,
      hasHealthDetailed: true,
      hasSessionTokenInjection: true,
    });
  });

  it("extracts web-api dashboard contract usage from a route source file", () => {
    const source = `
import { agentWebApi } from "@/lib/agent-web-api";

async function run(api) {
      await api.get("/api/config");
      await api.get("/api/config/schema");
      await api.put("/api/config", { config: {} });
      await api.get("/api/skills");
      await api.get("/api/providers/oauth");
      await fetch("http://example.com/v1/models");
}
`;

    expect(extractContractsFromSource("src/app/api/example/route.ts", source)).toEqual([
      {
        endpoint: "/api/config",
        family: "config",
        path: "src/app/api/example/route.ts",
        viaAgentWebApi: true,
      },
      {
        endpoint: "/api/config/schema",
        family: "config",
        path: "src/app/api/example/route.ts",
        viaAgentWebApi: true,
      },
      {
        endpoint: "/api/skills",
        family: "skills",
        path: "src/app/api/example/route.ts",
        viaAgentWebApi: true,
      },
      {
        endpoint: "/api/providers/oauth",
        family: "oauth",
        path: "src/app/api/example/route.ts",
        viaAgentWebApi: true,
      },
      {
        endpoint: "/v1/models",
        family: "openai",
        path: "src/app/api/example/route.ts",
        viaAgentWebApi: false,
      },
    ]);
  });

  it("renders a markdown audit report with the key sections", () => {
    const markdown = renderHermesAuditMarkdown({
      generatedAt: "2026-04-18T12:00:00.000Z",
      upstream: {
        repo: "NousResearch/hermes-agent",
        ref: "abc123",
        version: "0.10.3",
      },
      fork: {
        repo: "ashneil12/vanilla-hermes-agent",
        ref: "def456",
        version: "0.9.0",
      },
      upstreamGateway: {
        hasGatewaySkills: false,
        hasGatewaySkillCategories: false,
        hasGatewayConfig: false,
        hasProviderOAuth: false,
        hasRuns: true,
        hasHealthDetailed: true,
        hasSessionTokenInjection: false,
      },
      upstreamWeb: {
        hasGatewaySkills: true,
        hasGatewaySkillCategories: false,
        hasGatewayConfig: true,
        hasProviderOAuth: true,
        hasRuns: false,
        hasHealthDetailed: false,
        hasSessionTokenInjection: true,
      },
      forkGateway: {
        hasGatewaySkills: true,
        hasGatewaySkillCategories: true,
        hasGatewayConfig: true,
        hasProviderOAuth: true,
        hasRuns: false,
        hasHealthDetailed: false,
        hasSessionTokenInjection: false,
      },
      dashboardContracts: [
        {
          endpoint: "/api/config",
          family: "config",
          path: "dashboard/src/app/api/instances/[id]/agent-config/route.ts",
          viaAgentWebApi: true,
        },
      ],
      narrative: {
        releaseHighlights: ["Nous Tool Gateway — paid Nous Portal users can use managed tools."],
        whatMatters: ["Tool Gateway is now a first-class per-tool subscription feature."],
        interestingChanges: ["Browser remains multi-provider even with gateway support."],
        communityAngles: ["No separate API keys needed for paid Portal users."],
        currentSupport: ["Hermes Deploy already supports Nous as an inference endpoint."],
        missingSupport: ["Hermes Deploy does not expose `use_gateway` toggles yet."],
        productOpportunities: ["Unify skills, plugins, and slash commands into one command surface."],
        implementationPlan: ["Build a live command registry before changing the chat palette."],
        decisionsNeeded: ["Keep plugins inside the Skills area as a capability type."],
        exposeNow: ["Add per-tool 'Use Nous Subscription' toggles."],
        exposeLater: ["Add advanced Browserbase and Firecrawl knobs later."],
        keepAdvanced: ["Keep low-level gateway override fields out of the basic UI."],
        rolloutNotes: ["Do not conflate Nous inference with Tool Gateway routing."],
      },
      risks: {
        high: ["Do not reintroduce fork-only gateway /api/config usage."],
        medium: ["Web dashboard auth still depends on session token injection."],
        low: ["Upstream additive /v1/runs endpoint is currently unused locally."],
      },
    });

    expect(markdown).toContain("# Hermes Upstream Audit");
    expect(markdown).toContain("NousResearch/hermes-agent");
    expect(markdown).toContain("ashneil12/vanilla-hermes-agent");
    expect(markdown).toContain("Release Highlights");
    expect(markdown).toContain("What Matters");
    expect(markdown).toContain("Interesting Changes");
    expect(markdown).toContain("Current Hermes Deploy Support");
    expect(markdown).toContain("Product Opportunity Deep Dive");
    expect(markdown).toContain("Implementation Plan");
    expect(markdown).toContain("Recommended Decisions");
    expect(markdown).toContain("Expose Now");
    expect(markdown).toContain("/api/config");
    expect(markdown).toContain("High risk");
    expect(markdown).toContain("Medium risk");
    expect(markdown).toContain("Low risk");
  });
});
