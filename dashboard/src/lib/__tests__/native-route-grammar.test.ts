import { readFileSync } from "node:fs";
import path from "node:path";

import { parseDashboardResources } from "@/components/layout/dashboard-resources";
import { buildInfrastructureSetupHref, buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { getInstanceSurfaceHref } from "@/lib/instance-surface-preference";
import { LAUNCH_PROFILE_IDS, PROFILE_DETAILS, type LaunchDraft, type LaunchProfileId } from "@/lib/launch/contracts";
import { createLaunchDraft } from "@/lib/launch/draft-store";
import { launchResultHref } from "@/lib/launch/launch-adapter";
import { launchReturnPath } from "@/lib/launch/launch-plan";
import { PLAN_ORDER } from "@/lib/subscription/plans";
import { buildPostDeployDestination } from "@/lib/welcome-deploy";
import { NATIVE_LAUNCH_PROFILES, NATIVE_ROUTE_GRAMMAR_VERSION, NATIVE_UPGRADE_PLANS } from "../native-route-grammar";
import { nativeDashboardHref } from "../native-workspace";

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => "fp-request-1" }));

// The same files the Mac app's HivraNativeContractTests read.
const CONTRACT = path.resolve(__dirname, "../../../../apps/shared/native-contract");
const load = <T,>(name: string): T => JSON.parse(readFileSync(path.join(CONTRACT, name), "utf8")) as T;

type RouteCase = { family: string; input: string; expect: string | null };
const grammar = load<{ contract: string; version: number; cases: RouteCase[] }>("route-grammar.v1.json");

describe("shared native route grammar", () => {
  it("is the version this dashboard implements", () => {
    expect(grammar.contract).toBe("hivra.native-workspace.route-grammar");
    expect(grammar.version).toBe(NATIVE_ROUTE_GRAMMAR_VERSION);
    expect(grammar.cases.length).toBeGreaterThan(100);
  });

  it.each(grammar.cases.map((testCase) => [testCase.family, JSON.stringify(testCase.input), testCase] as const))(
    "%s %s",
    (_family, _input, testCase) => {
      expect(nativeDashboardHref(testCase.input)).toBe(testCase.expect);
      // Canonical routes are fixed points, so either side may normalize again.
      if (testCase.expect) expect(nativeDashboardHref(testCase.expect)).toBe(testCase.expect);
    },
  );

  it("rejects anything but a string", () => {
    for (const value of [undefined, null, 1, {}, ["/dashboard"]]) expect(nativeDashboardHref(value)).toBeNull();
  });

  it("bounds a route at 2,048 characters", () => {
    const longest = `/dashboard/${"x".repeat(2037)}`;
    expect(nativeDashboardHref(longest)).toBe(longest);
    expect(nativeDashboardHref(`${longest}x`)).toBeNull();
  });
});

describe("the routes the dashboard itself hands a native shell", () => {
  const AGENT_ID = "33333333-3333-4333-8333-333333333333";
  const TARGET_ID = "22222222-2222-4222-8222-222222222222";
  const accepted = (href: string) => {
    const canonical = nativeDashboardHref(href);
    expect({ href, canonical: canonical?.split("?")[0] }).toEqual({ href, canonical: href.split(/[?#]/)[0] });
  };

  function draftFor(profileId: LaunchProfileId, mode: "native" | "credits"): LaunchDraft {
    const base = createLaunchDraft();
    return { ...base, stage: "launch", resourceKind: PROFILE_DETAILS[profileId].resourceKind, profileId,
      modelAccess: { ...base.modelAccess, mode } };
  }

  it.each(LAUNCH_PROFILE_IDS.flatMap((profileId) => (["native", "credits"] as const).map((mode) => [profileId, mode] as const)))(
    "adopts the %s (%s) launch result as its resource",
    (profileId, mode) => accepted(launchResultHref(draftFor(profileId, mode), AGENT_ID)),
  );

  it("adopts every Hermes post-deploy destination", () => {
    for (const welcome of [true, false]) {
      accepted(buildPostDeployDestination({ instanceId: AGENT_ID, welcome, webUseGateway: false, imageGenUseGateway: false,
        ttsUseGateway: false, browserUseGateway: false }));
      accepted(buildPostDeployDestination({ instanceId: AGENT_ID, welcome, providerId: "nous", webUseGateway: true,
        imageGenUseGateway: false, ttsUseGateway: false, browserUseGateway: false }));
    }
    accepted(getInstanceSurfaceHref(AGENT_ID, "chat", { forceSurface: true }));
    accepted(getInstanceSurfaceHref(AGENT_ID, "tui"));
  });

  it("recognizes every launch link and capacity handoff", () => {
    accepted(buildLaunchHref());
    for (const kind of ["agent", "computer"] as const) accepted(buildLaunchHref({ kind, start: true }));
    for (const profile of LAUNCH_PROFILE_IDS) {
      accepted(buildLaunchHref({ profile, start: true, targetIds: [TARGET_ID] }));
    }
    accepted(buildLaunchHref({ profile: "claude-code", template: "tpl_research-01", templateToken: "Share-Token_9" }));
    accepted(launchReturnPath(AGENT_ID));
    for (const resource of ["claude-code", "codex", "aeon", "openclaw", "agent-zero", "linux-desktop", "linux-terminal", "windows"] as const) {
      for (const unified of [true, false]) accepted(buildInfrastructureSetupHref(resource, { unified }));
    }
  });

  it("accepts every resource href in the native inventory", () => {
    const rows = [
      { id: "claude", type: "claude-code", name: "Claude", status: "running" },
      { id: "ubuntu", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "Ubuntu", status: "running" },
      { id: "windows", type: "linux-desktop", computer_profile: "windows", name: "Windows", status: "stopped" },
    ];
    for (const resource of [
      ...parseDashboardResources({ success: true, data: { agents: rows } }, "hivra"),
      ...parseDashboardResources({ success: true, data: [{ id: "hermes", name: "Hermes", status: "running" }] }, "hermes"),
    ]) expect(nativeDashboardHref(resource.href)).toBe(resource.href);
  });
});

describe("value sets the grammar mirrors", () => {
  it("names every launch profile and paid upgrade", () => {
    expect([...NATIVE_LAUNCH_PROFILES].sort()).toEqual([...LAUNCH_PROFILE_IDS].sort());
    expect([...NATIVE_UPGRADE_PLANS]).toEqual(PLAN_ORDER.filter((plan) => plan !== "free"));
  });
});
