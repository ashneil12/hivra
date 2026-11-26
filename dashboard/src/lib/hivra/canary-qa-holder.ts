import "server-only";

import type { EffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";

export const CANARY_QA_HOLDER_NAME = "Canary holder QA";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CanaryQaHolderRow {
  user_id?: unknown;
  canary_qa_holder_expires_at?: unknown;
}

export function canaryQaHolderDeadline(
  userId: unknown,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isCanonicalGitCanaryDeployment(env) || env.HIVRA_CANARY_QA_HOLDER_ENABLED !== "true") return null;
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

export function isCanaryQaHolderSeatActive(row: CanaryQaHolderRow, now = Date.now()): boolean {
  return typeof row.canary_qa_holder_expires_at === "string"
    && Date.parse(row.canary_qa_holder_expires_at) > now
    && canaryQaHolderDeadline(row.user_id, now) !== null;
}

export function canUseCanaryQaHolderAdmission(sub: EffectiveSubscription | null): boolean {
  return sub === null || sub.source === "free";
}
