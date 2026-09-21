/** @jest-environment node */
import { launchProviderAgent, ProviderAgentLaunchError, type ProviderAgentLaunchInput } from "../provider-agent-launch";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import { receiverFixture, firstBootNow } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { guestDiscoveryOutput } from "@/lib/infrastructure/__tests__/provider-guest-discovery.fixtures";
import { providerGuestBundleReceipt } from "@/lib/infrastructure/provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import { createLaunchModelAdmissionService } from "../launch-model-admission";
import type { LaunchModelStore } from "../launch-model-store";

function setup() {
  const f = receiverFixture(), scope = { binding: f.binding, providerServerId: "42" };
  const target = providerVmTarget();
  const assets = PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
    content: Buffer.from(relativePath === "VERSION" ? PORTABLE_HIVRA_PROVISIONER_VERSION : "fixture:" + relativePath) }));
  const receipt = providerGuestBundleReceipt(scope, assets);
  Object.assign(target, { connectionId: f.binding.connectionId, evidenceConnectionRevision: 7, status: "ready", lastErrorCode: null });
  Object.assign(target.capabilities, { capacityOrderId: f.binding.orderId, enrollmentAttemptId: f.binding.attemptId,
    hostIdentityDigest: Buffer.from(f.host.fingerprintSha256.slice(7), "base64").toString("hex"), launchReady: true });
  Object.assign(target.capabilities.provisioner, { ready: true, bundleSha256: receipt.bundleSha256, scopeSha256: receipt.scopeSha256 });
  const input: ProviderAgentLaunchInput = { userId: "owner", targetId: target.id, connectionId: f.binding.connectionId,
    expectedConnectionRevision: 7, type: "codex", name: "My agent", browser: false,
    goal: null, context: null, personality: null, emoji: null, managedVenice: false, llm: null, templateSkills: [] };
  let elapsed = 0, saved: Record<string, unknown> | null = null;
  const ids = ["55555555-5555-4555-8555-555555555555", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const order = { operation: { id: f.binding.orderId, connectionId: f.binding.connectionId,
    status: "created_off", providerServerId: "42", quote: f.evidence.quote_snapshot },
    connectionRevision: 7, quoteFingerprintSha256: f.binding.quoteFingerprint, cleanup: null };
  const deps = {
    target: jest.fn(async () => structuredClone(target)),
    connection: jest.fn(async () => ({ id: f.binding.connectionId, provider: "hetzner-cloud", status: "ready", revision: 7 }) as never),
    order: jest.fn(async () => structuredClone(order) as never),
    boot: jest.fn(async () => ({ ...scope } as FirstBootOperation)), bundle: jest.fn(async () => assets),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope, address: "203.0.113.10",
      hostPublicKey: f.host.publicKey, hostFingerprintSha256: f.host.fingerprintSha256,
      capacityIdempotencyKey: f.stored.capacityIdempotencyKey, observedAt: firstBootNow.toISOString(),
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture-admin", privateKeyOpenSsh: "private-fixture-admin" }) as never),
    inspect: jest.fn(async () => ({ hostVerified: true as const, administratorAuthenticated: true as const,
      hostFingerprintSha256: f.host.fingerprintSha256, output: guestDiscoveryOutput() })),
    accessConfigured: jest.fn(() => true),
    localMode: jest.fn(() => false),
    reserve: jest.fn(async (row: Record<string, unknown>) => { saved = structuredClone(row); return structuredClone(row); }),
    current: jest.fn(async () => { if (!saved) throw new Error("not found"); return structuredClone(saved); }),
    tunnel: jest.fn(async () => ({ token: "private-fixture-tunnel", tunnelId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      hostname: "box-fixture.example.com", url: "https://box-fixture.example.com", dnsRecordId: "fixture-dns" })),
    directAccess: jest.fn(async () => ({ mode: "direct-https" as const, hostname: "203-0-113-10.sslip.io",
      origin: "https://203-0-113-10.sslip.io", tunnelId: null, tunnelToken: null })),
    installer: jest.fn(async () => ({ stage: "worker_observed" as const, state: "running" as const, stopped: false })),
    nativeInstaller: jest.fn(async () => ({ stage: "worker_observed" as const, state: "running" as const,
      stopped: false, nativeCleanup: "pending" as const, cleanupRecorded: false, cancellationRequested: false })),
    desktopInstaller: jest.fn(async () => ({ stage: "worker_observed" as const, state: "running" as const,
      stopped: false, desktopCleanup: "pending" as const, cleanupRecorded: false, cancellationRequested: false })),
    controlOrigin: jest.fn(() => "https://canary.hermesos.cloud"),
    failure: jest.fn(async () => true),
    newId: jest.fn(() => ids.shift()!), bindingHash: () => "c".repeat(64), now: () => firstBootNow, monotonicNow: () => elapsed,
  };
  return { f, target, input, order, deps, save: (value: Record<string, unknown>) => { saved = value; },
    advance: (ms: number) => { elapsed = ms; } };
}

