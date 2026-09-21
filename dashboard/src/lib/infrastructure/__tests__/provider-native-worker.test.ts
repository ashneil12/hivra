import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProviderNativeWorkerPlan, parseProviderNativeWorkerIdentity, parseProviderNativeWorkerReceipt, type ProviderNativeWorkerInput } from "../provider-native-worker";
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
  action: "start" as const, journaledHostname: "native.example.test",
  launch: {version: 2 as const, computerSubstrate: "provider-vm" as const, agentKind: "deepseek-harness" as const, wantBrowser: false,
    model: "" as const, modelKey: "" as const, modelBaseUrl: "" as const,
    tunnelToken: "fixture-private-tunnel", accessHostname: null, publicOrigin: "https://native.example.test"},
};
const recovery = () => ({scope: input.scope, agentId: input.agentId, operationId: input.operationId,
  action: "cancel" as const, identity: buildProviderNativeWorkerPlan(input, clock).identity});
const historicalRecovery = () => {
  const value = structuredClone(recovery());
  value.identity.bundle.provisionerVersion = "2026.08.31.3" as "2026.09.02.8";
  value.identity.bundle.bundleSha256 = "8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec";
  return value;
};
const previousRecovery = () => {
  const value = structuredClone(recovery());
  value.identity.bundle.provisionerVersion = "2026.09.01.8" as "2026.09.02.8";
  value.identity.bundle.bundleSha256 = "d641a55cb724a59abf5f5453b44bd00a4078be923956b5b82f11a0fd2fbcb4e0";
  return value;
};
const encodedRequest = (script: string) => JSON.parse(Buffer.from(script.match(/base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1], "base64").toString());

