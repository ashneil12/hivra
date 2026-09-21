/**
 * Trial-experiment assignment tests. The contract this locks in:
 *   - fnv1a32 bucketing is deterministic: same userId → same bucket, always
 *   - TRIAL_EXPERIMENT_PERCENT boundaries: 0 → everyone control,
 *     100 → everyone trial, and the exact hash-mod boundary is respected
 *   - getTrialDaysForUser gating matrix: 7 only when enabled AND 'trial'
 *     bucket AND paid plan; every other combination falls through to the
 *     plan's own trialDays (0 for all plans today)
 *   - default env (nothing set) is fully inert
 */

import {
  bucketForUser,
  fnv1a32,
  getTrialDaysForUser,
  isTrialExperimentEnabled,
  trialExperimentPercent,
  TRIAL_EXPERIMENT_TRIAL_DAYS,
} from "@/lib/billing/trial-experiment";

const USER = "user_2abcDEF345";

describe("trial-experiment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TRIAL_EXPERIMENT_ENABLED;
    delete process.env.TRIAL_EXPERIMENT_PERCENT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("fnv1a32", () => {
    it("is deterministic and 32-bit unsigned", () => {
      const a = fnv1a32(USER);
      expect(fnv1a32(USER)).toBe(a);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(a)).toBe(true);
    });

    it("distinguishes different ids", () => {
      expect(fnv1a32("user_a")).not.toBe(fnv1a32("user_b"));
    });
  });

  describe("bucketForUser percent boundaries", () => {
    it("0% (default) buckets everyone control", () => {
      for (const id of ["user_1", "user_2", USER, "user_zzz"]) {
        expect(bucketForUser(id)).toBe("control");
      }
    });

    it("100% buckets everyone trial", () => {
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      for (const id of ["user_1", "user_2", USER, "user_zzz"]) {
        expect(bucketForUser(id)).toBe("trial");
      }
    });

    it("hash mod 100 < percent is the exact boundary (inclusive below, exclusive at)", () => {
      const mod = fnv1a32(USER) % 100;
      // percent === mod → control (strict <)
      process.env.TRIAL_EXPERIMENT_PERCENT = String(mod);
      expect(bucketForUser(USER)).toBe("control");
      // percent === mod + 1 → trial
      process.env.TRIAL_EXPERIMENT_PERCENT = String(mod + 1);
      expect(bucketForUser(USER)).toBe("trial");
    });

    it("is stable across repeated calls (deterministic assignment)", () => {
      process.env.TRIAL_EXPERIMENT_PERCENT = "50";
      const first = bucketForUser(USER);
      for (let i = 0; i < 10; i++) expect(bucketForUser(USER)).toBe(first);
    });

    it("clamps malformed/out-of-range percent", () => {
      process.env.TRIAL_EXPERIMENT_PERCENT = "150";
      expect(trialExperimentPercent()).toBe(100);
      process.env.TRIAL_EXPERIMENT_PERCENT = "-5";
      expect(trialExperimentPercent()).toBe(0);
      process.env.TRIAL_EXPERIMENT_PERCENT = "not-a-number";
      expect(trialExperimentPercent()).toBe(0);
      delete process.env.TRIAL_EXPERIMENT_PERCENT;
      expect(trialExperimentPercent()).toBe(0);
    });
  });

  describe("isTrialExperimentEnabled", () => {
    it("defaults off and reads truthy strings", () => {
      expect(isTrialExperimentEnabled()).toBe(false);
      process.env.TRIAL_EXPERIMENT_ENABLED = "false";
      expect(isTrialExperimentEnabled()).toBe(false);
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      expect(isTrialExperimentEnabled()).toBe(true);
      process.env.TRIAL_EXPERIMENT_ENABLED = "1";
      expect(isTrialExperimentEnabled()).toBe(true);
    });
  });

  describe("getTrialDaysForUser gating matrix", () => {
    it("disabled (default env) → plan trialDays (0), even at 100%", () => {
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      expect(getTrialDaysForUser(USER, "operator")).toBe(0);
    });

    it("enabled but 0% → control bucket → plan trialDays (0)", () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      expect(getTrialDaysForUser(USER, "operator")).toBe(0);
    });

    it("enabled + trial bucket + paid plan → 7", () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      expect(getTrialDaysForUser(USER, "operator")).toBe(TRIAL_EXPERIMENT_TRIAL_DAYS);
      expect(getTrialDaysForUser(USER, "fleet")).toBe(TRIAL_EXPERIMENT_TRIAL_DAYS);
    });

    it("enabled + trial bucket + free plan → 0 (free never trials)", () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
      expect(getTrialDaysForUser(USER, "free")).toBe(0);
    });

    it("enabled + control bucket + paid plan → plan trialDays (0)", () => {
      process.env.TRIAL_EXPERIMENT_ENABLED = "true";
      const mod = fnv1a32(USER) % 100;
      process.env.TRIAL_EXPERIMENT_PERCENT = String(mod); // strict < → control
      expect(getTrialDaysForUser(USER, "operator")).toBe(0);
    });
  });
});