it.each(["claude-code", "codex", "aeon", "openclaw", "agent-zero"] as const)("reserves the original whole computer for %s, then starts the original installer", async type => {
  const h = setup(); h.input.type = type;
  const result = await launchProviderAgent(h.input, h.deps);
  expect(h.deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: "owner", type, status: "provisioning", desired_state: "running", computer_substrate: "provider-vm",
    vmid: null, cpu: 2, ram: 4, pool_id: null, deployment_mode: "self-managed",
    proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, provider_capacity_order_id: h.f.binding.orderId,
    provider_enrollment_attempt_id: h.f.binding.attemptId, provider_server_id: "42",
    allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", infrastructure_binding_token_enforced: true }));
  expect(h.deps.inspect.mock.invocationCallOrder[0]).toBeLessThan(h.deps.reserve.mock.invocationCallOrder[0]);
  expect(h.deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.deps.tunnel.mock.invocationCallOrder[0]);
  expect(h.deps.tunnel.mock.invocationCallOrder[0]).toBeLessThan(h.deps.installer.mock.invocationCallOrder[0]);
  expect(h.deps.installer).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner",
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", action: "start",
    launch: { version: 1, computerSubstrate: "provider-vm", agentKind: type === "claude-code" ? "claude" : type,
      modelKey: "", modelBaseUrl: "", model: "", wantBrowser: false,
      tunnelToken: "private-fixture-tunnel", accessHostname: null } }));
  expect(result.agent).toMatchObject({ status: "provisioning", type, cpu: 2, ram: 4 });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|binding_token|operation_id/);
});

it.each([false, true])("stages DeepSeek Harness through the native v2 installer with its exact %s access origin", async standalone => {
  const h = setup(); h.input.type = "deepseek-harness";
  if (standalone) { h.deps.localMode.mockReturnValue(true); h.deps.accessConfigured.mockReturnValue(false); }
  const result = await launchProviderAgent(h.input, h.deps);
  expect(h.deps.installer).not.toHaveBeenCalled();
  expect(h.deps.nativeInstaller).toHaveBeenCalledWith(expect.objectContaining({ action: "start", launch: {
    version: 2, computerSubstrate: "provider-vm", agentKind: "deepseek-harness", wantBrowser: false,
    modelKey: "", modelBaseUrl: "", model: "",
    tunnelToken: standalone ? null : "private-fixture-tunnel",
    accessHostname: standalone ? "203-0-113-10.sslip.io" : null,
    publicOrigin: standalone ? "https://203-0-113-10.sslip.io" : "https://box-fixture.example.com",
  } }));
  expect(result.agent).toMatchObject({ type: "deepseek-harness", status: "provisioning", cpu: 2, ram: 4 });
});

