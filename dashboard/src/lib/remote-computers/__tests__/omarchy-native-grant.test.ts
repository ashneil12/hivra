jest.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { buildOmarchyNativeGuardianGrant, omarchyGuardianUnitSource } from "../omarchy-native-grant";
import {
  OMARCHY_NATIVE_GUARDIAN_SHA256,
  OMARCHY_NATIVE_INSPECTION_REVISION,
  OMARCHY_NATIVE_OWNERSHIP_SHA256,
  type PreparedOmarchyNativeDescriptor,
} from "../omarchy-native-capability";

const nowMs = Date.parse("2026-09-08T06:00:00.000Z");
const sessionId = "33333333-3333-4333-8333-333333333333";
const descriptor: PreparedOmarchyNativeDescriptor = {
  protocol: "hivra-omarchy-native-prepared-v2", computerId: "11111111-1111-4111-8111-111111111111",
  vmid: 2099, profile: "omarchy", guestPrivateIpv4: "10.240.20.99",
  inspectionRevision: OMARCHY_NATIVE_INSPECTION_REVISION,
  preparationOperationId: "22222222-2222-4222-8222-222222222222", serviceOwnerUid: 1000,
  waylandDisplay: "wayland-1", omarchyPackageVersion: "4.0.2-1",
  sunshineVersion: "2026.516.143833-4", guardianSha256: OMARCHY_NATIVE_GUARDIAN_SHA256,
  ownershipSha256: OMARCHY_NATIVE_OWNERSHIP_SHA256, sunshineSha256: "c".repeat(64),
  preparedSha256: "d".repeat(64), guestBootId: "55555555-5555-4555-8555-555555555555",
  observedBoottimeNs: "1000000000000", compositor: "wayland-hyprland",
  webBrokerOrigin: "https://omarchy-canary.hermesos.cloud",
  webSelkiesImage: "ghcr.io/selkies-project/selkies/desktop@sha256:395336daf8a8552949da12a969e0d7a0893309a01e65c81fb75bb0cbab3e3756",
  webNodeImage: "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  route: { status: "configured-proven", publicIpv4: "198.51.100.11", tcpPorts: [47984, 47989, 48010],
    udpPorts: [5353, 47998, 47999, 48000, 48002, 48010], sourceCidrs: ["10.240.20.1/32"] },
  privateNetworkReachable: true, supportsInputTakeover: true,
  observedAt: "2026-09-08T05:59:59.000Z",
};
const session = {
  ownerId: "user_fixture", capabilityGeneration: "66666666-6666-4666-8666-666666666666",
  sessionId, clientId: "77777777-7777-4777-8777-777777777777",
  clientCertificatePem: "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
  clientCertificateSha256: "b".repeat(64), expiresAt: "2026-09-08T06:04:00.000Z",
  continuousExpiresAt: "2026-09-08T17:59:59.000Z",
};

it("builds the exact bounded one-use guardian grant", () => {
  const grant = buildOmarchyNativeGuardianGrant({ session, descriptor, nowMs,
    leaseId: "44444444-4444-4444-8444-444444444444" });
  expect(grant).not.toBeNull();
  expect(grant).toMatchObject({ sessionId, runtimeMaxUsec: 180_000_000,
    deadlineBoottimeNs: 1241000000000, clientId: session.clientId,
    expiresAtUnixMs: Date.parse(session.expiresAt),
    continuousDeadlineBoottimeNs: 44200000000000,
    clientCertificateSha256: session.clientCertificateSha256,
    binding: { computerId: descriptor.computerId, operationId: descriptor.preparationOperationId, vmid: descriptor.vmid } });
  const source = omarchyGuardianUnitSource(sessionId, grant!.runtimeMaxUsec);
  expect(grant!.unitSha256).toBe(createHash("sha256").update(source).digest("hex"));
  expect(source).toContain("Type=notify");
  expect(source).toContain("Restart=no");
  expect(source).toContain("NotifyAccess=main");
  expect(source).toContain("KillMode=control-group");
  expect(source).toContain("RuntimeMaxSec=180000000us");

  const python = spawnSync("python3", ["-c", `
import base64,importlib.util,pathlib,sys
module_path=pathlib.Path(sys.argv[1]).resolve()
spec=importlib.util.spec_from_file_location('guardian',module_path)
guardian=importlib.util.module_from_spec(spec); spec.loader.exec_module(guardian)
grant={'sessionId':sys.argv[2],'runtimeMaxUsec':int(sys.argv[3])}
unit=guardian.guardian_unit(grant,pathlib.Path('/usr/local/libexec/hivra/omarchy-native-supervisor.py'))
print(base64.b64encode(unit.encode()).decode())
`, path.resolve(process.cwd(), "provisioner/remote-desktop/omarchy-native-supervisor.py"),
  sessionId, String(grant!.runtimeMaxUsec)], { encoding: "utf8", timeout: 5_000 });
  expect(python.status).toBe(0);
  expect(Buffer.from(python.stdout.trim(), "base64").toString("utf8")).toBe(source);
});

it("fails closed when activation no longer fits inside the lease", () => {
  expect(buildOmarchyNativeGuardianGrant({ session: { ...session, expiresAt: "2026-09-08T06:00:59.999Z" },
    descriptor, nowMs })).toBeNull();
});

it("rejects stale descriptor clocks and unsafe boottime conversion", () => {
  expect(buildOmarchyNativeGuardianGrant({ session,
    descriptor: { ...descriptor, observedAt: "2026-09-08T05:57:59.000Z" }, nowMs })).toBeNull();
  expect(buildOmarchyNativeGuardianGrant({ session,
    descriptor: { ...descriptor, observedBoottimeNs: "9999999999999999999" }, nowMs })).toBeNull();
});
