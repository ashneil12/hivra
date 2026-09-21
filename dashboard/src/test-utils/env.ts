/**
 * Deterministic env setup for tests that touch encryption / signing.
 *
 * Several suites set ENCRYPTION_KEY and friends to fixed values in
 * beforeEach; this keeps the value (and its teardown) in one place.
 */
const ENV_DEFAULTS = {
  ENCRYPTION_KEY: "a".repeat(64),
} as const;

export function setTestEnv(overrides: Record<string, string> = {}): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ ...ENV_DEFAULTS, ...overrides })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const key of Object.keys({ ...ENV_DEFAULTS, ...overrides })) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}
