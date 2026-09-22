import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildProviderDesktopWorkerPlan, parseProviderDesktopWorkerIdentity, parseProviderDesktopWorkerReceipt, type ProviderDesktopWorkerInput } from "../provider-desktop-worker";
import { buildProviderGuestWorkerPlan } from "../provider-guest-worker";
import { providerGuestBundleManifest } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } from "../portable-provisioner-contract";
import { receiverFixture } from "./first-boot-receiver.fixtures";

const clock = {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000};
const input = {
  scope: {binding: receiverFixture().binding, providerServerId: "42"},
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({relativePath,
    content: readFileSync(path.join(process.cwd(), "provisioner", relativePath))})),
  action: "start" as const, authority: {computerId: "11111111-1111-4111-8111-111111111111", controlOrigin: "https://canary.hermesos.cloud",
    access: {mode: "cloudflare-named" as const, hostname: "native.example.test", tunnelId: "33333333-3333-4333-8333-333333333333"}},
  launch: {version: 3 as const, computerSubstrate: "provider-vm" as const, agentKind: "linux-desktop" as const, wantBrowser: null,
    computerId: "11111111-1111-4111-8111-111111111111", controlOrigin: "https://canary.hermesos.cloud",
    model: "" as const, modelKey: "" as const, modelBaseUrl: "" as const,
    tunnelToken: Buffer.from(JSON.stringify({t: "33333333-3333-4333-8333-333333333333", s: "fixture-private-tunnel"})).toString("base64"), accessHostname: null, publicOrigin: "https://native.example.test"},
};
const recovery = () => ({scope: input.scope, agentId: input.agentId, operationId: input.operationId,
  action: "cancel" as const, identity: buildProviderDesktopWorkerPlan(input, clock).identity});
const encodedRequest = (script: string) => JSON.parse(Buffer.from(script.match(/base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1], "base64").toString());

