import "server-only";

import { createHash } from "node:crypto";

import { decryptSecret } from "@/lib/crypto";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import type { LiteWorkerConfig } from "./client";

const PERMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANARY_WORKER_ORIGIN = /^https:\/\/lite-agent-canary\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;

const QA_COLUMNS = "enabled,owner_id,expires_at,worker_origin,signing_secret_enc,managed_enabled,credential_mode,permit_git_sha,permit_signer_sha256,managed_model,managed_proxy_key_id";
const MANAGED_COLUMNS = "managed_proxy_key_enc";

type QaConfig = LiteWorkerConfig & { explicitInference: boolean };
export type LiteCanaryManagedPermit = {
  mode: "trusted_permit";
  ownerId: string;
  model: string;
  proxyKeyId: string;
  workerOrigin: string;
  expiresAt: number;
  gitSha: string;
  signerSha256: string;
};
type ManagedQaConfig = QaConfig & (
  | { mode: "encrypted"; model: string; proxyKeyId: string; proxyKey: string }
  | LiteCanaryManagedPermit
);

export function readCanaryLiteQaConfig(userId: string, now = Date.now(), env = process.env): Promise<QaConfig | null> {
  return readConfig(userId, now, env, false);
}

export function readCanaryLiteManagedQaConfig(userId: string, now = Date.now(), env = process.env): Promise<ManagedQaConfig | null> {
  return readConfig(userId, now, env, true);
}

async function readConfig(userId: string, now: number, env: NodeJS.ProcessEnv, managed: true): Promise<ManagedQaConfig | null>;
async function readConfig(userId: string, now: number, env: NodeJS.ProcessEnv, managed: false): Promise<QaConfig | null>;
async function readConfig(
  userId: string,
  now: number,
  env: NodeJS.ProcessEnv,
  managed: boolean,
): Promise<QaConfig | ManagedQaConfig | null> {
  if (!isCanonicalGitCanaryDeployment(env) || !/^user_[A-Za-z0-9]+$/.test(userId)) return null;
  try {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data: row, error } = await supabaseAdmin.from("hivra_canary_lite_qa_settings")
      .select(managed ? `${QA_COLUMNS},${MANAGED_COLUMNS}` : QA_COLUMNS)
      .eq("singleton", true).eq("owner_id", userId).maybeSingle();
    if (error) throw new Error("settings_read_failed");
    const data = row as Record<string, unknown> | null;
    if (data?.enabled !== true || data.owner_id !== userId) return null;
    const expiry = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (!(expiry > now && expiry - now <= MAX_WINDOW_MS)) return null;
    const url = data.worker_origin;
    if (typeof url !== "string" || !CANARY_WORKER_ORIGIN.test(url)) return null;
    const { managed_model: model, managed_proxy_key_id: proxyKeyId } = data;
    const explicitInference = data.managed_enabled === true;
    const validModel = typeof model === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(model);
    const validKeyId = typeof proxyKeyId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(proxyKeyId);
    if (data.credential_mode === "trusted_permit") {
      const gitSha = data.permit_git_sha;
      const signerSha256 = data.permit_signer_sha256;
      const secret = env.HIVRA_CANARY_LITE_QA_WORKER_SIGNER;
      if (!explicitInference || !validModel || !validKeyId || data.signing_secret_enc !== null
        || (managed && data.managed_proxy_key_enc !== null) || expiry - now > PERMIT_WINDOW_MS
        || typeof gitSha !== "string" || !/^[0-9a-f]{40}$/.test(gitSha) || gitSha !== env.VERCEL_GIT_COMMIT_SHA
        || !secret || !/^[0-9a-f]{64}$/.test(secret)
        || signerSha256 !== createHash("sha256").update(secret, "utf8").digest("hex")) return null;
      return {
        mode: "trusted_permit", url, secret, explicitInference, ownerId: userId, model, proxyKeyId,
        workerOrigin: url, expiresAt: expiry, gitSha, signerSha256,
      };
    }

    if (data.credential_mode !== "encrypted" || typeof data.signing_secret_enc !== "string") return null;
    const secret = decryptSecret(data.signing_secret_enc);
    if (!/^[0-9a-f]{64}$/.test(secret)) return null;
    if (!managed) return { url, secret, explicitInference };
    if (!explicitInference || !validModel || !validKeyId || typeof data.managed_proxy_key_enc !== "string") return null;
    const proxyKey = decryptSecret(data.managed_proxy_key_enc);
    if (!/^hven_live_[A-Za-z0-9_-]{43}$/.test(proxyKey)) return null;
    return { mode: "encrypted", url, secret, explicitInference, model, proxyKeyId, proxyKey };
  } catch {
    log.warn("Could not read Lite Canary QA settings", {
      source: "lite-canary-qa", failureType: "lite_qa_settings_unavailable",
    });
    return null;
  }
}
