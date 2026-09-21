import { isPlanUpgrade, getPlanDiff, getPlan, formatPrice, getTrialDays } from '../lib/subscription/plans';

describe('Subscription Plans Logic', () => {
  describe('isPlanUpgrade', () => {
    it('should correctly identify a plan upgrade', () => {
      expect(isPlanUpgrade('operator', 'fleet')).toBe(true);
      expect(isPlanUpgrade('operator', 'command')).toBe(true);
      expect(isPlanUpgrade('fleet', 'command')).toBe(true);
    });

    it('should return false for plan downgrades or same plan', () => {
      expect(isPlanUpgrade('command', 'fleet')).toBe(false);
      expect(isPlanUpgrade('fleet', 'operator')).toBe(false);
      expect(isPlanUpgrade('operator', 'operator')).toBe(false);
    });
  });

  describe('getPlanDiff', () => {
    it('should return more agent slots when upgrading', () => {
      const diff = getPlanDiff('operator', 'fleet');
      expect(diff.agents).toBe(2); // 5 - 3
      expect(diff.cpu).toBe(2); // 4 - 2
      expect(diff.ramGb).toBe(4); // 8 - 4
    });

    it('should return negative differences for resources when downgrading', () => {
      const diff = getPlanDiff('command', 'operator');
      expect(diff.agents).toBe(-5); // 3 - 8
      expect(diff.cpu).toBe(-6); // 2 - 8
      expect(diff.ramGb).toBe(-12); // 4 - 16
    });
  });

  describe('getPlan', () => {
    it('should return the correct plan object', () => {
      // Internal key is `fleet`; user-facing label is "Power".
      const plan = getPlan('fleet');
      expect(plan.name).toBe('Power');
      expect(plan.maxAgents).toBe(5);
    });

    it('should fallback to operator for invalid plan keys', () => {
      // Internal fallback is the `operator` key; UI label is "Pro".
      const plan = getPlan('non_existent_plan');
      expect(plan.name).toBe('Pro');
      expect(plan.maxAgents).toBe(3);
    });
  });

  describe('formatPrice', () => {
    it('should correctly format cents to dollars string', () => {
      expect(formatPrice(1900)).toBe('$19');
      expect(formatPrice(4900)).toBe('$49');
      expect(formatPrice(0)).toBe('$0');
    });
  });

  describe('getTrialDays', () => {
    it('should return 0 for operator', () => {
      expect(getTrialDays('operator')).toBe(0);
    });

    it('should return 0 for fleet', () => {
      expect(getTrialDays('fleet')).toBe(0);
    });

    it('should return 0 for command', () => {
      expect(getTrialDays('command')).toBe(0);
    });

    it('should return 0 for unknown plan (falls back to operator)', () => {
      expect(getTrialDays('unknown_plan')).toBe(0);
    });
  });
});
