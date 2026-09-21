import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildProviderGuestWorkerPlan, parseProviderGuestWorkerReceipt, type ProviderGuestWorkerInput } from "../provider-guest-worker";
import { providerGuestBundleManifest } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } from "../portable-provisioner-contract";
import { providerGuestWorkerRecipe } from "../provider-guest-worker-recipes";
import { receiverFixture } from "./first-boot-receiver.fixtures";

const clock = {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000};
const input: ProviderGuestWorkerInput = {
  scope: {binding: receiverFixture().binding, providerServerId: "42"},
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({relativePath,
    content: readFileSync(path.join(process.cwd(), "provisioner", relativePath))})),
  action: "start", launch: {version: 1, computerSubstrate: "provider-vm", agentKind: "codex", wantBrowser: false,
    model: "", modelKey: "fixture-model-key", modelBaseUrl: "", tunnelToken: "fixture-tunnel-token", accessHostname: null},
};

describe("private provider installer contract", () => {
  it("keeps staged guest v2 closed until server dispatch and database cleanup fences exist", () => {
    const plan = buildProviderGuestWorkerPlan(input, clock);
    const launch = {...input.launch, version: 2, agentKind: "deepseek-harness", modelKey: "", publicOrigin: "https://native.example.test"};
    expect(() => buildProviderGuestWorkerPlan({...input, launch} as never, clock)).toThrow("Invalid provider guest worker request");
    const identity = {...plan.identity, version: 2, nativeCleanup: {profile: "deepseek-owned-service-v1", closureSha256: "f".repeat(64)}};
    expect(() => buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId, operationId: input.operationId,
      identity, action: "cancel"} as never, clock)).toThrow("Invalid provider guest worker request");
  });
  it.each([
    ["2026.08.28.1", "87da03b5baf6149c4035511b9e8d0aa1ac3d03dc3f628a1e4422953135324759", 18516],
    ["2026.08.28.2", "49638f6e93d98ac6edfce3d30931ac69f9bfdcf80b10cb4939f30e07fe76a1db", 18538],
    ["2026.08.28.3", "cd18e41bdc1af2ed8fce8b7f09caf33eff06655196720096c5dce7159b33a1d1", 18554],
    ["2026.08.28.4", "7de7080b5c26ceda3beaed9af564b84ac8ae28c95fe20a9deb6caa0205923af6", 18570],
    ["2026.08.29.1", "9eb0a6ebf2b0b0f6afae24b63527ad8a3a85f792e42a18bb3dc634ddfd59820f", 18586],
    ["2026.08.29.2", "1e26ee7ad1000edab27e832a514ae09d50850adb369e90eacf20aca9cd0a4329", 18602],
    ["2026.08.29.3", "e35e7aa7c414a6645959bfb7a365057db531795c4ded0e85d928ac6fdcf262f2", 18618],
  ] as const)("retains the %s installed worker bytes for old-operation recovery", (version, hash, size) => {
    const identity = structuredClone(buildProviderGuestWorkerPlan(input, clock).identity);
    identity.bundle.provisionerVersion = version;
    const plan = buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId,
      operationId: input.operationId, identity, action: "cancel"}, clock);
    expect(plan.identity).toEqual(identity);
    expect(plan.script).toContain(hash);
    expect(plan.script).toContain(`info.st_size != ${size}`);
    expect(plan.script).not.toContain(providerGuestWorkerRecipe("2026.08.29.4").workerSha256);
  });
  it("binds the existing operation and bundle; carries no secrets in the public identity", () => {
    const plan = buildProviderGuestWorkerPlan(input, clock);
    expect(plan.identity).toMatchObject({agentId: input.agentId, operationId: input.operationId});
    expect(JSON.stringify(plan.identity)).not.toContain("fixture-model-key");
    expect(plan.script).not.toContain("fixture-model-key"); // encoded, still secret stdin; never log the script.
    expect(plan.script).toContain("hivra-provider-worker.py");
    expect(plan.script).toContain("hashlib.sha256(source)");
    expect(plan.script).not.toContain("shell=True");
    for (const action of ["status", "cancel"] as const) {
      const followup = buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId,
        operationId: input.operationId, identity: plan.identity, action}, clock);
      expect(followup.identity).toEqual(plan.identity);
      expect(followup.script).not.toContain(Buffer.from("fixture-model-key").toString("base64"));
    }
  });
  it("pins the reviewed installed controller for recovery without loading or reinstalling bundle assets", () => {
    const identity = buildProviderGuestWorkerPlan(input, clock).identity;
    const recipe = providerGuestWorkerRecipe(identity.bundle.provisionerVersion);
    for (const action of ["status", "cancel"] as const) {
      const plan = buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId,
        operationId: input.operationId, identity, action}, clock);
      expect(plan.script).toContain(recipe.workerSha256);
      expect(plan.script).toContain(`info.st_size != ${recipe.workerSize}`);
      const encoded = plan.script.match(/base64.b64decode\("([A-Za-z0-9+/=]+)"/)!;
      expect(JSON.parse(Buffer.from(encoded[1], "base64").toString())).toEqual({action, identity, clock});
      expect(plan.script).not.toMatch(/https?:|os\.rename|systemd-run/);
    }
  });
  it("retains the original control protocol after the current installable release changes", () => {
    const identity = buildProviderGuestWorkerPlan(input, clock).identity;
    const recovery = {scope: input.scope, agentId: input.agentId, operationId: input.operationId,
      identity, action: "cancel" as const};
    const expected = buildProviderGuestWorkerPlan(recovery, clock);
    try {
      jest.isolateModules(() => {
        // A simulated later application build, not a supported/published release.
        jest.doMock("../portable-provisioner-contract", () => ({
          ...jest.requireActual("../portable-provisioner-contract"), PORTABLE_HIVRA_PROVISIONER_VERSION: "2099.01.01.1",
        }));
        const future = jest.requireActual<typeof import("../provider-guest-worker")>("../provider-guest-worker");
        expect(future.buildProviderGuestWorkerPlan(recovery, clock)).toEqual(expected);
        const receipt = {version: 1, identity, state: "cancelled", stopped: true};
        expect(future.parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(receipt)}\n`, identity)).toEqual(receipt);
      });
    } finally { jest.dontMock("../portable-provisioner-contract"); }
  });
  it("executes the actual recovery wrappers and rejects changed files before compiling a worker", () => {
    const identity = buildProviderGuestWorkerPlan(input, clock).identity;
    const recovery = Object.fromEntries((["status", "cancel"] as const).map(action => [action, {
      script: buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId,
        operationId: input.operationId, identity, action}, clock).script,
      request: {action, identity, clock},
    }]));
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-worker-controller.py"], {
      encoding: "utf8", timeout: 10_000, env: {PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test"},
      input: JSON.stringify({...recovery, source: input.assets.find(file => file.relativePath === "hivra-provider-worker.py")!.content.toString("base64")}),
    });
    expect({status: result.status, output: result.stdout, errors: result.status === 0 ? "" : result.stderr})
      .toEqual({status: 0, output: "", errors: ""});
    expect(result.stderr).toContain("Ran 1 test"); // 16 actual wrapper executions.
  });
  it.each(["agent", "operation", "scope", "unknown_version", "same_version_changed_worker"])("rejects %s before constructing a recovery command", field => {
    const identity = structuredClone(buildProviderGuestWorkerPlan(input, clock).identity);
    if (field === "agent") identity.agentId = input.operationId;
    if (field === "operation") identity.operationId = input.agentId;
    if (field === "scope") identity.bundle.scopeSha256 = "f".repeat(64);
    if (field === "unknown_version") identity.bundle.provisionerVersion = "2099.01.01.1" as never;
    if (field === "same_version_changed_worker") {
      const changed = input.assets.map(asset => asset.relativePath === "hivra-provider-worker.py"
        ? {...asset, content: Buffer.alloc(asset.content.length)} : asset);
      expect(() => buildProviderGuestWorkerPlan({...input, assets: changed}, clock)).toThrow("Invalid provider guest worker request");
    } else {
      expect(() => buildProviderGuestWorkerPlan({scope: input.scope, agentId: input.agentId,
        operationId: input.operationId, identity, action: "cancel"}, clock)).toThrow("Invalid provider guest worker request");
    }
  });
  it.each(["agent", "operation", "runtime", "tunnel", "model", "substrate", "bundle", "clock"])("rejects invalid %s without raw input errors", field => {
    const value = {...input, launch: {...input.launch}, assets: [...input.assets]};
    if (field === "agent") value.agentId = "../../private";
    if (field === "operation") value.operationId = "bad";
    if (field === "runtime") value.launch.agentKind = "unknown" as never;
    if (field === "tunnel") value.launch.tunnelToken = "token\nsecret";
    if (field === "model") value.launch.modelKey = "secret\nvalue";
    if (field === "substrate") value.launch.computerSubstrate = "proxmox-kvm" as never;
    if (field === "bundle") value.assets.pop();
    expect(() => buildProviderGuestWorkerPlan(value, field === "clock" ? {...clock, boottimeMs: -1} : clock))
      .toThrow("Invalid provider guest worker request");
  });
  it("requires exact identity, framing and truthful stopped state", () => {
    const identity = buildProviderGuestWorkerPlan(input, clock).identity;
    const value = {version: 1, identity, state: "succeeded", stopped: true};
    const line = (v: unknown) => `HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(v)}\n`;
    expect(parseProviderGuestWorkerReceipt(line(value), identity)).toEqual(value);
    for (const invalid of [line({...value, stopped: false}), line({...value, state: "running"}), line({...value, state: "ready"}),
      line({...value, identity: {...identity, operationId: input.agentId}}), line(value) + "\n", line(value) + line(value),
      line(value).replace("\n", "\r\n"), "private\n" + line(value)]) {
      expect(() => parseProviderGuestWorkerReceipt(invalid, identity)).toThrow("Invalid provider guest worker receipt");
    }
  });
  it("executes the actual worker parsing, filesystem and lifecycle regression harness", () => {
    const plan = buildProviderGuestWorkerPlan(input, clock);
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-guest-worker.py"], {
      encoding: "utf8", timeout: 30_000, env: {PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test"},
      input: JSON.stringify({action: "start", identity: plan.identity, clock, launch: input.launch,
        manifest: providerGuestBundleManifest(input.scope, input.assets)}),
    });
    expect({status: result.status, output: result.stdout, errors: result.status === 0 ? "" : result.stderr})
      .toEqual({status: 0, output: "", errors: ""});
    expect(result.stderr).toContain("Ran 40 tests");
  });
});
