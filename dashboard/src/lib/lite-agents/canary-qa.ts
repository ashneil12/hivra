import "server-only";

import { decryptSecret } from "@/lib/crypto";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import type { LiteWorkerConfig } from "./client";

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANARY_WORKER_ORIGIN = /^https:\/\/lite-agent-canary\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;

export async function readCanaryLiteQaConfig(
  userId: string,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiteWorkerConfig | null> {
  if (!isCanonicalGitCanaryDeployment(env) || !/^user_[A-Za-z0-9]+$/.test(userId)) return null;
  try {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_canary_lite_qa_settings")
      .select("enabled,owner_id,expires_at,worker_origin,signing_secret_enc")
      .eq("singleton", true).eq("owner_id", userId).maybeSingle();
    if (error) throw new Error("settings_read_failed");
    if (data?.enabled !== true || data.owner_id !== userId) return null;
    const expiry = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (!(expiry > now && expiry - now <= MAX_WINDOW_MS)) return null;
    if (typeof data.worker_origin !== "string" || !CANARY_WORKER_ORIGIN.test(data.worker_origin)
      || typeof data.signing_secret_enc !== "string") return null;
    const secret = decryptSecret(data.signing_secret_enc);
    return /^[0-9a-f]{64}$/.test(secret) ? { url: data.worker_origin, secret } : null;
  } catch {
    log.warn("Could not read Lite Canary QA settings", {
      source: "lite-canary-qa", failureType: "lite_qa_settings_unavailable",
    });
    return null;
  }
}