function desktopSetup() {
  const h = setup(); h.input.type = "linux-desktop"; h.input.computerProfile = "ubuntu-desktop";
  h.order.operation.quote.serverType.memoryGb = 8;
  h.deps.inspect.mockImplementation(async () => ({ hostVerified: true, administratorAuthenticated: true,
    hostFingerprintSha256: h.f.host.fingerprintSha256,
    output: guestDiscoveryOutput({ MEMORY_TOTAL_BYTES: String(8 * 1024 ** 3), MEMORY_AVAILABLE_BYTES: String(7 * 1024 ** 3) }) }));
  return h;
}
it("reserves the server launch journal operation so a lost bind response is recoverable",async()=>{
  const h=desktopSetup();h.input.launchOperationId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await launchProviderAgent(h.input,h.deps);
  expect(h.deps.reserve).toHaveBeenCalledWith(expect.objectContaining({operation_id:h.input.launchOperationId,allocation_operation_id:h.input.launchOperationId}));
  expect(h.deps.desktopInstaller).toHaveBeenCalledWith(expect.objectContaining({operationId:h.input.launchOperationId}));
});
it.each([false, true])("stages explicit Ubuntu through private v3 with server-bound identity and %s direct access", async standalone => {
  const h = desktopSetup();
  if (standalone) { h.deps.localMode.mockReturnValue(true); h.deps.accessConfigured.mockReturnValue(false); }
  const result = await launchProviderAgent(h.input, h.deps);
  expect(h.deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ type: "linux-desktop", computer_profile: "ubuntu-desktop", cpu: 2, ram: 8, vmid: null }));
  expect(h.deps.desktopInstaller).toHaveBeenCalledWith(expect.objectContaining({ action: "start", launch: {
    version: 3, computerSubstrate: "provider-vm", agentKind: "linux-desktop", wantBrowser: null,
    computerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", controlOrigin: "https://canary.hermesos.cloud",
    modelKey: "", modelBaseUrl: "", model: "", tunnelToken: standalone ? null : "private-fixture-tunnel",
    accessHostname: standalone ? "203-0-113-10.sslip.io" : null,
    publicOrigin: standalone ? "https://203-0-113-10.sslip.io" : "https://box-fixture.example.com",
  } }));
  expect(h.deps.installer).not.toHaveBeenCalled(); expect(h.deps.nativeInstaller).not.toHaveBeenCalled();
  expect(result.agent).toMatchObject({ type: "linux-desktop", status: "provisioning", cpu: 2, ram: 8 });
});
it.each(["quote", "total", "available", "cpu"])("rejects undersized desktop %s before reservation or access", async size => {
  const h = desktopSetup();
  if (size === "quote") h.order.operation.quote.serverType.memoryGb = 4;
  else h.deps.inspect.mockImplementation(async () => ({ hostVerified: true, administratorAuthenticated: true,
    hostFingerprintSha256: h.f.host.fingerprintSha256, output: guestDiscoveryOutput({
      MEMORY_TOTAL_BYTES: String((size === "total" ? 4 : 8) * 1024 ** 3),
      MEMORY_AVAILABLE_BYTES: String((size === "total" ? 3 : size === "available" ? 5 : 7) * 1024 ** 3),
      CPU_LOGICAL_CORES: size === "cpu" ? "1" : "2" }) }));
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "capacity" });
  expect(h.deps.reserve).not.toHaveBeenCalled(); expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.desktopInstaller).not.toHaveBeenCalled();
});
it.each(["2026.09.05.5", "2026.09.05.6"])("rejects desktop predecessor %s before provider access", async version => {
  const h = desktopSetup(); h.target.capabilities.provisioner.version = version;
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "not_ready" });
  expect(h.deps.verify).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});
it.each(["", "https://canary.hermesos.cloud/path", "http://canary.hermesos.cloud", "https://canary.hermesos.cloud?bypass=private"])("rejects invalid desktop control origin %s before target lookup", async origin => {
  const h = desktopSetup(); h.deps.controlOrigin.mockReturnValue(origin);
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "access" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});
it.each(["profile", "browser", "browser-origin"])("rejects invalid desktop request %s before allocation", async field => {
  const h = desktopSetup();
  if (field === "profile") delete h.input.computerProfile;
  if (field === "browser") h.input.browser = true;
  if (field === "browser-origin") Object.assign(h.input, { controlOrigin: "https://attacker.example.com" });
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toThrow();
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});
it.each(["profile", "runtime"])("does not adopt a desktop reservation with changed %s", async field => {
  const h = desktopSetup();
  h.deps.reserve.mockImplementation(async row => {
    const changed = { ...row, ...(field === "profile" ? { computer_profile: "omarchy" } : { type: "codex" }) };
    h.save(changed); return changed;
  });
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "unconfirmed" });
  expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.desktopInstaller).not.toHaveBeenCalled();
});
it("retains the original desktop after uncertain dispatch without claiming running or retrying", async () => {
  const h = desktopSetup(); h.deps.desktopInstaller.mockRejectedValue(new Error("private transport details"));
  const result = await launchProviderAgent(h.input, h.deps);
  expect(result.agent).toMatchObject({ type: "linux-desktop", status: "provisioning" });
  expect(h.deps.reserve).toHaveBeenCalledTimes(1); expect(h.deps.desktopInstaller).toHaveBeenCalledTimes(1);
  expect(h.deps.failure).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.deps.failure.mock.calls)).not.toContain("private transport details");
});
it("rejects automatic BYOK delivery before allocation and directs the owner to native setup", async () => {
  const h = setup(); h.input.llm = { provider: "venice", mode: "byok", apiKey: "private-fixture-model", model: "test-model" };
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "model" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
  expect(h.deps.installer).not.toHaveBeenCalled();
});

