/** @jest-environment node */

// One field at a time: an Ubuntu Desktop capability receipt that is wrong in
// any single field is refused, on every path that reads one. A mutation probe
// found the compositor, private-network, transport-count and generation
// checks could be removed without any test failing.
//
// Matches PR #148: Start, Restart and Resize accept any desktop release Hivra
// still recognises (allowKnownPredecessor) but still need a fresh, boot-bound
// receipt for this computer and broker; a fresh provision must prove the
// current release. Only the release check is relaxed, never another field.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import {
  DESKTOP_PROVISION_UNVERIFIED_MESSAGE,
  DESKTOP_START_UNVERIFIED_MESSAGE,
  parseRemoteDesktopCapabilityReceipt,
  REMOTE_DESKTOP_BUNDLE_REVISION,
  REMOTE_DESKTOP_COMPATIBILITY,
  verifyDesktopReadinessReceipt,
} from "@/lib/remote-computers/capability-inspection";

const COMPUTER = "00000000-0000-4000-8000-000000001041";
const BROKER = "https://agent.example.test";
const MARKER = "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ";
const PREDECESSORS = Object.keys(REMOTE_DESKTOP_COMPATIBILITY).filter(revision => revision !== REMOTE_DESKTOP_BUNDLE_REVISION);

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "hivra-remote-desktop-capability-v1",
    computerKind: "hivra-agent",
    computerId: COMPUTER,
    capabilityGeneration: "00000000-0000-4000-8000-000000001044",
    bootIdentitySha256: "f".repeat(64),
    observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION,
    compositor: "x11",
    installedTransports: ["selkies-websocket"],
    privateNetworkReachable: false,
    supportsInputTakeover: true,
    brokerOrigin: BROKER,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}
const stdout = (value: Record<string, unknown>) => `${MARKER}${JSON.stringify(value)}\n`;
const withRevision = (revision: string) => (value: Record<string, unknown>) => ({ ...value, observedRevision: revision });
const hostResult = (value: Record<string, unknown>) => ({ ok: true, stdout: stdout(value), stderr: "" });

// Every parser setting a caller uses: session issuance and the Desktop tab
// (current release only), Start/Restart/Resize (#148) and the provider path.
const SETTINGS = [
  ["current release only", {}],
  ["known predecessor (Start, Restart, Resize)", { allowKnownPredecessor: true }],
  ["known predecessor without boot identity (provider path)", { allowKnownPredecessor: true, allowMissingBootIdentity: true }],
] as const;

const CORRUPTIONS: Array<[string, unknown]> = [
  ["protocol", "hivra-remote-desktop-capability-v2"],
  ["computerKind", "hivra-computer"],
  ["computerId", "not-a-uuid"],
  ["capabilityGeneration", "not-a-uuid"],
  ["capabilityGeneration", 42],
  ["observedRevision", "e".repeat(64)],
  ["observedRevision", "F".repeat(64)],
  ["compositor", "wayland"],
  ["installedTransports", ["selkies-websocket", "novnc"]],
  ["installedTransports", []],
  ["installedTransports", ["novnc"]],
  ["installedTransports", "selkies-websocket"],
  ["privateNetworkReachable", true],
  ["privateNetworkReachable", "false"],
  ["supportsInputTakeover", false],
  ["brokerOrigin", "http://agent.example.test"],
  ["brokerOrigin", "https://agent.example.test/path"],
  ["observedAt", "yesterday"],
  ["bootIdentitySha256", "f".repeat(63)],
];

