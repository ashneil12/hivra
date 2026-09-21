import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { deriveWebUIBaseUrl } from "@/lib/instance-backend";
import { isWebfreeBackend } from "@/lib/types/instance";
import { resolveOfficialDashboardGatewayUrl } from "@/lib/official-dashboard-handoff";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { applyWorkspaceCloudModelConfig } from "@/lib/services/workspace-cloud-provisioner";
import { log } from "@/lib/logger";

export interface WorkspaceCloudModelConfig {
  apiKey: string;
  model: string;
}

/**
 * Hermes Workspace cloud handoff — one-time PKCE authorization codes.
 *
 * The Workspace client (a local app on the user's machine) cannot receive a
 * long-lived credential over a browser redirect safely. So we run an
 * OAuth-style code exchange: Workspace generates a PKCE verifier locally and
 * sends only its challenge; Hermesdeploy mints a short-lived single-use code
 * bound to that challenge + the owning user + the instance; Workspace then
 * exchanges code+verifier server-to-server for the connection bundle.
 *
 * Nothing here trusts the caller's identity on exchange — the code IS the
 * bearer of authorization, and it only yields a bundle for the exact instance
 * and user it was minted for.
 */

// How long the Workspace has to complete the redirect round-trip + exchange.
const HANDOFF_CODE_TTL_MS = 5 * 60_000;

// Bundle freshness. The api_server_key itself does not expire, but we stamp an
// expiry so the Workspace re-handshakes periodically (cheap revocation story).
function bundleTtlMs(): number {
  const days = Number(process.env.WORKSPACE_CLOUD_HANDOFF_BUNDLE_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60_000;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** PKCE S256: BASE64URL(SHA256(verifier)). */
function pkceChallengeFromVerifier(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export interface WorkspaceCloudConnectionBundle {
  instanceId: string;
  gatewayUrl: string;
  dashboardUrl: string;
  apiServerKey: string;
  expiresAt: string;
}

/**
 * Mint a one-time code for an instance the caller owns. Stores only the hash
 * of the code; the plaintext is returned once and only ever travels to the
 * Workspace callback. `challenge` is the PKCE code_challenge supplied by the
 * Workspace.
 */
export async function issueWorkspaceCloudHandoffCode(params: {
  userId: string;
  instanceId: string;
  /**
   * Optional PKCE code_challenge. When present (browser redirect flow) the
   * exchange requires the matching verifier. When absent (paste-a-code pairing
   * flow — the user copies the code off the dashboard into the Workspace app),
   * the code itself is the single-use bearer — no PKCE round-trip is possible.
   */
  challenge?: string;
}): Promise<{ ok: true; code: string; expiresAt: string } | { ok: false; status: number; error: string }> {
  if (!supabaseAdmin) {
    return { ok: false, status: 500, error: "Database not configured" };
  }
  if (params.challenge && (params.challenge.length < 32 || params.challenge.length > 256)) {
    return { ok: false, status: 400, error: "Invalid PKCE challenge" };
  }

  // The instance must be the caller's, in the workspace_cloud lane, and ready
  // to serve (running with a gateway + key) so the bundle is immediately
  // usable when exchanged.
  const { data: row, error: lookupError } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, status, product_surface")
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .neq("status", "deleted")
    .maybeSingle<{ id: string; status: string; product_surface: string }>();

  if (lookupError || !row) {
    return { ok: false, status: 404, error: "Instance not found" };
  }
  if (row.product_surface !== "workspace_cloud") {
    return { ok: false, status: 403, error: "Instance is not a Workspace Cloud instance" };
  }
  if (row.status !== "running") {
    return { ok: false, status: 409, error: "Instance is not running yet" };
  }

  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + HANDOFF_CODE_TTL_MS).toISOString();

  const { error: insertError } = await supabaseAdmin
    .from("workspace_cloud_handoff_codes")
    .insert({
      code_hash: sha256Hex(code),
      user_id: params.userId,
      instance_id: params.instanceId,
      challenge: params.challenge ?? "",
      expires_at: expiresAt,
    });

  if (insertError) {
    return { ok: false, status: 500, error: "Failed to issue handoff code" };
  }

  return { ok: true, code, expiresAt };
}

/**
 * Exchange a code + PKCE verifier for the connection bundle. Single-use: the
 * row is atomically claimed (consumed_at) so a replay or a concurrent exchange
 * cannot both win.
 */
export async function exchangeWorkspaceCloudHandoffCode(params: {
  code: string;
  /** Required only for the browser-redirect (PKCE) flow; omitted for paste-a-code. */
  verifier?: string;
  /** Optional per-user model creds to push onto the agent at connect time. */
  modelConfig?: WorkspaceCloudModelConfig;
}): Promise<{ ok: true; bundle: WorkspaceCloudConnectionBundle } | { ok: false; status: number; error: string }> {
  if (!supabaseAdmin) {
    return { ok: false, status: 500, error: "Database not configured" };
  }
  if (!params.code) {
    return { ok: false, status: 400, error: "Missing code" };
  }
  // A provided verifier must be well-formed (RFC 7636) even though it is only
  // REQUIRED for codes minted with a PKCE challenge (browser-redirect flow).
  // Paste-a-code pairing omits it entirely.
  if (params.verifier && (params.verifier.length < 43 || params.verifier.length > 128)) {
    return { ok: false, status: 400, error: "Invalid verifier" };
  }

  const codeHash = sha256Hex(params.code);

  const { data: row } = await supabaseAdmin
    .from("workspace_cloud_handoff_codes")
    .select("id, user_id, instance_id, challenge, expires_at, consumed_at")
    .eq("code_hash", codeHash)
    .maybeSingle<{
      id: string;
      user_id: string;
      instance_id: string;
      challenge: string;
      expires_at: string;
      consumed_at: string | null;
    }>();

  if (!row) {
    return { ok: false, status: 400, error: "Invalid or expired code" };
  }
  if (row.consumed_at) {
    return { ok: false, status: 400, error: "Code already used" };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 400, error: "Code expired" };
  }
  // PKCE only applies to the browser-redirect flow (a challenge was stored at
  // mint). Paste-a-code pairing stores no challenge — the single-use, short-TTL
  // code IS the bearer (shown only to the authenticated user on the dashboard).
  if (row.challenge) {
    if (!params.verifier || params.verifier.length < 43 || params.verifier.length > 128) {
      return { ok: false, status: 400, error: "Invalid verifier" };
    }
    const expectedChallenge = pkceChallengeFromVerifier(params.verifier);
    const a = Buffer.from(expectedChallenge);
    const b = Buffer.from(row.challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, status: 400, error: "PKCE verification failed" };
    }
  }

  // Atomically claim the code. If another request consumed it first, this
  // returns no row and we reject.
  const { data: claimed } = await supabaseAdmin
    .from("workspace_cloud_handoff_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!claimed) {
    return { ok: false, status: 400, error: "Code already used" };
  }

  const bundle = await buildWorkspaceCloudConnectionBundle({
    userId: row.user_id,
    instanceId: row.instance_id,
    applyModel: params.modelConfig,
  });
  if (!bundle.ok) {
    return bundle;
  }
  return { ok: true, bundle: bundle.bundle };
}

