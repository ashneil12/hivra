import { advanceProviderComputerSetup, listProviderComputerSetups } from "../provider-computer-setup";
import { cleanupConnection, cleanupKey, cleanupOrder, firstBootCleanupFixture } from "./hetzner-cleanup.fixtures";
import { receiverFixture } from "./first-boot-receiver.fixtures";
import { providerVmTarget } from "./provider-vm-target.fixtures";
import type { StoredFirstBootEnrollment } from "../first-boot-store";
import type { loadHetznerCloudConnectionMetadata } from "../hetzner-cloud-store";

function harness() {
  const { order, firstBoot } = firstBootCleanupFixture();
  order.operation.idempotencyKey = cleanupKey;
  const enrollment: StoredFirstBootEnrollment = { ...receiverFixture().stored, phase: "enrolled", providerServerId: "42",
    capacityIdempotencyKey: cleanupKey, challenge: { ...receiverFixture().stored.challenge, binding: firstBoot.binding } };
  const target = providerVmTarget();
  target.evidenceConnectionRevision = 7; target.capabilities.capacityOrderId = cleanupOrder;
  target.capabilities.enrollmentAttemptId = firstBoot.binding.attemptId; target.capabilities.provisioner.ready = true;
  const deps = {
    connection: jest.fn(async () => ({ id: cleanupConnection, user_id: "owner", status: "ready", provider: "hetzner-cloud", revision: 7 }) as Awaited<ReturnType<typeof loadHetznerCloudConnectionMetadata>>),
    order: jest.fn(async () => order), orders: jest.fn(async () => [order]),
    enrollment: jest.fn<Promise<StoredFirstBootEnrollment | null>, [unknown]>(async () => enrollment),
    boot: jest.fn(async () => firstBoot), targets: jest.fn(async () => [] as ReturnType<typeof providerVmTarget>[]),
    advance: jest.fn(async () => ({ stage: "waiting_for_identity" as const })),
    prepare: jest.fn(async () => ({ stage: "computer_prepared" as const, target })), now: () => new Date("2026-08-28T01:00:00Z"),
  };
  const request = { orderId: cleanupOrder, expectedConnectionRevision: 7 };
  return { order, enrollment, firstBoot, target, deps, request };
}

it("reads saved setup without provider actions, SSH, token decryption or automatic resume", async () => {
  const h = harness();
  const views = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(views).toEqual([expect.objectContaining({ stage: "identity_enrolled", launchReady: false, orderId: cleanupOrder })]);
  expect(h.deps.advance).not.toHaveBeenCalled(); expect(h.deps.prepare).not.toHaveBeenCalled();
  expect(JSON.stringify(views)).not.toContain(h.enrollment.challenge.verifierSha256);
  expect(views[0]).not.toHaveProperty("hostPublicKey");
});
it("prepares the original enrolled identity even after its one-time token expired", async () => {
  const h = harness();
  const result = await advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps);
  expect(result).toMatchObject({ stage: "environment_prepared", targetId: h.target.id, launchReady: false });
  expect(h.deps.prepare).toHaveBeenCalledWith({ binding: h.firstBoot.binding, providerServerId: "42" });
  expect(h.deps.advance).not.toHaveBeenCalled();
});
it("does not reinstall an already admitted computer on an explicit replay", async () => {
  const h = harness(); h.deps.targets.mockResolvedValue([h.target]);
  h.target.status = "ready"; h.target.lastErrorCode = null; h.target.capabilities.launchReady = true;
  expect(await advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).toMatchObject({ stage: "environment_prepared", launchReady: true });
  expect(h.deps.prepare).not.toHaveBeenCalled();
});
it("allows explicit recovery of a published but unadmitted computer through its original setup", async () => {
  const h = harness(); h.deps.targets.mockResolvedValue([h.target]);
  expect(await advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).toMatchObject({ stage: "environment_prepared", launchReady: false });
  expect(h.deps.prepare).toHaveBeenCalledWith({ binding: h.firstBoot.binding, providerServerId: "42" });
  expect(h.deps.advance).not.toHaveBeenCalled();
});
it.each(["unconfirmed", "revoked", "expired", "retired", "different_revision"])("does not advance %s setup", async kind => {
  const h = harness();
  if (kind === "unconfirmed") h.deps.enrollment.mockResolvedValue(null);
  if (kind === "revoked") h.enrollment.phase = "revoked";
  if (kind === "expired") h.enrollment.phase = "awaiting_identity";
  if (kind === "retired") h.order.operation.status = "cleaning";
  if (kind === "different_revision") h.request.expectedConnectionRevision = 8;
  await expect(advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).rejects.toThrow();
  expect(h.deps.prepare).not.toHaveBeenCalled(); expect(h.deps.advance).not.toHaveBeenCalled();
});
it("rejects a stale displayed revision before loading the capacity order", async () => {
  const h = harness(); h.deps.connection.mockResolvedValue({ ...(await h.deps.connection()), revision: 8 });
  await expect(advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).rejects.toMatchObject({ code: "connection_changed" });
  expect(h.deps.order).not.toHaveBeenCalled();
});
it("never adopts a returned prepared target with a changed identity", async () => {
  const h = harness(); h.target.externalId = "43"; h.deps.targets.mockResolvedValue([h.target]);
  await expect(advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).rejects.toMatchObject({ code: "connection_changed" });
  expect(h.deps.prepare).not.toHaveBeenCalled();
});
it("rejects arbitrary browser commands and server identities", async () => {
  const h = harness();
  await expect(advanceProviderComputerSetup("owner", cleanupConnection, { ...h.request, serverId: "43", command: "override" } as never, h.deps)).rejects.toThrow();
  expect(h.deps.connection).not.toHaveBeenCalled();
});
it("does not leak raw transport or provider failures", async () => {
  const h = harness(); h.deps.prepare.mockRejectedValue(new Error("PRIVATE_KEY / raw host output"));
  await expect(advanceProviderComputerSetup("owner", cleanupConnection, h.request, h.deps)).rejects.toThrow("Computer setup could not continue: setup_failed");
});
