import "server-only";

import { decryptSecret } from "@/lib/crypto";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import type { LiteWorkerConfig } from "./client";

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANARY_WORKER_ORIGIN = /^https:\/\/lite-agent-canary\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;

const QA_COLUMNS = "enabled,owner_id,expires_at,worker_origin,signing_secret_enc,managed_enabled";
const MANAGED_COLUMNS = "managed_model,managed_proxy_key_id,managed_proxy_key_enc";

type QaConfig = LiteWorkerConfig & { explicitInference: boolean };
type ManagedQaConfig = QaConfig & { model: string; proxyKeyId: string; proxyKey: string };

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
    if (typeof data.worker_origin !== "string" || !CANARY_WORKER_ORIGIN.test(data.worker_origin)
      || typeof data.signing_secret_enc !== "string") return null;
    const secret = decryptSecret(data.signing_secret_enc);
    if (!/^[0-9a-f]{64}$/.test(secret)) return null;
    const url = data.worker_origin;
    const explicitInference = data.managed_enabled === true;
    if (!managed) return { url, secret, explicitInference };
    const { managed_enabled, managed_model, managed_proxy_key_id, managed_proxy_key_enc } = data;
    if (managed_enabled !== true || typeof managed_model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(managed_model)
      || typeof managed_proxy_key_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(managed_proxy_key_id)
      || typeof managed_proxy_key_enc !== "string") return null;
    const proxyKey = decryptSecret(managed_proxy_key_enc);
    if (!/^hven_live_[A-Za-z0-9_-]{43}$/.test(proxyKey)) return null;
    return { url, secret, explicitInference, model: managed_model, proxyKeyId: managed_proxy_key_id, proxyKey };
  } catch {
    log.warn("Could not read Lite Canary QA settings", {
      source: "lite-canary-qa", failureType: "lite_qa_settings_unavailable",
    });
    return null;
  }
}