it.each(["managed", "opt_in", "invalid_key", "unsupported"])("rejects %s model configuration without opening infrastructure or reserving resources", async kind => {
  const h = setup();
  if (kind === "managed") h.input.llm = { provider: "venice", mode: "managed" };
  if (kind === "opt_in") h.input.managedVenice = true;
  if (kind === "invalid_key") h.input.llm = { provider: "venice", mode: "byok", apiKey: "" };
  if (kind === "unsupported") h.input.llm = { provider: "unreviewed", mode: "byok", apiKey: "private" };
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "model" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});

it("rejects unsupported template delivery before reserving a computer", async () => {
  const h = setup(); h.input.templateSkills = ["example-skill"];
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "template" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});

it.each([
  ["openclaw", "fixture/model", "fixture-key"], ["openclaw", "valid-model", "fixture key"],
  ["agent-zero", "valid-model", "fixture.key"],
] as const)("rejects %s configuration the native installer cannot write", async (type, model, apiKey) => {
  const h = setup(); h.input.type = type; h.input.llm = { provider: "venice", mode: "byok", model, apiKey };
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "model" });
  expect(h.deps.reserve).not.toHaveBeenCalled(); expect(h.deps.target).not.toHaveBeenCalled();
});

it.each(["target", "connection", "revision", "server", "order", "enrollment", "bundle", "scope", "version", "not_ready"])("rejects changed %s before credentials or reservation", async kind => {
  const h = setup();
  if (kind === "target") h.target.id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  if (kind === "connection") h.target.connectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  if (kind === "revision") h.target.evidenceConnectionRevision++;
  if (kind === "server") h.target.externalId = "43";
  if (kind === "order") h.target.capabilities.capacityOrderId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  if (kind === "enrollment") h.target.capabilities.enrollmentAttemptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  if (kind === "bundle") h.target.capabilities.provisioner.bundleSha256 = "f".repeat(64);
  if (kind === "scope") h.target.capabilities.provisioner.scopeSha256 = "f".repeat(64);
  if (kind === "version") h.target.capabilities.provisioner.version = "2026.08.27.1";
  if (kind === "not_ready") { h.target.status = "unavailable"; h.target.capabilities.launchReady = false; h.target.lastErrorCode = "PROVIDER_ADAPTER_UNAVAILABLE"; }
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "not_ready" });
  expect(h.deps.bootstrap).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});

it.each<Record<string, string>>([{ CPU_LOGICAL_CORES: "1" }, { MEMORY_AVAILABLE_BYTES: "500000000" },
  { ROOT_STORAGE_AVAILABLE_BYTES: "1000000000" }])("requires fresh resource headroom: %j", async changes => {
  const h = setup(); h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true,
    hostFingerprintSha256: h.f.host.fingerprintSha256, output: guestDiscoveryOutput(changes) });
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "capacity" });
  expect(h.deps.reserve).not.toHaveBeenCalled();
});

it.each(["target", "connection", "order", "boot", "bundle", "verify", "bootstrap", "inspect"] as const)("fails closed on %s failure, without exposing its details", async stage => {
  const h = setup(); h.deps[stage].mockRejectedValue(new Error("private-fixture-secret"));
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toThrow("This cloud computer is not ready for launch.");
  expect(h.deps.reserve).not.toHaveBeenCalled(); expect(h.deps.tunnel).not.toHaveBeenCalled();
});

it("does not reserve after a late preflight", async () => {
  const h = setup(); h.deps.inspect.mockImplementation(async () => { h.advance(30000); return {
    hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: h.f.host.fingerprintSha256, output: guestDiscoveryOutput() }; });
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "not_ready" });
  expect(h.deps.reserve).not.toHaveBeenCalled();
});

it("requires configured named access before spending or reservation", async () => {
  const h = setup(); h.deps.accessConfigured.mockReturnValue(false);
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "access" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(h.deps.reserve).not.toHaveBeenCalled();
});