describe("a receipt wrong in one field", () => {
  it("is accepted whole on every setting, so each refusal below is that field's", () => {
    for (const [, options] of SETTINGS) {
      expect(parseRemoteDesktopCapabilityReceipt(stdout(receipt()), options)).toEqual(receipt({ observedAt: expect.any(String) }));
    }
  });

  describe.each(SETTINGS)("%s", (_label, options) => {
    it.each(CORRUPTIONS)("refuses %s = %p", (field, value) => {
      expect(parseRemoteDesktopCapabilityReceipt(stdout(receipt({ [field]: value })), options)).toBeNull();
      // Relaxing the release never relaxes another field.
      for (const revision of PREDECESSORS) {
        const older = withRevision(revision)(receipt({ [field]: value }));
        expect(parseRemoteDesktopCapabilityReceipt(stdout(field === "observedRevision" ? receipt({ [field]: value }) : older), options))
          .toBeNull();
      }
    });

    it.each(["protocol", "computerKind", "computerId", "capabilityGeneration", "observedRevision", "compositor",
      "installedTransports", "privateNetworkReachable", "supportsInputTakeover", "brokerOrigin", "observedAt"])(
      "refuses a receipt missing %s", (field) => {
        const missing = receipt();
        delete missing[field];
        expect(parseRemoteDesktopCapabilityReceipt(stdout(missing), options)).toBeNull();
      });
  });
});

describe("Start, Restart and Resize after #148", () => {
  it.each(["start", "restart", "resize"])("%s accepts every release Hivra still recognises, current or older", (operationKind) => {
    for (const revision of Object.keys(REMOTE_DESKTOP_COMPATIBILITY)) {
      const verdict = verifyDesktopReadinessReceipt(hostResult(receipt({ observedRevision: revision })),
        { computerId: COMPUTER, brokerOrigin: BROKER, operationKind });
      expect({ revision, ok: verdict.ok }).toEqual({ revision, ok: true });
    }
  });

  it.each(CORRUPTIONS)("start refuses an older release whose %s = %p, as unverified", (field, value) => {
    const older = field === "observedRevision" ? receipt({ [field]: value }) : receipt({ observedRevision: PREDECESSORS[0], [field]: value });
    expect(verifyDesktopReadinessReceipt(hostResult(older), { computerId: COMPUTER, brokerOrigin: BROKER, operationKind: "start" }))
      .toMatchObject({ ok: false, failureCode: "capability_marker_invalid", ownerMessage: DESKTOP_START_UNVERIFIED_MESSAGE });
  });

  it("start still needs the receipt's boot identity", () => {
    const unbound = receipt({ observedRevision: PREDECESSORS[0] });
    delete unbound.bootIdentitySha256;
    expect(verifyDesktopReadinessReceipt(hostResult(unbound), { computerId: COMPUTER, brokerOrigin: BROKER, operationKind: "start" }))
      .toMatchObject({ ok: false, failureCode: "capability_marker_invalid" });
  });

  it.each([
    ["computer", { computerId: "00000000-0000-4000-8000-000000001042" }],
    ["broker", { brokerOrigin: "https://other.example.test" }],
  ])("start refuses a valid receipt for another %s as an identity mismatch", (_label, change) => {
    expect(verifyDesktopReadinessReceipt(hostResult(receipt({ observedRevision: PREDECESSORS[0], ...change })),
      { computerId: COMPUTER, brokerOrigin: BROKER, operationKind: "start" }))
      .toMatchObject({ ok: false, failureCode: "identity_mismatch", ownerMessage: DESKTOP_START_UNVERIFIED_MESSAGE });
  });

  it("a fresh provision must prove the current release", () => {
    const expected = { computerId: COMPUTER, brokerOrigin: BROKER, operationKind: "provision" };
    expect(verifyDesktopReadinessReceipt(hostResult(receipt()), expected)).toMatchObject({ ok: true });
    for (const revision of PREDECESSORS) {
      expect(verifyDesktopReadinessReceipt(hostResult(receipt({ observedRevision: revision })), expected)).toEqual({
        ok: false, failureCode: "desktop_release_not_current", observedRevision: revision, ownerMessage: DESKTOP_PROVISION_UNVERIFIED_MESSAGE,
      });
    }
    expect(verifyDesktopReadinessReceipt(hostResult(receipt({ compositor: "wayland" })), expected))
      .toMatchObject({ ok: false, failureCode: "capability_marker_invalid", ownerMessage: DESKTOP_PROVISION_UNVERIFIED_MESSAGE });
  });
});
