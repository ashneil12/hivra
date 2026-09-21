/** @jest-environment node */
import { createHash } from "node:crypto";
import { issueProviderWorkspaceSession, revokeProviderWorkspaceSession, workspaceEmbeddingSupported } from "../provider-workspace-session-issuer";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";
import type { inspectProviderWorkspaceRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
const h = desktopInstallFixture(), now = Date.now();
const input = { userId: h.op.userId, computerId: h.op.agentId, surface: "files" as const, pkceChallenge: "c".repeat(43) };
const access = { mode: "cloudflare-named" as const, hostname: h.context.hostname!, tunnelId: h.context.tunnelId! };
const context = { input: { userId: input.userId, agentId: input.computerId }, identity: h.identity, access,
  scope: h.scope, targetId: h.context.targetId, ip: "93.184.216.34" };
const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff", exchangeCode = `hwe1_${"x".repeat(43)}`;
function deps() {
  let elapsed = 0;
  return { load: jest.fn(async () => structuredClone(context)),
    boot: jest.fn(async () => ({ ...h.scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope: h.scope, address: context.ip,
      hostPublicKey: h.f.host.publicKey, hostFingerprintSha256: h.f.host.fingerprintSha256, capacityIdempotencyKey: h.f.stored.capacityIdempotencyKey,
      observedAt: new Date().toISOString(), powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderWorkspaceRuntime>, [unknown]>(async () => ({ hostVerified: true,
      administratorAuthenticated: true, hostFingerprintSha256: h.f.host.fingerprintSha256,
      receipt: { protocol: "hivra-workspace-v1", computerId: input.computerId, operationId: h.op.operationId,
        publicOrigin: `https://${access.hostname}`, controlOrigin: "https://hivra.test",
        capability: { protocol: "hivra-remote-desktop-capability-v1", computerKind: "hivra-agent",
          computerId: input.computerId, capabilityGeneration: h.clock.bootId, observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION,
          compositor: "x11", installedTransports: ["selkies-websocket"], privateNetworkReachable: false,
          supportsInputTakeover: true, brokerOrigin: `https://${access.hostname}`, observedAt: new Date().toISOString() } } })),
    publicReady: jest.fn(async () => true), monotonicNow: () => elapsed, now: () => now, advance: () => { elapsed = 30001; },
    controlOrigin: () => "https://hivra.test", sessionId: () => sessionId, exchangeCode: () => exchangeCode,
    rpc: jest.fn<Promise<{data: unknown; error: unknown}>, [string, Record<string, unknown>]>(async name => ({ error: null,
      data: name.startsWith("revoke") ? true : { status: "issued", sessionId, expiresAt: new Date(now + 240000).toISOString(),
        exchangeExpiresAt: new Date(now + 60000).toISOString() } })) };
}
it("issues only after original pin, installed protocol, public ingress and a current-state reread", async () => {
  const d = deps(), result = await issueProviderWorkspaceSession(input, d);
  expect(result).toEqual({ ok: true, session: { sessionId, computerId: input.computerId, surface: "files",
    audience: `https://${access.hostname}`, handoffUrl: `https://${access.hostname}/workspace/handoff`, exchangeCode,
    expiresAt: now + 240000, exchangeExpiresAt: now + 60000 } });
  expect(d.inspect).toHaveBeenCalledWith(expect.objectContaining({ identity: h.identity, access, controlOrigin: "https://hivra.test",
    address: context.ip, hostPublicKey: h.f.host.publicKey, administratorPrivateKey: "private-fixture", dispatchDeadlineMs: 30000 }), expect.any(Object));
  expect(d.load).toHaveBeenCalledTimes(2);
  expect(d.rpc).toHaveBeenCalledTimes(1);
  expect(d.rpc).toHaveBeenCalledWith("issue_hivra_workspace_session", { p_user: input.userId, p_computer: input.computerId,
    p_id: sessionId, p_surface: input.surface, p_audience: `https://${access.hostname}`, p_identity: h.identity, p_access: access,
    p_exchange_hash: createHash("sha256").update(exchangeCode).digest("hex"), p_challenge: input.pkceChallenge });
  expect(JSON.stringify(d.rpc.mock.calls)).not.toContain(exchangeCode);
  expect(JSON.stringify(result)).not.toContain("private-fixture");
});
it.each(["owner", "older-release", "provider-ip", "pin", "receipt", "control", "public", "late-state", "deadline"])("does not mint after %s failure", async fault => {
  const d = deps();
  if (fault === "owner") d.load.mockResolvedValue({ ...context, input: { ...context.input, userId: "foreign" } });
  if (fault === "older-release") d.load.mockResolvedValue({ ...context, identity: { ...context.identity,
    bundle: { ...context.identity.bundle, provisionerVersion: "2026.09.05.8" } } as typeof context.identity });
  if (fault === "provider-ip") d.verify.mockResolvedValue({ ...(await d.verify()), address: "10.252.216.35" });
  if (fault === "pin") d.inspect.mockResolvedValue({ ...(await d.inspect({})), hostFingerprintSha256: "foreign" });
  if (fault === "receipt" || fault === "control") {
    const observed = await d.inspect({});
    if (fault === "receipt") observed.receipt.computerId = h.op.operationId;
    else observed.receipt.controlOrigin = "https://foreign.example.test";
    d.inspect.mockResolvedValue(observed);
  }
  if (fault === "public") d.publicReady.mockResolvedValue(false);
  if (fault === "late-state") d.publicReady.mockImplementation(async () => { d.load.mockRejectedValue(new Error("private-fixture")); return true; });
  if (fault === "deadline") d.publicReady.mockImplementation(async () => { d.advance(); return true; });
  const result = await issueProviderWorkspaceSession(input, d);
  expect(result).toMatchObject({ ok: false, code: "workspace_unavailable" });
  expect(d.rpc).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("private-fixture");
});
it.each(["surface", "challenge", "caller-audience", "caller-owner"])("rejects malformed %s before ownership lookup", async fault => {
  const d = deps(), raw: Record<string, unknown> = { ...input };
  if (fault === "surface") raw.surface = "management";
  if (fault === "challenge") raw.pkceChallenge = "short";
  if (fault === "caller-audience") raw.audience = "https://foreign.example.test";
  if (fault === "caller-owner") raw.userId = "";
  expect(await issueProviderWorkspaceSession(raw, d)).toMatchObject({ ok: false });
  expect(d.load).not.toHaveBeenCalled(); expect(d.rpc).not.toHaveBeenCalled();
});
it.each(["wrong-id", "extended-code", "extended-session", "invalid-date", "database-error", "late-database"])("revokes only the owned candidate after %s receipt", async fault => {
  const d = deps();
  d.rpc.mockImplementationOnce(async () => {
    const data = { status: "issued", sessionId, expiresAt: new Date(now + 240000).toISOString(), exchangeExpiresAt: new Date(now + 60000).toISOString() };
    if (fault === "wrong-id") data.sessionId = h.op.agentId;
    if (fault === "extended-code") data.exchangeExpiresAt = new Date(now + 60001).toISOString();
    if (fault === "extended-session") data.expiresAt = new Date(now + 240001).toISOString();
    if (fault === "invalid-date") data.expiresAt = "2026-09-05T00:00:00+99:99";
    if (fault === "late-database") d.advance();
    return { data, error: fault === "database-error" ? "private-fixture" : null };
  });
  expect(await issueProviderWorkspaceSession(input, d)).toMatchObject({ ok: false });
  expect(d.rpc).toHaveBeenCalledTimes(2);
  expect(d.rpc).toHaveBeenLastCalledWith("revoke_hivra_workspace_session", { p_user: input.userId, p_id: sessionId });
});
it("uses owner-scoped idempotent revoke and hides absent/foreign distinctions", async () => {
  const d = deps(), request = { userId: input.userId, sessionId };
  expect(await revokeProviderWorkspaceSession(request, d)).toEqual({ ok: true });
  d.rpc.mockResolvedValue({ data: false, error: null });
  expect(await revokeProviderWorkspaceSession(request, d)).toEqual({ ok: true });
  d.rpc.mockRejectedValue(new Error("private-fixture"));
  expect(await revokeProviderWorkspaceSession(request, d)).toEqual({ ok: false });
});
it.each([
  ["box.hermesos.cloud", "https://canary.hermesos.cloud", true],
  ["box.hivra.test", "https://hivra.test", true],
  ["box.foreign.test", "https://canary.hermesos.cloud", false],
  ["box.hermesos.cloud.attacker.test", "https://canary.hermesos.cloud", false],
  ["box.hermesos.cloud", "http://canary.hermesos.cloud", false],
  ["box.hermesos.cloud", "https://canary.hermesos.cloud/path", false],
])("keeps Strict-cookie embedding gate for %s under %s", (hostname, control, accepted) => {
  expect(workspaceEmbeddingSupported({ access: { ...access, hostname } }, control)).toBe(accepted);
});
it("rejects direct HTTPS even when its hostname looks like a supported domain", async () => {
  expect(workspaceEmbeddingSupported({ access: { mode: "direct-https", hostname: "box.hermesos.cloud", tunnelId: null } }, "https://canary.hermesos.cloud")).toBe(false);
});