it("standalone mode binds direct HTTPS after reservation without a platform tunnel credential", async () => {
  const h = setup(); h.deps.localMode.mockReturnValue(true); h.deps.accessConfigured.mockReturnValue(false);
  await expect(launchProviderAgent(h.input, h.deps)).resolves.toMatchObject({ agent: { status: "provisioning" } });
  expect(h.deps.accessConfigured).not.toHaveBeenCalled();
  expect(h.deps.tunnel).not.toHaveBeenCalled();
  expect(h.deps.directAccess).toHaveBeenCalledWith({ userId: "owner",
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    address: "203.0.113.10" });
  expect(h.deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.deps.directAccess.mock.invocationCallOrder[0]);
  expect(h.deps.installer).toHaveBeenCalledWith(expect.objectContaining({ launch: expect.objectContaining({
    tunnelToken: null, accessHostname: "203-0-113-10.sslip.io",
  }) }));
});

it("does not repeat an unacknowledged reservation or dispatch even if that exact row committed", async () => {
  const h = setup(); h.deps.reserve.mockImplementation(async row => { h.save(structuredClone(row)); throw new Error("lost response"); });
  expect(await launchProviderAgent(h.input, h.deps)).toMatchObject({ agent: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "provisioning" } });
  expect(h.deps.reserve).toHaveBeenCalledTimes(1); expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
});

it("does not create a tunnel after a conflicting computer reservation", async () => {
  const h = setup(); h.deps.reserve.mockRejectedValue(new ProviderAgentLaunchError("conflict"));
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "conflict" });
  expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
});

it.each(["tunnel", "installer"] as const)("retains the original operation after an uncertain %s; no retry, replacement or running claim", async stage => {
  const h = setup(); h.deps[stage].mockRejectedValue(new Error("private-fixture-secret"));
  const result = await launchProviderAgent(h.input, h.deps);
  expect(result.agent.status).toBe("provisioning"); expect(h.deps[stage]).toHaveBeenCalledTimes(1);
  expect(h.deps.failure).toHaveBeenCalledWith(expect.objectContaining({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  if (stage === "tunnel") expect(h.deps.installer).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-fixture");
});

it("does not return an unrelated reloaded agent", async () => {
  const h = setup(); h.deps.current.mockResolvedValue({ id: "foreign", user_id: "owner" });
  await expect(launchProviderAgent(h.input, h.deps)).rejects.toMatchObject({ code: "unconfirmed" });
});

it("snapshots the launch choice before asynchronous target work", async () => {
  const h = setup(); h.deps.target.mockImplementation(async () => { h.input.name = "changed"; h.input.llm = { apiKey: "private-mutation" }; return h.target; });
  await launchProviderAgent(h.input, h.deps);
  expect(h.deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ name: "My agent", llm_config: null }));
});

async function modelRequest(h: ReturnType<typeof setup>, mode: "byok" | "managed" = "byok") {
  h.input.llm = mode === "byok"
    ? { provider: "venice", mode, apiKey: "synthetic-model-key", model: "test-model" }
    : { provider: "venice", mode, walletType: "card", model: "test-model" };
  const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let savedAgent: Record<string, unknown> | null = null;
  const store = { existing: jest.fn().mockResolvedValue(null), byRequest: jest.fn().mockResolvedValue(null),
    reserve: jest.fn(async input => {
      const row = { ...input.agent, user_id: input.userId, status: "provisioning", desired_state: "running",
        allocation_operation_id: input.agent.operation_id, operation_kind: "provision", llm_config: null, llm_api_key_encrypted: null };
      savedAgent = row; h.save(row);
      store.byRequest.mockResolvedValue({ agent_id: row.id, request_id: requestId, phase: "waiting" });
      return { created: true, agentId: row.id, phase: "waiting" };
    }) };
  const service = createLaunchModelAdmissionService({ store: store as unknown as LaunchModelStore,
    agent: async () => savedAgent as never, fingerprints: () => [{ version: 1, keyTag: "a".repeat(64), digest: "b".repeat(64) }] });
  const { admission } = await service.prepare("owner", requestId, { type: "codex", name: h.input.name,
    cpu: 0.5, ram: 1, browser: false, goal: null, context: null, personality: null, emoji: null, templateSkills: [],
    deployment: { mode: "self-managed", connectionId: h.input.connectionId, targetId: h.input.targetId, expectedConnectionRevision: 7 },
    llm: h.input.llm });
  return { service, admission: admission!, store, requestId,
    replaceSaved: (agent: Record<string, unknown>) => { savedAgent = agent; h.save(agent); } };
}

it.each(["byok", "managed"] as const)("reserves the %s launch through custody and installs without a key", async mode => {
  const h = setup(), model = await modelRequest(h, mode);
  const result = await launchProviderAgent(h.input, h.deps, model);
  expect(result).toMatchObject({ launchRequestId: model.requestId, agent: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "codex", status: "provisioning", cpu: 2, ram: 4, llm_config: null } });
  expect(model.store.reserve).toHaveBeenCalledTimes(1); expect(h.deps.reserve).not.toHaveBeenCalled();
  expect(model.store.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", requestId: model.requestId,
    llm: h.input.llm, agent: expect.objectContaining({ computer_substrate: "provider-vm", cpu: 2, ram: 4, pool_id: null,
      provider_capacity_order_id: h.f.binding.orderId, provider_server_id: "42" }) }));
  const row = model.store.reserve.mock.calls[0][0].agent;
  expect(row).not.toHaveProperty("llm_config"); expect(row).not.toHaveProperty("llm_api_key_encrypted");
  expect(h.deps.inspect.mock.invocationCallOrder[0]).toBeLessThan(model.store.reserve.mock.invocationCallOrder[0]);
  expect(model.store.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.deps.tunnel.mock.invocationCallOrder[0]);
  expect(h.deps.installer).toHaveBeenCalledWith(expect.objectContaining({ launch: expect.objectContaining({ modelKey: "", modelBaseUrl: "", model: "" }) }));
  expect(JSON.stringify(h.deps.installer.mock.calls)).not.toMatch(/synthetic-model-key|test-model/);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-model-key|binding_token|operation_id/);
});

