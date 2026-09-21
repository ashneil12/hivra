import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";

const Origin = z.string().max(300).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
});
export const WorkspaceBinding = z.object({
  sessionId: z.string().uuid(), computerId: z.string().uuid(),
  surface: z.enum(["files", "box-terminal"]), audience: Origin,
}).strict();
export const WorkspaceExchange = WorkspaceBinding.extend({
  exchangeCode: z.string().regex(/^hwe1_[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();
const WORKSPACE_TOKEN_RE = /^hws1_[A-Za-z0-9_-]{43}$/;
const Authorization = WorkspaceBinding.extend({ sessionToken: z.string().regex(WORKSPACE_TOKEN_RE) }).strict();
const Grant = WorkspaceBinding.extend({ userId: z.string().min(1).max(256), expiresAt: z.string().datetime({ offset: true }) });
type Binding = z.infer<typeof WorkspaceBinding>;
type Dependencies = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  now: () => number;
  token: () => string;
};
const defaults: Dependencies = {
  rpc: async (name, args) => {
    if (!supabaseAdmin) throw new Error("Workspace authorization unavailable");
    return await supabaseAdmin.rpc(name, args);
  },
  now: Date.now,
  token: () => `hws1_${randomBytes(32).toString("base64url")}`,
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const denied = () => ({ ok: false as const });

function grantFromResult(data: unknown, status: "exchanged" | "authorized", binding: Binding, now: number) {
  const record = Grant.extend({ status: z.literal(status) }).strict().parse(data);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now
    || expiresAt > now + 4 * 60_000
    || record.sessionId !== binding.sessionId || record.computerId !== binding.computerId
    || record.surface !== binding.surface || record.audience !== binding.audience) throw new Error("Workspace grant mismatch");
  return { sessionId: record.sessionId, computerId: record.computerId, userId: record.userId,
    surface: record.surface, audience: record.audience, expiresAt };
}

/** Guest broker only. The one-use code/verifier arrives in a bounded POST body;
 * only hashes cross into the ledger. No arbitrary URL is fetched here. */
export async function exchangeWorkspaceSession(raw: unknown, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    const input = WorkspaceExchange.parse(raw), sessionToken = z.string().regex(WORKSPACE_TOKEN_RE).parse(deps.token());
    const { data, error } = await deps.rpc("exchange_hivra_workspace_session", {
      p_id: input.sessionId, p_computer: input.computerId, p_surface: input.surface, p_audience: input.audience,
      p_exchange_hash: sha256(input.exchangeCode),
      p_challenge: createHash("sha256").update(input.verifier).digest("base64url"), p_token_hash: sha256(sessionToken),
    });
    if (error) return denied();
    const grant = grantFromResult(data, "exchanged", input, deps.now());
    return { ok: true as const, grant: { ...grant, sessionToken } };
  } catch { return denied(); }
}

/** Rechecks durable owner/lifecycle authority, not a cached signed assertion.
 * Returned binding must match the caller's immutable session path exactly. */
export async function authorizeWorkspaceSession(raw: unknown, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    const input = Authorization.parse(raw);
    const { data, error } = await deps.rpc("authorize_hivra_workspace_session", {
      p_id: input.sessionId, p_computer: input.computerId, p_surface: input.surface,
      p_audience: input.audience, p_token_hash: sha256(input.sessionToken),
    });
    if (error) return denied();
    return { ok: true as const, grant: grantFromResult(data, "authorized", input, deps.now()) };
  } catch { return denied(); }
}