/**
 * Assemble the connection bundle for a running lane instance. Reuses
 * getSecureUserInstance, which decrypts the api_server_key and resolves the
 * gateway/ipv4 exactly as the official-dashboard handoff does.
 */
export async function buildWorkspaceCloudConnectionBundle(params: {
  userId: string;
  instanceId: string;
  applyModel?: WorkspaceCloudModelConfig;
}): Promise<{ ok: true; bundle: WorkspaceCloudConnectionBundle } | { ok: false; status: number; error: string }> {
  const { instance, apiServerKey, error, instanceIpv4 } = await getSecureUserInstance({
    id: params.instanceId,
    userId: params.userId,
    requireRunning: true,
  });

  if (!instance || !instance.gateway_url || !apiServerKey) {
    return {
      ok: false,
      status: 409,
      error: error || "Instance is not ready to connect",
    };
  }

  // Per-user BYO: push the user's model key + name onto the agent so a
  // credential-less cloud agent can answer. Best-effort — a failure here must
  // not block the connection itself (the user can re-apply by reconnecting or
  // from the Workspace), but it is logged so we can see misconfigured agents.
  if (params.applyModel?.apiKey && instanceIpv4) {
    try {
      const applied = await applyWorkspaceCloudModelConfig({
        ip: instanceIpv4,
        apiKey: params.applyModel.apiKey,
        model: params.applyModel.model,
      });
      if (!applied.ok) {
        log.warn("workspace_cloud model config apply failed", {
          source: "workspace-cloud-handoff",
          failureType: "workspace_cloud_model_apply_failed",
          instanceId: params.instanceId,
          reason: applied.error,
        });
      }
    } catch (err) {
      log.warn("workspace_cloud model config apply threw", {
        source: "workspace-cloud-handoff",
        failureType: "workspace_cloud_model_apply_threw",
        instanceId: params.instanceId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Post gateway≡webfree collapse, a "gateway" box runs the same webfree stack as
  // "webui" (official-dashboard on the per-instance fqdn), so both must resolve
  // their base URL through deriveWebUIBaseUrl (http→https sslip normalization +
  // slash trim). Keying this on the raw `=== "webui"` left a gateway box on its
  // unnormalized gateway_url, so the workspace handoff pointed the chat surface at
  // the wrong URL and messages went nowhere.
  const baseGatewayUrl =
    isWebfreeBackend(instance.backend)
      ? deriveWebUIBaseUrl(instance.gateway_url)
      : instance.gateway_url;
  const gatewayUrl = resolveOfficialDashboardGatewayUrl({
    gatewayUrl: baseGatewayUrl,
    instanceIpv4,
  });

  return {
    ok: true,
    bundle: {
      instanceId: instance.id,
      gatewayUrl,
      // The cloud instance serves its dashboard APIs from the same gateway
      // host (sidecar). The Workspace probe detects capabilities from here.
      dashboardUrl: gatewayUrl,
      apiServerKey,
      expiresAt: new Date(Date.now() + bundleTtlMs()).toISOString(),
    },
  };
}