it("rejects a native-compatible provider bundle without model support before loading credentials", async () => {
  const h = setup(), model = await modelRequest(h); h.target.capabilities.provisioner.version = "2026.08.28.1";
  await expect(launchProviderAgent(h.input, h.deps, model)).rejects.toMatchObject({ code: "model" });
  expect(h.deps.connection).not.toHaveBeenCalled(); expect(h.deps.bootstrap).not.toHaveBeenCalled();
  expect(h.deps.reserve).not.toHaveBeenCalled(); expect(model.store.reserve).not.toHaveBeenCalled();
});

it.each(["owner", "model", "browser", "runtime"])("rejects mismatched saved %s context before infrastructure", async field => {
  const h = setup(), model = await modelRequest(h);
  if (field === "owner") model.admission.userId = "other-owner";
  if (field === "model") model.admission.intent.llm.model = "another-model";
  if (field === "browser") model.admission.intent.browser = true;
  if (field === "runtime") h.input.type = "openclaw";
  await expect(launchProviderAgent(h.input, h.deps, model)).rejects.toMatchObject({ code: "model" });
  expect(h.deps.target).not.toHaveBeenCalled(); expect(model.store.reserve).not.toHaveBeenCalled();
});

it("does not dispatch after a concurrent or unacknowledged reservation returns the original computer", async () => {
  const h = setup(), model = await modelRequest(h), originalId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  model.store.reserve.mockImplementation(async input => {
    model.replaceSaved({ ...input.agent, id: originalId, user_id: "owner", type: "codex", status: "provisioning" });
    model.store.byRequest.mockResolvedValue({ agent_id: originalId, request_id: model.requestId, phase: "waiting" });
    return { created: false, agentId: originalId, phase: "waiting" };
  });
  expect(await launchProviderAgent(h.input, h.deps, model)).toMatchObject({ launchRequestId: model.requestId, agent: { id: originalId } });
  expect(h.deps.reserve).not.toHaveBeenCalled(); expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
});

it("never retries custody or falls back to the ordinary insert after an unconfirmed reservation", async () => {
  const h = setup(), model = await modelRequest(h);
  model.store.reserve.mockRejectedValue(new Error("private-storage-failure"));
  await expect(launchProviderAgent(h.input, h.deps, model)).rejects.toMatchObject({ code: "unconfirmed" });
  expect(model.store.reserve).toHaveBeenCalledTimes(1); expect(h.deps.reserve).not.toHaveBeenCalled();
  expect(h.deps.tunnel).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
});

it("snapshots saved model context before awaiting provider discovery", async () => {
  const h = setup(), model = await modelRequest(h);
  h.deps.target.mockImplementation(async () => {
    model.admission.intent.llm.model = "changed"; model.admission.userId = "changed";
    h.input.llm = null; return h.target;
  });
  await launchProviderAgent(h.input, h.deps, model);
  expect(model.store.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", llm: expect.objectContaining({ model: "test-model" }) }));
});
