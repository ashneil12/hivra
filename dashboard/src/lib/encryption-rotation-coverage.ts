/** Known persistent key dependencies omitted by the legacy row rewrapper.
 * Presence is conservative: this audit never opens ciphertext and cannot tell
 * which key encrypted a value. Even terminal launch rows retain HMAC identity.
 * This is not a schema-wide inventory or permission to retire a key. */
export const UNHANDLED_ROTATION_DEPENDENCIES = [
  // These are transient custody states, not stable records to rewrite. Finish
  // or cancel them before rotation so their lifecycle RPC remains authoritative.
  { table: "hivra_model_key_operations", column: "encrypted_key" },
  { table: "hivra_launch_model_requests", column: "encrypted_key" },
  { table: "hivra_launch_model_requests", column: "fingerprint_key_tag", equals: { fingerprint_version: 1 } },
  { table: "infrastructure_first_boot_enrollments", column: "encrypted_token" },
  // Buzz identities are encrypted with the primary ENCRYPTION_KEY and are not
  // rewrapped by this script: service_role can only read the table, and the
  // lifecycle RPCs own every write (migration 20260901000000), so a rewrap needs
  // its own migration. Until that exists, rotating and then retiring the old
  // key would leave these rows unreadable, so the gate reports them and blocks
  // apply while any is set.
  { table: "hivra_buzz_agent_bindings", column: "encrypted_private_key" },
  { table: "hivra_buzz_agent_bindings", column: "encrypted_invite_code" },
  { table: "hivra_buzz_agent_bindings", column: "encrypted_runtime_api_key" },
] as const;

export type RotationDependency = (typeof UNHANDLED_ROTATION_DEPENDENCIES)[number];
export type RotationCoverageReader = (dependency: RotationDependency) => Promise<number>;
export type RotationCoverage = {
  observations: Array<{ table: string; column: string; count: number | null }>;
  blocksApply: boolean;
  keyRetirementProven: false;
};

export async function inspectRotationCoverage(read: RotationCoverageReader): Promise<RotationCoverage> {
  const observations: RotationCoverage["observations"] = [];
  for (const dependency of UNHANDLED_ROTATION_DEPENDENCIES) {
    let count: number | null = null;
    try {
      const observed = await read(dependency);
      if (Number.isSafeInteger(observed) && observed >= 0) count = observed;
    } catch {
      // Missing tables, permissions, unavailable reads and malformed responses
      // are unknown, never zero. Database diagnostics may contain secrets.
    }
    observations.push({ table: dependency.table, column: dependency.column, count });
  }
  return {
    observations,
    blocksApply: observations.some(({ count }) => count !== 0),
    keyRetirementProven: false,
  };
}

export function formatRotationCoverage(coverage: RotationCoverage): string {
  return [
    "Known unhandled key dependencies (non-null counts only):",
    ...coverage.observations.map(({ table, column, count }) =>
      `${table}.${column}: ${count === null ? "unknown" : count}`),
    coverage.blocksApply
      ? "Apply blocked: unhandled data is present or a required count is unknown."
      : "No unhandled data observed in these reads; this is not an atomic snapshot.",
    "Key retirement is NOT proven. Retain recovery keys and encrypted backups.",
  ].join("\n");
}
