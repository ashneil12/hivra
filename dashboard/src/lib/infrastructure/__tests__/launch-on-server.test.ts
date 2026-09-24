/** @jest-environment node */

import type { DeploymentTargetDto, GvisorDeploymentTargetDto } from "../contracts";
import { createLaunchDraft } from "@/lib/launch/draft-store";
import { HIVRA_GVISOR_PREFLIGHT_TTL_MS } from "@/lib/hivra/gvisor-computer-contract";
import {
  gvisorCheckReadyUntil,
  hasReadyEvidence,
  isLaunchReadyTarget,
  launchActionForGvisorCheck,
  launchActionForReadyTarget,
  launchOnProviderServer,
  launchReadyTargetKey,
  launchReadyUntil,
  nextLaunchReadinessChange,
  pendingLaunchFrom,
  type PendingLaunch,
} from "../launch-on-server";

const TARGET_ID = "55555555-5555-4555-8555-555555555555";
const CHECKED_AT = Date.parse("2026-09-15T12:00:00.000Z");
/** Five minutes after the gVisor host's last strict check. */
const NOW = CHECKED_AT + 5 * 60_000;

/** What a card offers for a saved target at `now`: the useTargetLaunchAction
 * composition, without React. */
function launchOnDeploymentTarget(target: DeploymentTargetDto | null, pending: PendingLaunch | null, now: number) {
  return target && isLaunchReadyTarget(target, now) ? launchActionForReadyTarget(target, pending) : null;
}

/** What a dialog offers for a check that passed at checkedAt: the
 * useGvisorCheckLaunchAction composition, without React. */
function launchOnGvisorCheck(check: { targetId: string; checkedAt: number } | null, pending: PendingLaunch | null, now: number) {
  return check && now < gvisorCheckReadyUntil(check.checkedAt) ? launchActionForGvisorCheck(check.targetId, pending) : null;
}

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
    expect(launchOnDeploymentTarget(gvisorTarget(), null, NOW)).toEqual({
      label: "Launch on this server",
      href: `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${TARGET_ID}`,
    });
  });

  it("offers nothing when the saved evidence isn't ready", () => {
    const unavailable = gvisorTarget({ status: "unavailable", lastErrorCode: "GVISOR_ADAPTER_UNAVAILABLE" });
    (unavailable.capabilities as { launchReady: boolean }).launchReady = false;
    expect(launchOnDeploymentTarget(unavailable, null, NOW)).toBeNull();
    expect(launchOnDeploymentTarget(null, null, NOW)).toBeNull();
  });

  it("continues a pending launch only when this server can run it", () => {
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "journey", profileId: "linux-terminal" }, NOW)).toEqual({
      label: "Continue launch",
      href: `/dashboard/launch?targetId=${TARGET_ID}`,
    });
    // A pending Codex launch can't use a Linux Sandbox host, so this starts fresh.
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "journey", profileId: "codex" }, NOW)?.label)
      .toBe("Launch on this server");
    expect(launchOnDeploymentTarget(gvisorTarget(), { source: "handoff", resourceId: "linux-terminal", unified: true }, NOW)).toEqual({
      label: "Continue launch",
      href: `/dashboard/launch?kind=computer&profile=linux-terminal&targetId=${TARGET_ID}`,
    });
    expect(launchOnGvisorCheck({ targetId: TARGET_ID, checkedAt: NOW }, { source: "handoff", resourceId: "codex", unified: false }, NOW)?.label)
      .toBe("Launch on this server");
  });

  // Review of slice 5: a gVisor host showed Ready and a Launch button for good,
  // but the server accepts a new sandbox only within 15 minutes of the last
  // strict check (gvisor-computer-service executionAuthority), so a launch an
  // hour later failed with "The connected host authority changed".
  it("ends a gVisor host's launch action when its last check is more than 15 minutes old", () => {
    const target = gvisorTarget();
    const deadline = CHECKED_AT + HIVRA_GVISOR_PREFLIGHT_TTL_MS;
    expect(launchReadyUntil(target)).toBe(deadline);
    expect(launchOnDeploymentTarget(target, null, deadline - 1)?.label).toBe("Launch on this server");
    expect(launchOnDeploymentTarget(target, null, deadline)).toBeNull();
    expect(launchOnDeploymentTarget(target, null, CHECKED_AT + 60 * 60_000)).toBeNull();
    // Still set up: it needs a fresh check, not setup again.
    expect(hasReadyEvidence(target)).toBe(true);
  });

  it("never launches on a gVisor host without a check time or with another adapter release", () => {
    expect(launchOnDeploymentTarget(gvisorTarget({ lastPreflightAt: null }), null, NOW)).toBeNull();
    const olderAdapter = gvisorTarget();
    (olderAdapter.capabilities as { adapter: { version: string } }).adapter.version = "2026.01.01.1";
    expect(launchReadyUntil(olderAdapter)).toBe(-Infinity);
    expect(launchOnDeploymentTarget(olderAdapter, null, NOW)).toBeNull();
    expect(hasReadyEvidence(olderAdapter)).toBe(true);
  });

  it("trusts a check that just passed even when the browser clock is a little behind the server's", () => {
    // Only the deadline is compared with the browser clock, so a check stamped
    // 30 seconds "in the future" still reads as fresh.
    expect(launchOnDeploymentTarget(gvisorTarget(), null, CHECKED_AT - 30_000)?.label).toBe("Launch on this server");
  });

  it("lists which targets can launch now and when that next changes", () => {
    const later = gvisorTarget({ id: "77777777-7777-4777-8777-777777777777", lastPreflightAt: "2026-09-15T12:10:00.000Z" });
    const targets = [gvisorTarget(), later];
    expect(launchReadyTargetKey(targets, NOW)).toBe(`${TARGET_ID},${later.id}`);
    expect(nextLaunchReadinessChange(targets, NOW)).toBe(CHECKED_AT + HIVRA_GVISOR_PREFLIGHT_TTL_MS);
    const afterFirst = CHECKED_AT + HIVRA_GVISOR_PREFLIGHT_TTL_MS;
    expect(launchReadyTargetKey(targets, afterFirst)).toBe(later.id);
    expect(nextLaunchReadinessChange(targets, afterFirst)).toBe(Date.parse("2026-09-15T12:25:00.000Z"));
    expect(nextLaunchReadinessChange(targets, CHECKED_AT + 60 * 60_000)).toBeNull();
  });

  it("offers a just-passed gVisor check's launch for 15 minutes", () => {
    const check = { targetId: TARGET_ID, checkedAt: NOW };
    expect(launchOnGvisorCheck(check, { source: "journey", profileId: "linux-terminal" }, NOW)).toEqual({
      label: "Continue launch",
      href: `/dashboard/launch?targetId=${TARGET_ID}`,
    });
    expect(launchOnGvisorCheck(check, null, NOW + HIVRA_GVISOR_PREFLIGHT_TTL_MS)).toBeNull();
    expect(launchOnGvisorCheck(null, null, NOW)).toBeNull();
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
