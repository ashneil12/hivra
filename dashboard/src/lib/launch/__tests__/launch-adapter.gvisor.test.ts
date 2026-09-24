/** @jest-environment jsdom */
// B2 review: an owner who chose a Linux Sandbox host near the end of its
// 15-minute readiness window got a refusal at Launch. Launch re-checks it first.

import { createAgent, findHivraLaunchReceipt, type HivraAgent } from "@/lib/hivra/agent-api";
import { checkGvisorConnection, InfrastructureApiError } from "@/lib/infrastructure/client";
import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { HIVRA_GVISOR_ADAPTER_VERSION } from "@/lib/hivra/gvisor-computer-contract";
import { PROFILE_DETAILS, type LaunchDraft } from "../contracts";
import { createLaunchDraft } from "../draft-store";
import { LaunchCorrectableError, submitLaunchDraft, type LaunchObservation } from "../launch-adapter";

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  createAgent: jest.fn(),
  findHivraLaunchReceipt: jest.fn(),
}));
jest.mock("@/lib/infrastructure/client", () => ({
  ...jest.requireActual("@/lib/infrastructure/client"),
  checkGvisorConnection: jest.fn(),
  discoverInfrastructureHost: jest.fn(),
}));

const DEPLOYMENT = {
  mode: "self-managed",
  connectionId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  expectedConnectionRevision: 3,
} as const;

function host(checkedMinutesAgo: number): DeploymentTargetDto {
  return {
    id: DEPLOYMENT.targetId, connectionId: DEPLOYMENT.connectionId, evidenceConnectionRevision: 3,
    externalId: `gvisor-${"b".repeat(24)}`, displayName: "Linux host — gVisor", status: "ready",
    capacity: {
      cpu: { totalCores: 8, utilizationRatio: null },
      memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
      storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
    },
    capabilities: {
      kind: "gvisor", launchReady: true, hostIdentityDigest: "c".repeat(64),
      adapter: { version: HIVRA_GVISOR_ADAPTER_VERSION, sha256: "d".repeat(64) },
      runtime: { path: "/usr/local/bin/runsc", sha256: "e".repeat(64) },
      runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
      resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
      access: { terminal: "owner-gated-command-v1", publicPorts: false },
      desktop: false, windows: false,
    },
    supportedIsolationDrivers: ["gvisor-runsc"], isolationClass: "application-kernel",
    lastPreflightAt: new Date(Date.now() - checkedMinutesAgo * 60_000).toISOString(),
    lastErrorCode: null, createdAt: "2026-09-24T11:00:00.000Z", updatedAt: "2026-09-24T11:00:00.000Z",
  } as DeploymentTargetDto;
}

function sandboxDraft(): LaunchDraft {
  const details = PROFILE_DETAILS["linux-terminal"];
  return { ...createLaunchDraft(), stage: "launch", launchState: "submitting", resourceKind: details.resourceKind,
    profileId: "linux-terminal", name: "Sandbox 1", resources: { ...details.recommended }, submittedAt: new Date().toISOString() };
}

const AGENT = { id: "33333333-3333-4333-8333-333333333333", name: "Sandbox 1", status: "provisioning" } as HivraAgent;

beforeEach(() => {
  jest.clearAllMocks();
  (createAgent as jest.Mock).mockResolvedValue(AGENT);
  (findHivraLaunchReceipt as jest.Mock).mockResolvedValue(null);
});

it("checks a host whose readiness is about to lapse before sending the launch", async () => {
  const order: string[] = [];
  (checkGvisorConnection as jest.Mock).mockImplementation(async () => { order.push("check"); return { targetId: DEPLOYMENT.targetId, ready: true }; });
  (createAgent as jest.Mock).mockImplementation(async () => { order.push("create"); return AGENT; });
  const observed: LaunchObservation["kind"][] = [];

  await expect(submitLaunchDraft(sandboxDraft(), DEPLOYMENT, {
    selfManagedTarget: host(14), onObserved: observation => observed.push(observation.kind),
  })).resolves.toEqual(AGENT);

  expect(order).toEqual(["check", "create"]);
  expect(observed.slice(0, 2)).toEqual(["checking-host", "sent"]);
});

it("doesn't check a host checked a minute ago", async () => {
  await submitLaunchDraft(sandboxDraft(), DEPLOYMENT, { selfManagedTarget: host(1) });
  expect(checkGvisorConnection).not.toHaveBeenCalled();
  expect(createAgent).toHaveBeenCalledTimes(1);
});

it("returns to Review with the reason and a way to Capacity when the host fails its check, sending nothing", async () => {
  (checkGvisorConnection as jest.Mock).mockRejectedValue(new InfrastructureApiError("x", 502, "remote_failed"));

  const error = await submitLaunchDraft(sandboxDraft(), DEPLOYMENT, { selfManagedTarget: host(20) }).catch(caught => caught);

  expect(error).toBeInstanceOf(LaunchCorrectableError);
  expect(error.message).toBe("Linux Sandbox setup on Linux host — gVisor didn't pass its check. Reinstall the setup to repair it.");
  expect(error.action).toEqual({ kind: "open", label: "Check it in Capacity", href: "/dashboard/infrastructure?launch=linux-terminal&returnTo=unified-launch" });
  expect(createAgent).not.toHaveBeenCalled();
});
