import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";

export const CANARY_QA_HOLDER_NAME = "Canary holder QA";
export const CANARY_QA_HOLDER_HEADER = "x-hivra-canary-holder-qa";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CanaryQaHolderRow {
  user_id?: unknown;
  canary_qa_holder_expires_at?: unknown;
}

export async function canaryQaHolderDeadline(
  userId: unknown,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<string | null | undefined> {
  if (!isCanonicalGitCanaryDeployment(env) || typeof userId !== "string") return null;
  try {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_canary_qa_holder_settings")
      .select("enabled,owner_id,expires_at").eq("singleton", true).maybeSingle();
    if (error) throw new Error(error.code);
    if (data) {
      if (data.enabled !== true || data.owner_id !== userId) return null;
      const deadline = Date.parse(data.expires_at);
      return deadline > now && deadline - now <= MAX_WINDOW_MS ? new Date(deadline).toISOString() : null;
    }
  } catch {
    log.warn("Could not read Canary holder QA enrollment", {
      source: "canary-qa-holder", failureType: "holder_qa_settings_read_failed",
    });
    return undefined;
  }
  if (env.HIVRA_CANARY_QA_HOLDER_ENABLED !== "true") return null;
  const standingUser = env.HIVRA_CANARY_QA_HOLDER_USER_ID;
  if (!standingUser || !/^user_[A-Za-z0-9]+$/.test(standingUser) || standingUser !== userId) return null;
  const raw = env.HIVRA_CANARY_QA_HOLDER_EXPIRES_AT;
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) return null;
  const deadline = Date.parse(raw);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== raw) return null;
  return deadline > now && deadline - now <= MAX_WINDOW_MS ? raw : null;
}

export function isCanaryQaHolderSeat(row: CanaryQaHolderRow): boolean {
  return row.canary_qa_holder_expires_at != null;
}

export async function isCanaryQaHolderSeatActive(row: CanaryQaHolderRow, now = Date.now()): Promise<boolean | undefined> {
  if (typeof row.canary_qa_holder_expires_at !== "string"
      || !(Date.parse(row.canary_qa_holder_expires_at) > now)) return false;
  const deadline = await canaryQaHolderDeadline(row.user_id, now);
  return deadline === undefined ? undefined : deadline !== null;
}