describe("staged private native provider controller", () => {
  it("keeps .06.3 recovery on its sealed worker after prepared-image release", () => {
    const request = recovery(), prior = parseProviderNativeWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.3", bundleSha256: "5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef" } });
    const plan = buildProviderNativeWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52");
    expect(plan.script).not.toContain("ce7b372f50ce3aa27bc1efa8fe1a08167ff477cec381a4ef9f93142c1e8b832e");
  });


  it("keeps .06.2 recovery on its sealed worker after prepared-image release", () => {
    const request = recovery(), prior = parseProviderNativeWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.2", bundleSha256: "9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee" } });
    const plan = buildProviderNativeWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711");
    expect(plan.script).not.toContain("19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52");
  });

  it("keeps .06.1 recovery on its sealed worker after prepared-image release", () => {
    const request = recovery(), prior = parseProviderNativeWorkerIdentity({ ...request.identity, bundle: { ...request.identity.bundle,
      provisionerVersion: "2026.09.06.1", bundleSha256: "61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c" } });
    const plan = buildProviderNativeWorkerPlan({ ...request, identity: prior }, clock);
    expect(plan.identity).toEqual(prior);
    expect(plan.script).toContain("0479130b44b65eb4d41e6c35a076ae119da81057589fa1ea1587fc110b06db8e");
    expect(plan.script).not.toContain("2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711");
  });
  it("binds exact release and native closure bytes without changing public v1 admission", () => {
    const plan = buildProviderNativeWorkerPlan(input, clock), manifest = providerGuestBundleManifest(input.scope, input.assets);
    const rows = manifest.filter(row => row.path.startsWith("deepseek-harness/")
      && ["bux-hivra-chat.service", "install-native.py", "service-owner.py"].includes(row.path.split("/")[1]))
      .map(row => [row.path, row.sha256, row.size, row.mode]);
    expect(plan.identity.nativeCleanup).toEqual({profile: "deepseek-owned-service-v1",
      closureSha256: createHash("sha256").update(JSON.stringify(rows) + "\n").digest("hex")});
    expect(encodedRequest(plan.script)).toEqual({action: "start", identity: plan.identity, clock, manifest, launch: input.launch});
    expect(JSON.stringify(plan.identity)).not.toContain("fixture-private-tunnel");
    expect(plan.script).not.toContain("fixture-private-tunnel"); // Still private stdin, NEVER log scripts.
    expect(() => buildProviderGuestWorkerPlan(input as never, clock)).toThrow("Invalid provider guest worker request");
    expect(() => buildProviderGuestWorkerPlan(recovery() as never, clock)).toThrow("Invalid provider guest worker request");
  });
  it("requires the actual Python parser and native closure validator to accept the generated document", () => {
    const request = encodedRequest(buildProviderNativeWorkerPlan(input, clock).script);
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "-c", `import json, runpy, sys
worker = runpy.run_path("provisioner/hivra-provider-worker.py", run_name="fixture_worker")
installer = runpy.run_path("provisioner/hivra-install-agent.py", run_name="fixture_installer")
request = json.load(sys.stdin)
expected = worker["identity"](request["identity"])
worker["native_rows"](expected, request["manifest"])
worker["check_launch"](expected, installer["parse_launch"](worker["encode"](request["launch"])))
`], {input: JSON.stringify(request), encoding: "utf8", timeout: 10_000});
    expect({status: result.status, stdout: result.stdout, stderr: result.stderr}).toEqual({status: 0, stdout: "", stderr: ""});
  });
  it.each(["modelKey", "modelBaseUrl", "model", "substrate", "kind", "version", "origin", "journaled", "extra", "both_access", "no_access"])(
    "rejects invalid %s before a command is produced", field => {
      const value = structuredClone(input) as unknown as {launch: Record<string, unknown>; journaledHostname: string; assets: typeof input.assets};
      value.assets = input.assets;
      if (["modelKey", "modelBaseUrl", "model"].includes(field)) value.launch[field] = "private-value";
      if (field === "substrate") value.launch.computerSubstrate = "proxmox-kvm";
      if (field === "kind") value.launch.agentKind = "codex";
      if (field === "version") value.launch.version = 1;
      if (field === "origin") value.launch.publicOrigin = "https://other.example.test";
      if (field === "journaled") value.journaledHostname = "other.example.test";
      if (field === "extra") value.launch.command = "arbitrary";
      if (field === "both_access") value.launch.accessHostname = "8-8-8-8.sslip.io";
      if (field === "no_access") value.launch.tunnelToken = null;
      expect(() => buildProviderNativeWorkerPlan(value as ProviderNativeWorkerInput, clock)).toThrow("Invalid provider native worker request");
    });
  it.each(["http://native.example.test", "https://native.example.test/", "https://native.example.test:443", "https://user@native.example.test",
    "https://Native.example.test", "https://xn--bcher-kva.example.test", "https://native.example.test?key=value", "https://native.example.test\n"])(
    "rejects non-canonical native origin %s", publicOrigin => {
      expect(() => buildProviderNativeWorkerPlan({...input, launch: {...input.launch, publicOrigin}}, clock)).toThrow();
    });
  it("binds standalone direct HTTPS too and validates address octets", () => {
    const direct = {...input, journaledHostname: "8-8-8-8.sslip.io", launch: {...input.launch,
      tunnelToken: null, accessHostname: "8-8-8-8.sslip.io", publicOrigin: "https://8-8-8-8.sslip.io"}};
    expect(buildProviderNativeWorkerPlan(direct, clock).identity.version).toBe(2);
    for (const hostname of ["203-0-113-9.sslip.io", "256-8-8-8.sslip.io", "008-8-8-8.sslip.io"]) {
      expect(() => buildProviderNativeWorkerPlan({...direct, launch: {...direct.launch, accessHostname: hostname}}, clock)).toThrow();
    }
  });
  it.each(["hivra-provider-worker.py", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py", "deepseek-harness/bux-hivra-chat.service", "README.md", "VERSION"])(
    "rejects drift in exact pinned release file %s", filename => {
      const assets = input.assets.map(asset => asset.relativePath === filename ? {...asset, content: Buffer.alloc(asset.content.length)} : asset);
      expect(() => buildProviderNativeWorkerPlan({...input, assets}, clock)).toThrow();
    });
  it.each(["operation", "agent", "scope", "bundle", "closure", "profile", "old_version", "extra"])("rejects recovery identity drift: %s", field => {
    const value = recovery();
    if (field === "operation") value.identity.operationId = input.agentId;
    if (field === "agent") value.identity.agentId = input.operationId;
    if (field === "scope") value.identity.bundle.scopeSha256 = "f".repeat(64);
    if (field === "bundle") value.identity.bundle.bundleSha256 = "f".repeat(64);
    if (field === "closure") value.identity.nativeCleanup.closureSha256 = "f".repeat(64);
    if (field === "profile") Object.assign(value.identity.nativeCleanup, {profile: "other"});
    if (field === "old_version") Object.assign(value.identity.bundle, {provisionerVersion: "2026.08.31.2"});
    if (field === "extra") Object.assign(value.identity, {command: "private"});
    expect(() => buildProviderNativeWorkerPlan(value, clock)).toThrow();
  });
  it("does not load the current installable bundle for original-operation recovery", () => {
    const input = recovery(), expected = buildProviderNativeWorkerPlan(input, clock);
    try {
      jest.isolateModules(() => {
        jest.doMock("../portable-provisioner-contract", () => ({
          ...jest.requireActual("../portable-provisioner-contract"), PORTABLE_HIVRA_PROVISIONER_VERSION: "2099.01.01.1",
        }));
        const future = jest.requireActual<typeof import("../provider-native-worker")>("../provider-native-worker");
        expect(future.buildProviderNativeWorkerPlan(input, clock)).toEqual(expected);
      });
    } finally { jest.dontMock("../portable-provisioner-contract"); }
    expect(encodedRequest(expected.script)).toEqual({action: "cancel", identity: input.identity, clock});
  });
  it("retains the exact historical .31.3 controller for status and cancellation", () => {
    const original = historicalRecovery();
    expect(parseProviderNativeWorkerIdentity(original.identity)).toEqual(original.identity);
    for (const action of ["status", "cancel"] as const) {
      const plan = buildProviderNativeWorkerPlan({...original, action}, clock);
      expect(plan.script).toContain("61229d0fa5a6383ab42f3a77967d0db9bcc2a5242eba91e900c4851b2a3f2b9f");
      expect(plan.script).not.toContain("431fec069ebcb7a2187765825c9b3c699c4f5d187e38cab33358bacdd680a35e");
      expect(encodedRequest(plan.script)).toEqual({action, identity: original.identity, clock});
    }
    for (const identity of [
      {...original.identity, bundle: {...original.identity.bundle, bundleSha256: recovery().identity.bundle.bundleSha256}},
      {...recovery().identity, bundle: {...recovery().identity.bundle, bundleSha256: original.identity.bundle.bundleSha256}},
    ]) expect(() => parseProviderNativeWorkerIdentity(identity)).toThrow("Invalid provider native worker identity");
  });
  it("retains the exact immediately previous controller for lifecycle recovery", () => {
    const original = previousRecovery();
    expect(parseProviderNativeWorkerIdentity(original.identity)).toEqual(original.identity);
    for (const action of ["status", "cancel"] as const) {
      const plan = buildProviderNativeWorkerPlan({...original, action}, clock);
      expect(plan.script).toContain("727cb210537ade86c19498283eda3d4f455f3441be48cdde9a3fcdab686c9e27");
      expect(plan.script).not.toContain("cb3e1d5e37cc911dacb8b2abd2cd9ec19acec496848c9e0446efeec82496b598");
      expect(encodedRequest(plan.script)).toEqual({action, identity: original.identity, clock});
    }
  });
  it("executes generated recovery wrappers against missing current, retained drift and pre-dispatch files", () => {
    const original = recovery();
    const fixture = Object.fromEntries((["status", "cancel"] as const).map(action => [action, {
      script: buildProviderNativeWorkerPlan({...original, action}, clock).script,
      request: {action, identity: original.identity, clock},
    }]));
    // A captured macOS timeout was inside sys.stdin.read(), before wrapper
    // execution. A regular input FD avoids pipe EOF stalls without weakening
    // the same ten-second deadline or any of the 42 recovery assertions.
    const directory = mkdtempSync(path.join(tmpdir(), "hivra-native-wrapper-fixture-"));
    let descriptor: number | undefined;
    try {
      const filename = path.join(directory, "fixture.json");
      writeFileSync(filename, JSON.stringify({...fixture,
        source: input.assets.find(file => file.relativePath === "hivra-provider-worker.py")!.content.toString("base64")}),
      { mode: 0o600, flag: "wx" });
      descriptor = openSync(filename, "r");
      const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-native-controller.py"], {
        encoding: "utf8", timeout: 10_000, env: {PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test"},
        stdio: [descriptor, "pipe", "pipe"],
      });
      expect({status: result.status, stdout: result.stdout, errors: result.status === 0 ? "" : result.stderr})
        .toEqual({status: 0, stdout: "", errors: ""});
      expect(result.stderr).toContain("Ran 1 test"); // 42 actual wrapper executions.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("executes historical .31.3 retained-controller wrappers against the historical worker bytes", () => {
    const original = historicalRecovery();
    const fixture = Object.fromEntries((["status", "cancel"] as const).map(action => [action, {
      script: buildProviderNativeWorkerPlan({...original, action}, clock).script,
      request: {action, identity: original.identity, clock},
    }]));
    // Historical controller bytes are immutable; the current v3 worker is no
    // longer the historical program with only its version string changed.
    const source = readFileSync(path.join(process.cwd(), "scripts/fixtures/provider-worker-2026.08.31.3.py"));
    expect(createHash("sha256").update(source).digest("hex")).toBe("61229d0fa5a6383ab42f3a77967d0db9bcc2a5242eba91e900c4851b2a3f2b9f");
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-native-controller.py"], {
      encoding: "utf8", timeout: 10_000, env: {PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test"},
      input: JSON.stringify({...fixture, source: source.toString("base64")}),
    });
    expect({status: result.status, stdout: result.stdout, errors: result.status === 0 ? "" : result.stderr})
      .toEqual({status: 0, stdout: "", errors: ""});
  });
  it("separates immutable installer outcomes from current-boot native cleanup proof", () => {
    const {identity} = recovery();
    const line = (value: unknown) => `HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(value)}\n`;
    const pending = {version: 2, identity, state: "failed", stopped: true, nativeCleanup: {state: "pending"}};
    const stopped = {...pending, nativeCleanup: {state: "verified_stopped", bootId: clock.bootId}};
    expect(parseProviderNativeWorkerReceipt(line(pending), identity, clock)).toEqual(pending);
    expect(parseProviderNativeWorkerReceipt(line(stopped), identity, clock)).toEqual(stopped);
    expect(parseProviderNativeWorkerReceipt(line({...stopped, state: "succeeded"}), identity, clock).state).toBe("succeeded");
    const notStarted = {...stopped, state: "cancelled", nativeCleanup: {state: "not_started", bootId: clock.bootId}};
    expect(parseProviderNativeWorkerReceipt(line(notStarted), identity, clock)).toEqual(notStarted);
    for (const invalid of [line({...stopped, version: 1}), line({...stopped, state: "running", stopped: false}),
      line({...stopped, nativeCleanup: {state: "verified_stopped"}}), line({...stopped, stopped: false}),
      line({...stopped, nativeCleanup: {state: "verified_stopped", bootId: input.agentId}}),
      line({...pending, nativeCleanup: {state: "pending", bootId: clock.bootId}}), line({...notStarted, state: "succeeded"}),
      line({...stopped, identity: {...identity, operationId: input.agentId}}), line(stopped) + "\n", line(stopped) + line(stopped),
      line(stopped).replace("\n", "\r\n"), "private\n" + line(stopped)]) {
      expect(() => parseProviderNativeWorkerReceipt(invalid, identity, clock)).toThrow("Invalid provider native worker receipt");
    }
  });
});
