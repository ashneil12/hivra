import { advanceProviderComputerSetup, listProviderComputerSetupEvidence, listProviderComputerSetups } from "../provider-computer-setup";
import { cleanupConnection, cleanupKey, cleanupOrder, firstBootCleanupFixture } from "./hetzner-cleanup.fixtures";
import { receiverFixture } from "./first-boot-receiver.fixtures";
import { providerVmTarget } from "./provider-vm-target.fixtures";
import type { StoredFirstBootEnrollment } from "../first-boot-store";
import type { loadHetznerCloudConnectionMetadata } from "../hetzner-cloud-store";
import { FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";

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
it("returns setup views with Hivra's record of every server request on the connection, read-only", async () => {
  const h = harness();
  const createdServers = [
    { orderId: cleanupOrder, serverName: "hivra-a1b2", providerServerId: "42", status: "created_off" as const },
    { orderId: "00000000-0000-4000-8000-000000000123", serverName: "hivra-c3d4", providerServerId: null, status: "ambiguous" as const },
  ];
  const listCreated = jest.fn(async () => createdServers);
  const evidence = await listProviderComputerSetupEvidence("owner", cleanupConnection, { ...h.deps, createdServers: listCreated });
  expect(evidence.computers).toEqual([expect.objectContaining({ orderId: cleanupOrder, stage: "identity_enrolled" })]);
  expect(evidence.createdServers).toEqual(createdServers);
  expect(listCreated).toHaveBeenCalledWith("owner", cleanupConnection);
  expect(h.deps.advance).not.toHaveBeenCalled(); expect(h.deps.prepare).not.toHaveBeenCalled();
});
it("fails the whole read when either half of the evidence can't be read", async () => {
  const h = harness();
  await expect(listProviderComputerSetupEvidence("owner", cleanupConnection, {
    ...h.deps, createdServers: jest.fn(async () => { throw new Error("database down"); }),
  })).rejects.toThrow("database down");
});
it("keeps a legacy server's 15 minutes from creation, shown only until it connects back", async () => {
  const h = harness();
  h.enrollment.phase = "awaiting_identity";
  h.enrollment.challenge = { ...h.enrollment.challenge, binding: { ...h.enrollment.challenge.binding, recipeVersion: FIRST_BOOT_LEGACY_RECIPE_VERSION },
    issuedAt: "2026-08-28T00:55:00.000Z", expiresAt: "2026-08-28T01:10:00.000Z" };
  h.deps.boot.mockResolvedValue(null as never);
  const [waiting] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(waiting).toMatchObject({ stage: "awaiting_setup", enrollmentExpiresAt: "2026-08-28T01:10:00.000Z", enrollmentWindow: "since_creation" });

  h.enrollment.phase = "enrolled";
  const [enrolled] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(enrolled).toMatchObject({ stage: "identity_enrolled", enrollmentExpiresAt: null, enrollmentWindow: "since_creation" });

  h.enrollment.phase = "awaiting_identity";
  const expired = await listProviderComputerSetups("owner", cleanupConnection, { ...h.deps, now: () => new Date("2026-08-28T01:10:00Z") });
  expect(expired[0]).toMatchObject({ stage: "expired", enrollmentExpiresAt: "2026-08-28T01:10:00.000Z" });
});
it("has no deadline before Start setup, then 15 minutes from Hivra's recorded power-on", async () => {
  const h = harness();
  h.enrollment.phase = "awaiting_identity";
  h.enrollment.challenge = { ...h.enrollment.challenge, binding: { ...h.enrollment.challenge.binding, recipeVersion: FIRST_BOOT_RECIPE_VERSION },
    issuedAt: "2026-08-27T20:00:00.000Z", expiresAt: "2026-08-27T20:15:00.000Z" };
  h.deps.boot.mockResolvedValue(null as never);
  // Created five hours ago and never started: no countdown, not expired.
  const [waiting] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(waiting).toMatchObject({ stage: "awaiting_setup", enrollmentExpiresAt: null, enrollmentWindow: "since_start" });
  const later = await listProviderComputerSetups("owner", cleanupConnection, { ...h.deps, now: () => new Date("2026-09-20T00:00:00Z") });
  expect(later[0]).toMatchObject({ stage: "awaiting_setup", enrollmentExpiresAt: null });
  h.enrollment.phase = "staged";
  const [staged] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(staged).toMatchObject({ enrollmentExpiresAt: null, enrollmentWindow: "since_start" });
  expect(staged.stage).not.toBe("expired");

  // Start setup powered it on at 00:58; the owner sees 15 minutes from then.
  h.enrollment.phase = "awaiting_identity";
  h.enrollment.armedAt = "2026-08-28T00:58:00.000Z"; h.enrollment.armedExpiresAt = "2026-08-28T01:15:00.000Z";
  const [started] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(started).toMatchObject({ enrollmentExpiresAt: "2026-08-28T01:13:00.000Z", enrollmentWindow: "since_start" });
  // Hivra still accepts the connection during the 2-minute boot slack...
  const slack = await listProviderComputerSetups("owner", cleanupConnection, { ...h.deps, now: () => new Date("2026-08-28T01:14:00Z") });
  expect(slack[0].stage).not.toBe("expired");
  // ...and the server's own expiry decides "expired".
  const expired = await listProviderComputerSetups("owner", cleanupConnection, { ...h.deps, now: () => new Date("2026-08-28T01:15:00Z") });
  expect(expired[0]).toMatchObject({ stage: "expired", enrollmentWindow: "since_start" });

  h.enrollment.phase = "enrolled";
  const [enrolled] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(enrolled).toMatchObject({ stage: "identity_enrolled", enrollmentExpiresAt: null });
});
it("reads the original attempt of either recipe without naming one", async () => {
  const h = harness();
  await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(h.deps.enrollment).toHaveBeenCalledWith({ binding: { userId: "owner", connectionId: cleanupConnection,
    connectionRevision: 7, orderId: cleanupOrder, quoteFingerprint: h.order.quoteFingerprintSha256 },
  capacityIdempotencyKey: cleanupKey });
});
it("reports no window when setup was never requested", async () => {
  const h = harness(); h.deps.enrollment.mockResolvedValue(null);
  const [view] = await listProviderComputerSetups("owner", cleanupConnection, h.deps);
  expect(view).toMatchObject({ stage: "not_requested", enrollmentWindow: null, enrollmentExpiresAt: null });
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
  if (kind === "expired") {
    h.enrollment.phase = "awaiting_identity";
    h.enrollment.challenge = { ...h.enrollment.challenge, binding: { ...h.enrollment.challenge.binding, recipeVersion: FIRST_BOOT_LEGACY_RECIPE_VERSION } };
  }
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
