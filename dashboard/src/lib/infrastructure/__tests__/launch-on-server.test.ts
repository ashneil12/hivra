/** @jest-environment node */

import type { DeploymentTargetDto, GvisorDeploymentTargetDto } from "../contracts";
import { createLaunchDraft } from "@/lib/launch/draft-store";
import {
  launchOnDeploymentTarget,
  launchOnGvisorTarget,
  launchOnProviderServer,
  pendingLaunchFrom,
} from "../launch-on-server";

const TARGET_ID = "55555555-5555-4555-8555-555555555555";

function gvisorTarget(overrides: Partial<GvisorDeploymentTargetDto> = {}): DeploymentTargetDto {
  return {
    id: TARGET_ID,
    connectionId: "11111111-1111-4111-8111-111111111111",
    evidenceConnectionRevision: 1,
    externalId: `gvisor-${"b".repeat(24)}`,
    displayName: "web-1 — gVisor",
    status: "ready",
    capacity: {
      cpu: { totalCores: 4, utilizationRatio: null },
      memoryBytes: { total: 8 * 1024 ** 3, available: 6 * 1024 ** 3 },
      storageBytes: { total: 64 * 1024 ** 3, available: 48 * 1024 ** 3 },
    },
    capabilities: {
      kind: "gvisor",
      launchReady: true,
      hostIdentityDigest: "c".repeat(64),
      adapter: { version: "2026.09.15.1", sha256: "d".repeat(64) },
      runtime: { path: "/usr/local/bin/runsc", sha256: "e".repeat(64) },
      runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
      resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
      access: { terminal: "owner-gated-command-v1", publicPorts: false },
      desktop: false,
      windows: false,
    },
    supportedIsolationDrivers: ["gvisor-runsc"],
    isolationClass: "application-kernel",
    lastPreflightAt: "2026-09-15T12:00:00.000Z",
    lastErrorCode: null,
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("launch on server", () => {
  it("starts a fresh Linux Sandbox launch on a ready gVisor host", () => {
    expect(launchOnDeploymentTarget(gvisorTarget(), null)).toEqual({
      label: "Launch on this server",
      href: `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${TARGET_ID}`,
    });
  });

  it("offers nothing when the saved evidence isn't ready", () => {
    const unavailable = gvisorTarget({ status: "unavailable", lastErrorCode: "GVISOR_ADAPTER_UNAVAILABLE" });
    (unavailable.capabilities as { launchReady: boolean }).launchReady = false;
    expect(launchOnDeploymentTarget(unavailable, null)).toBeNull();
    expect(launchOnDeploymentTarget(null, null)).toBeNull();
  });

  it("continues a pending launch only when this server can run it", () => {
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "journey", profileId: "linux-terminal" })).toEqual({
      label: "Continue launch",
      href: `/dashboard/launch?targetId=${TARGET_ID}`,
    });
    // A pending Codex launch can't use a Linux Sandbox host, so this starts fresh.
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "journey", profileId: "codex" })?.label)
      .toBe("Launch on this server");
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "handoff", resourceId: "linux-terminal", unified: true })).toEqual({
      label: "Continue launch",
      href: `/dashboard/launch?kind=computer&profile=linux-terminal&targetId=${TARGET_ID}`,
    });
    expect(launchOnGvisorTarget(TARGET_ID, { source: "handoff", resourceId: "codex", unified: false }).label)
      .toBe("Launch on this server");
  });

  it("continues an agent launch on a ready Hivra-created cloud server", () => {
    expect(launchOnProviderServer(TARGET_ID, { source: "handoff", resourceId: "codex", unified: false })).toEqual({
      label: "Continue launch",
      href: `/dashboard/welcome?step=deploy&agentType=codex&targetId=${TARGET_ID}`,
    });
    expect(launchOnProviderServer(TARGET_ID, { source: "journey", profileId: "linux-terminal" })).toEqual({
      label: "Launch on this server",
      href: `/dashboard/launch?start=1&targetId=${TARGET_ID}`,
    });
  });

  it("reads a pending launch from the return link first, then the journey draft", () => {
    const draft = { ...createLaunchDraft(), resourceKind: "computer" as const, profileId: "linux-terminal" as const };
    expect(pendingLaunchFrom({ launchParam: "codex", returnTo: "unified-launch", draft }))
      .toEqual({ source: "handoff", resourceId: "codex", unified: true });
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft }))
      .toEqual({ source: "journey", profileId: "linux-terminal" });
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: { ...draft, launchState: "accepted" } })).toBeNull();
    // A launch already sent keeps the server it was sent to.
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: { ...draft, launchState: "submitting" } })).toBeNull();
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: { ...draft, launchState: "uncertain" } })).toBeNull();
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: { ...draft, launchState: "failed" } }))
      .toEqual({ source: "journey", profileId: "linux-terminal" });
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: createLaunchDraft() })).toBeNull();
    expect(pendingLaunchFrom({ launchParam: null, returnTo: null, draft: { ...draft, profileId: "omarchy" } })).toBeNull();
  });
});
