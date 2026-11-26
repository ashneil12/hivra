import "server-only";

import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHENTICATED_OWNER_ID = /^user_[A-Za-z0-9_]{1,128}$/;
const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ManagedGvisorAuthorityConfig = {
  authorityUserId: string;
  connectionId: string;
  targetId: string;
  connectionRevision: number;
};

export type ManagedGvisorQaEnrollmentConfig = {
  ownerId: string;
  expiresAtMs: number;
};

function switchEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

function strictUtcTimestampMs(value: string | undefined): number | null {
  if (!value || !STRICT_UTC_TIMESTAMP.test(value)) return null;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== value) return null;
  return timestampMs;
}

export function managedGvisorAuthorityConfig(env: NodeJS.ProcessEnv): ManagedGvisorAuthorityConfig | null {
  const authorityUserId = env.HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID?.trim() ?? "";
  const connectionId = env.HIVRA_MANAGED_GVISOR_CONNECTION_ID?.trim() ?? "";
  const targetId = env.HIVRA_MANAGED_GVISOR_TARGET_ID?.trim() ?? "";
  const connectionRevision = Number(env.HIVRA_MANAGED_GVISOR_CONNECTION_REVISION);
  if (!authorityUserId || !UUID.test(connectionId) || !UUID.test(targetId)
    || !Number.isSafeInteger(connectionRevision) || connectionRevision < 1) {
    return null;
  }
  return { authorityUserId, connectionId, targetId, connectionRevision };
}

export function managedGvisorQaEnrollmentConfig(
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): ManagedGvisorQaEnrollmentConfig | null {
  const ownerId = env.HIVRA_MANAGED_GVISOR_QA_OWNER_ID ?? "";
  const expiresAtMs = strictUtcTimestampMs(env.HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT);
  if (!AUTHENTICATED_OWNER_ID.test(ownerId) || expiresAtMs === null || !Number.isFinite(now) || expiresAtMs <= now) {
    return null;
  }
  return { ownerId, expiresAtMs };
}

export function managedGvisorGeneralLaunchEnabled(env: NodeJS.ProcessEnv): boolean {
  return switchEnabled(env.HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED);
}

export function managedGvisorQaEnrollmentEnabled(env: NodeJS.ProcessEnv): boolean {
  return switchEnabled(env.HIVRA_MANAGED_GVISOR_QA_ENROLLMENT_ENABLED);
}

export function managedGvisorLaunchConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return managedGvisorGeneralLaunchEnabled(env) && managedGvisorAuthorityConfig(env) !== null;
}

export function managedGvisorLaunchAdmittedForUser(
  userId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;
  const generalEnabled = managedGvisorGeneralLaunchEnabled(env);
  const qaEnabled = managedGvisorQaEnrollmentEnabled(env);
  if (!qaEnabled) return managedGvisorLaunchConfigured(env);
  if (generalEnabled || !isCanonicalGitCanaryDeployment(env)) return false;
  const enrollment = managedGvisorQaEnrollmentConfig(env, now);
  const authority = managedGvisorAuthorityConfig(env);
  return enrollment !== null
    && authority !== null
    && authority.authorityUserId !== enrollment.ownerId
    && userId === enrollment.ownerId;
}