describe("staged private desktop provider controller", () => {
  it("retains .06.3 worker bytes and deadline when the prepared-image release becomes current", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.3", bundleSha256: "5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef" } });
    const plan = buildProviderDesktopWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52");
    expect(plan.script).not.toContain("ce7b372f50ce3aa27bc1efa8fe1a08167ff477cec381a4ef9f93142c1e8b832e");
    expect(() => buildProviderDesktopWorkerPlan({ ...request, identity: prior }, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
  });


  it("retains .06.2 worker bytes and deadline when the prepared-image release becomes current", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.2", bundleSha256: "9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee" } });
    const plan = buildProviderDesktopWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711");
    expect(plan.script).not.toContain("19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52");
    expect(() => buildProviderDesktopWorkerPlan({ ...request, identity: prior }, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
  });

  it("retains .06.1 worker bytes and deadline when the prepared-image release becomes current", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.1", bundleSha256: "61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c" } });
    const plan = buildProviderDesktopWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("0479130b44b65eb4d41e6c35a076ae119da81057589fa1ea1587fc110b06db8e");
    expect(plan.script).not.toContain("2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711");
    expect(() => buildProviderDesktopWorkerPlan({ ...request, identity: prior }, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
  });
  it("retains .05.10's exact worker and cold-start deadline without adopting editor-release bytes", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.05.10", bundleSha256: "c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860" } });
    const retained = { ...request, identity: prior }, plan = buildProviderDesktopWorkerPlan(retained, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("b0838bdc61079929144590cc8f606f2ad22db35d4fa9062920548884d92f032c");
    expect(plan.script).not.toContain("0479130b44b65eb4d41e6c35a076ae119da81057589fa1ea1587fc110b06db8e");
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 1_200_000 })).not.toThrow();
  });
  it("retains .05.9's worker and cold-start deadline without adopting corrected guest bytes", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.05.9", bundleSha256: "89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127" } });
    const retained = { ...request, identity: prior }, plan = buildProviderDesktopWorkerPlan(retained, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("fc03785b18ddc8681a868c6cd7e6e1cda8b2fed97971af0909eb148c92db04d4");
    expect(plan.script).not.toContain("b0838bdc61079929144590cc8f606f2ad22db35d4fa9062920548884d92f032c");
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 1_200_000 })).not.toThrow();
  });
  it("retains .05.8's exact worker and twenty-minute cold-start fence", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.05.8", bundleSha256: "007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545" } });
    const retained = { ...request, identity: prior };
    const plan = buildProviderDesktopWorkerPlan(retained, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("b0a63fa4dd0f077d71e86bcdef4e7c7f46ecd15a1ac45d8479fdecf7ba94b12f");
    expect(plan.script).not.toContain("fc03785b18ddc8681a868c6cd7e6e1cda8b2fed97971af0909eb148c92db04d4");
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 })).toThrow();
    expect(() => buildProviderDesktopWorkerPlan(retained, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 1_200_000 })).not.toThrow();
  });
  it("keeps .05.7 recovery pinned while admitting the bounded cold-start release", () => {
    const request = recovery();
    expect(request.identity.bundle.provisionerVersion).toBe("2026.09.22.1");
    const prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.05.7", bundleSha256: "d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b" } });
    const oldClock = { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 480_000 };
    expect(() => buildProviderDesktopWorkerPlan(request, oldClock)).toThrow();
    const plan = buildProviderDesktopWorkerPlan({ ...request, identity: prior }, oldClock);
    expect(plan.script).toContain("3bc2aca851d67270b801e0885ac161c4cd71d274bc74ead91732f7a5e786bbd0");
    expect(plan.script).not.toContain("b0a63fa4dd0f077d71e86bcdef4e7c7f46ecd15a1ac45d8479fdecf7ba94b12f");
    expect(() => buildProviderDesktopWorkerPlan(request, { ...clock, boottimeMs: Number.MAX_SAFE_INTEGER - 1_200_000 })).not.toThrow();
  });
  it("retains .05.6 recovery with its original worker instead of the current bundle", () => {
    const request = recovery(), prior = parseProviderDesktopWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.05.6", bundleSha256: "1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4" } });
    const plan = buildProviderDesktopWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("69d9f21cfb5e592ce1d0fa2f587cb22812c6bb7e9543fa7233780910951b4a42");
    expect(plan.script).not.toContain("3bc2aca851d67270b801e0885ac161c4cd71d274bc74ead91732f7a5e786bbd0");
    expect(() => parseProviderDesktopWorkerIdentity({ ...prior, bundle: { ...prior.bundle, provisionerVersion: "2026.09.05.7" } })).toThrow();
  });
  it("binds exact release and desktop closure bytes without changing public v1 admission", () => {
    const plan = buildProviderDesktopWorkerPlan(input, clock), manifest = providerGuestBundleManifest(input.scope, input.assets);
    const rows = manifest.filter(row => row.path === "remote-desktop/provider-service-owner.py")
      .map(row => [row.path, row.sha256, row.size, row.mode]);
    expect(plan.identity.desktopCleanup).toEqual({profile: "desktop-owned-services-v1",
      closureSha256: createHash("sha256").update(JSON.stringify(rows) + "\n").digest("hex")});
    expect(encodedRequest(plan.script)).toEqual({action: "start", identity: plan.identity, clock, manifest, launch: input.launch});
    expect(JSON.stringify(plan.identity)).not.toContain("fixture-private-tunnel");
    expect(plan.script).not.toContain("fixture-private-tunnel"); // Still private stdin, NEVER log scripts.
    expect(() => buildProviderGuestWorkerPlan(input as never, clock)).toThrow("Invalid provider guest worker request");
    expect(() => buildProviderGuestWorkerPlan(recovery() as never, clock)).toThrow("Invalid provider guest worker request");
  });
  it("requires the actual Python parser and desktop closure validator to accept the generated document", () => {
    const request = encodedRequest(buildProviderDesktopWorkerPlan(input, clock).script);
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "-c", `import json, runpy, sys
worker = runpy.run_path("provisioner/hivra-provider-worker.py", run_name="fixture_worker")
installer = runpy.run_path("provisioner/hivra-install-agent.py", run_name="fixture_installer")
request = json.load(sys.stdin)
expected = worker["identity"](request["identity"])
worker["desktop_rows"](expected, request["manifest"])
worker["check_launch"](expected, installer["parse_launch"](worker["encode"](request["launch"]), provider_desktop=True))
`], {input: JSON.stringify(request), encoding: "utf8", timeout: 10_000});
    expect({status: result.status, stdout: result.stdout, stderr: result.stderr}).toEqual({status: 0, stdout: "", stderr: ""});
  });
  it.each(["modelKey", "modelBaseUrl", "model", "substrate", "kind", "version", "origin", "computer", "control", "authority_computer", "authority_tunnel", "extra", "both_access", "no_access"])(
    "rejects invalid %s before a command is produced", field => {
      const value = structuredClone(input) as unknown as {launch: Record<string, unknown>; authority: typeof input.authority; assets: typeof input.assets};
      value.assets = input.assets;
      if (["modelKey", "modelBaseUrl", "model"].includes(field)) value.launch[field] = "private-value";
      if (field === "substrate") value.launch.computerSubstrate = "proxmox-kvm";
      if (field === "kind") value.launch.agentKind = "codex";
      if (field === "version") value.launch.version = 1;
      if (field === "origin") value.launch.publicOrigin = "https://other.example.test";
      if (field === "computer") value.launch.computerId = input.operationId;
      if (field === "control") value.launch.controlOrigin = "https://other.example.test";
      if (field === "authority_computer") value.authority.computerId = input.operationId;
      if (field === "authority_tunnel") value.authority.access.tunnelId = input.operationId;
      if (field === "extra") value.launch.command = "arbitrary";
      if (field === "both_access") value.launch.accessHostname = "8-8-8-8.sslip.io";
      if (field === "no_access") value.launch.tunnelToken = null;
      expect(() => buildProviderDesktopWorkerPlan(value as ProviderDesktopWorkerInput, clock)).toThrow("Invalid provider desktop worker request");
    });
  it.each(["http://native.example.test", "https://native.example.test/", "https://native.example.test:443", "https://user@native.example.test",
    "https://Native.example.test", "https://xn--bcher-kva.example.test", "https://native.example.test?key=value", "https://native.example.test\n"])(
    "rejects non-canonical desktop origin %s", publicOrigin => {
      expect(() => buildProviderDesktopWorkerPlan({...input, launch: {...input.launch, publicOrigin}}, clock)).toThrow();
    });
  it("binds standalone direct HTTPS too and validates address octets", () => {
    const direct = {...input, authority: {...input.authority, access: {mode: "direct-https" as const, hostname: "8-8-8-8.sslip.io", tunnelId: null}}, launch: {...input.launch,
      tunnelToken: null, accessHostname: "8-8-8-8.sslip.io", publicOrigin: "https://8-8-8-8.sslip.io"}};
    expect(buildProviderDesktopWorkerPlan(direct, clock).identity.version).toBe(3);
    for (const hostname of ["203-0-113-9.sslip.io", "256-8-8-8.sslip.io", "008-8-8-8.sslip.io"]) {
      expect(() => buildProviderDesktopWorkerPlan({...direct, launch: {...direct.launch, accessHostname: hostname}}, clock)).toThrow();
    }
  });
  it.each(["hivra-provider-worker.py", "remote-desktop/install-guest.py", "remote-desktop/provider-service-owner.py", "remote-desktop/provider-service-plan.py", "README.md", "VERSION"])(
    "rejects drift in exact pinned release file %s", filename => {
      const assets = input.assets.map(asset => asset.relativePath === filename ? {...asset, content: Buffer.alloc(asset.content.length)} : asset);
      expect(() => buildProviderDesktopWorkerPlan({...input, assets}, clock)).toThrow();
    });
  it.each(["operation", "agent", "scope", "bundle", "closure", "profile", "old_version", "extra"])("rejects recovery identity drift: %s", field => {
    const value = recovery();
    if (field === "operation") value.identity.operationId = input.agentId;
    if (field === "agent") value.identity.agentId = input.operationId;
    if (field === "scope") value.identity.bundle.scopeSha256 = "f".repeat(64);
    if (field === "bundle") value.identity.bundle.bundleSha256 = "f".repeat(64);
    if (field === "closure") value.identity.desktopCleanup.closureSha256 = "f".repeat(64);
    if (field === "profile") Object.assign(value.identity.desktopCleanup, {profile: "other"});
    if (field === "old_version") Object.assign(value.identity.bundle, {provisionerVersion: "2026.08.31.2"});
    if (field === "extra") Object.assign(value.identity, {command: "private"});
    expect(() => buildProviderDesktopWorkerPlan(value, clock)).toThrow();
  });
  it("does not load the current installable bundle for original-operation recovery", () => {
    const input = recovery(), expected = buildProviderDesktopWorkerPlan(input, clock);
    try {
      jest.isolateModules(() => {
        jest.doMock("../portable-provisioner-contract", () => ({
          ...jest.requireActual("../portable-provisioner-contract"), PORTABLE_HIVRA_PROVISIONER_VERSION: "2099.01.01.1",
        }));
        const future = jest.requireActual<typeof import("../provider-desktop-worker")>("../provider-desktop-worker");
        expect(future.buildProviderDesktopWorkerPlan(input, clock)).toEqual(expected);
      });
    } finally { jest.dontMock("../portable-provisioner-contract"); }
    expect(encodedRequest(expected.script)).toEqual({action: "cancel", identity: input.identity, clock});
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER - 479_999])("rejects unsafe guest clock %s", boottimeMs => {
    expect(() => buildProviderDesktopWorkerPlan(recovery(), {...clock, boottimeMs})).toThrow("Invalid provider desktop worker request");
  });
  it("parses the original strict identity without carrying access credentials", () => {
    const {identity} = recovery();
    expect(parseProviderDesktopWorkerIdentity(identity)).toEqual(identity);
    expect(() => parseProviderDesktopWorkerIdentity({...identity, tunnelToken: input.launch.tunnelToken}))
      .toThrow("Invalid provider desktop worker identity");
  });
  it("executes generated recovery wrappers against missing current, retained drift and pre-dispatch files", () => {
    const original = recovery();
    const fixture = Object.fromEntries((["status", "cancel"] as const).map(action => [action, {
      script: buildProviderDesktopWorkerPlan({...original, action}, clock).script,
      request: {action, identity: original.identity, clock},
    }]));
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-native-controller.py"], {
      encoding: "utf8", timeout: 10_000, env: {PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test"},
      input: JSON.stringify({...fixture, source: input.assets.find(file => file.relativePath === "hivra-provider-worker.py")!.content.toString("base64")}),
    });
    expect({status: result.status, stdout: result.stdout, errors: result.status === 0 ? "" : result.stderr})
      .toEqual({status: 0, stdout: "", errors: ""});
    expect(result.stderr).toContain("Ran 1 test"); // 42 actual wrapper executions.
  });
  it("separates immutable installer outcomes from current-boot desktop cleanup proof", () => {
    const {identity} = recovery();
    const line = (value: unknown) => `HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(value)}\n`;
    const pending = {version: 3, identity, state: "failed", stopped: true, desktopCleanup: {state: "pending"}};
    const stopped = {...pending, desktopCleanup: {state: "verified_stopped", bootId: clock.bootId}};
    expect(parseProviderDesktopWorkerReceipt(line(pending), identity, clock)).toEqual(pending);
    expect(parseProviderDesktopWorkerReceipt(line(stopped), identity, clock)).toEqual(stopped);
    expect(parseProviderDesktopWorkerReceipt(line({...stopped, state: "succeeded"}), identity, clock).state).toBe("succeeded");
    const notStarted = {...stopped, state: "cancelled", desktopCleanup: {state: "not_started", bootId: clock.bootId}};
    expect(parseProviderDesktopWorkerReceipt(line(notStarted), identity, clock)).toEqual(notStarted);
    for (const invalid of [line({...stopped, version: 1}), line({...stopped, state: "running", stopped: false}),
      line({...stopped, desktopCleanup: {state: "verified_stopped"}}), line({...stopped, stopped: false}),
      line({...stopped, desktopCleanup: {state: "verified_stopped", bootId: input.agentId}}),
      line({...pending, desktopCleanup: {state: "pending", bootId: clock.bootId}}), line({...notStarted, state: "succeeded"}),
      line({...stopped, identity: {...identity, operationId: input.agentId}}), line(stopped) + "\n", line(stopped) + line(stopped),
      line(stopped).replace("\n", "\r\n"), "private\n" + line(stopped)]) {
      expect(() => parseProviderDesktopWorkerReceipt(invalid, identity, clock)).toThrow("Invalid provider desktop worker receipt");
    }
  });
});
