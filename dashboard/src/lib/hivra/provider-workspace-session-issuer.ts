import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadFirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderWorkspaceRuntime } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderWorkspaceRuntimeReceipt } from "@/lib/infrastructure/provider-desktop-runtime";
import { loadProviderDesktopCapabilityContext } from "./provider-desktop-capability";
import { verifyProviderDesktopPublicRuntime } from "./provider-desktop-public-readiness";

export const WorkspaceIssueRequest = z.object({ computerId: z.string().uuid(), surface: z.enum(["files", "box-terminal"]),
  pkceChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const Issue = WorkspaceIssueRequest.extend({ userId: z.string().min(1).max(256) }).strict();
const OwnerSession = z.object({ userId: z.string().min(1).max(256), sessionId: z.string().uuid() }).strict();
const Issued = z.object({ status: z.literal("issued"), sessionId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }), exchangeExpiresAt: z.string().datetime({ offset: true }) }).strict();
type Context = Awaited<ReturnType<typeof loadProviderDesktopCapabilityContext>>;
type Dependencies = {
  load: typeof loadProviderDesktopCapabilityContext; boot: typeof loadFirstBootOperation;
  verify: typeof verifyEnrolledProviderReceipt; bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  inspect: typeof inspectProviderWorkspaceRuntime; publicReady: typeof verifyProviderDesktopPublicRuntime;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  monotonicNow: () => number; now: () => number; controlOrigin: () => string;
  sessionId: () => string; exchangeCode: () => string;
};
const defaults: Dependencies = {
  load: loadProviderDesktopCapabilityContext, boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt,
  bootstrap: loadHetznerCloudCapacityBootstrap, inspect: inspectProviderWorkspaceRuntime, publicReady: verifyProviderDesktopPublicRuntime,
  rpc: async (name, args) => {
    if (!supabaseAdmin) throw new Error("Workspace authorization unavailable");
    return await supabaseAdmin.rpc(name, args);
  },
  monotonicNow: () => performance.now(), now: Date.now,
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
  sessionId: randomUUID, exchangeCode: () => `hwe1_${randomBytes(32).toString("base64url")}`,
};

/** Conservative embedding gate, not a general public-suffix algorithm. Support
 * the hosted zone and guests below the self-host control hostname. Cross-site
 * direct HTTPS and other sibling domains need a separate top-level handoff;
 * do not make their Strict cookies weaker to make an iframe appear supported. */
export function workspaceEmbeddingSupported(context: Pick<Context, "access">, controlOrigin: string) {
  try {
    const control = new URL(controlOrigin);
    if (control.protocol !== "https:" || control.origin !== controlOrigin || context.access.mode !== "cloudflare-named") return false;
    const host = context.access.hostname;
    return host.endsWith(`.${control.hostname}`)
      || (["canary.hermesos.cloud", "hermesos.cloud"].includes(control.hostname) && host.endsWith(".hermesos.cloud"));
  } catch { return false; }
}

/** Owner request -> current provider ownership -> pinned installed protocol ->
 * same original SQL binding. This creates an access grant, never a computer,
 * enrollment, lifecycle operation, management bearer or desktop controller. */
export async function issueProviderWorkspaceSession(raw: unknown, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new Error(); };
  let cleanup: z.infer<typeof OwnerSession> | undefined;
  try {
    const input = Issue.parse(raw), ref = { userId: input.userId, agentId: input.computerId }; fence();
    const context = await deps.load(ref); fence();
    const controlOrigin = deps.controlOrigin();
    if (context.input.userId !== ref.userId || context.input.agentId !== ref.agentId
      || !["2026.09.05.9", "2026.09.05.10"].includes(context.identity.bundle.provisionerVersion)
      || !workspaceEmbeddingSupported(context, controlOrigin)) throw new Error();
    const boot = await deps.boot(context.scope); fence(); if (!boot) throw new Error();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline },
      { monotonicNow: deps.monotonicNow }); fence();
    if (verified.stage !== "provider_verified" || verified.address !== context.ip
      || JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw new Error();
    const binding = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId,
      expectedRevision: binding.connectionRevision, orderId: binding.orderId, idempotencyKey: verified.capacityIdempotencyKey,
      quoteFingerprintSha256: binding.quoteFingerprint }); fence();
    const observed = await deps.inspect({ identity: context.identity, access: context.access, controlOrigin, address: verified.address,
      hostPublicKey: verified.hostPublicKey, administratorPublicKey: bootstrap.publicKeyOpenSsh,
      administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow }); fence();
    if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
      || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new Error();
    const { capability, ...workspace } = observed.receipt;
    parseProviderWorkspaceRuntimeReceipt(`HIVRA_PROVIDER_WORKSPACE_V1 ${JSON.stringify({ ...workspace,
      capabilityOutput: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(capability)}\n` })}\n`, { ...context, controlOrigin });
    if (!await deps.publicReady({ access: context.access, controlOrigin })) throw new Error(); fence();
    if (JSON.stringify(await deps.load(ref)) !== JSON.stringify(context)) throw new Error(); fence();
    const sessionId = z.string().uuid().parse(deps.sessionId());
    const exchangeCode = z.string().regex(/^hwe1_[A-Za-z0-9_-]{43}$/).parse(deps.exchangeCode());
    const audience = `https://${context.access.hostname}`;
    cleanup = { userId: input.userId, sessionId };
    const { data, error } = await deps.rpc("issue_hivra_workspace_session", { p_user: input.userId, p_computer: input.computerId,
      p_id: sessionId, p_surface: input.surface, p_audience: audience, p_identity: context.identity, p_access: context.access,
      p_exchange_hash: createHash("sha256").update(exchangeCode).digest("hex"), p_challenge: input.pkceChallenge }); fence();
    if (error) throw new Error();
    const issued = Issued.parse(data), now = deps.now(), expiresAt = Date.parse(issued.expiresAt), exchangeExpiresAt = Date.parse(issued.exchangeExpiresAt);
    if (![now, expiresAt, exchangeExpiresAt].every(Number.isFinite) || issued.sessionId !== sessionId
      || exchangeExpiresAt <= now || exchangeExpiresAt > now + 60_000 || expiresAt <= exchangeExpiresAt || expiresAt > now + 240_000) throw new Error();
    cleanup = undefined;
    return { ok: true as const, session: { sessionId, computerId: input.computerId, surface: input.surface, audience,
      handoffUrl: `${audience}/workspace/handoff`, exchangeCode, expiresAt, exchangeExpiresAt } };
  } catch {
    // A timed-out/invalid database receipt must not leave a returned capability.
    // Best-effort owner revoke; the unseen random code and short SQL TTL also
    // bound an uncertain insert. Never delete the computer or retry issuance.
    if (cleanup) await revokeProviderWorkspaceSession(cleanup, deps);
    return { ok: false as const, code: "workspace_unavailable" as const,
      error: "Files and Terminal access could not be verified for this computer. No computer settings were changed." };
  }
}

export async function revokeProviderWorkspaceSession(raw: unknown, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    const input = OwnerSession.parse(raw);
    const { data, error } = await deps.rpc("revoke_hivra_workspace_session", { p_user: input.userId, p_id: input.sessionId });
    // Identical response for an absent/foreign session; SQL enforces ownership.
    return { ok: !error && typeof data === "boolean" };
  } catch { return { ok: false }; }
}
