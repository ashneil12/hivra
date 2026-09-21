import { PLANS, getPlan, getStripePriceId, formatPrice, ACTIVE_PLAN_KEYS, getTrialDays } from '@/lib/subscription';

describe('Subscription Plans', () => {
  describe('PLANS', () => {
    it('defines exactly the available plan definitions', () => {
      expect(Object.keys(PLANS)).toEqual([
        'free',
        'operator',
        'fleet',
        'command',
      ]);
    });

    it.each(Object.entries(PLANS))('%s has valid structure', (_key, plan) => {
      expect(plan.name).toBeTruthy();
      expect(plan.price).toBeGreaterThanOrEqual(0);
      expect(plan.maxAgents).toBeGreaterThanOrEqual(1);
      expect(plan.maxCpuPerAgent).toBeGreaterThan(0);
      expect(plan.maxRamPerAgent).toBeGreaterThanOrEqual(1024);
      expect(plan.totalCpu).toBeGreaterThan(0);
      expect(plan.totalRam).toBeGreaterThan(0);
      expect(plan.features.length).toBeGreaterThan(0);
      expect(plan.specs).toBeDefined();
    });

    it('higher base tiers have more resources', () => {
      expect(PLANS.operator.totalCpu).toBeGreaterThan(PLANS.free.totalCpu);
      expect(PLANS.fleet.totalCpu).toBeGreaterThan(PLANS.operator.totalCpu);
      expect(PLANS.command.totalCpu).toBeGreaterThan(PLANS.fleet.totalCpu);
      expect(PLANS.free.maxAgents).toBe(1);
      expect(PLANS.operator.maxAgents).toBe(3);
      expect(PLANS.fleet.maxAgents).toBe(5);
      expect(PLANS.command.maxAgents).toBe(8);
    });

    it('total resources can accommodate maxAgents at per-agent caps', () => {
      for (const plan of Object.values(PLANS)) {
        // At minimum, the pool should support at least one agent at max per-agent specs
        expect(plan.totalCpu).toBeGreaterThanOrEqual(plan.maxCpuPerAgent);
        expect(plan.totalRam).toBeGreaterThanOrEqual(plan.maxRamPerAgent);
      }
    });

    it('keeps public plan copy aligned with slot limits instead of unlimited profiles', () => {
      const forbidden = [
        /unlimited/i,
        /operator profiles?/i,
        /operator profiels?/i,
      ];

      for (const plan of Object.values(PLANS)) {
        const copy = [
          plan.description,
          plan.tagline,
          ...plan.features,
          ...Object.values(plan.specs),
        ].join(" ");

        for (const pattern of forbidden) {
          expect(copy).not.toMatch(pattern);
        }

        expect(plan.specs.agents).toContain(String(plan.maxAgents));
      }
    });

    it('names active-agent counts in sellable plan descriptions', () => {
      for (const key of ACTIVE_PLAN_KEYS) {
        const plan = PLANS[key];
        expect(plan.description).toMatch(new RegExp(`\\b${plan.maxAgents}\\b`));
        expect(plan.description).toMatch(/active agent/i);
      }
    });
  });

  describe('getPlan()', () => {
    it('returns correct plan for valid key (UI labels Pro/Power, internal keys operator/fleet)', () => {
      expect(getPlan('operator').name).toBe('Pro');
      expect(getPlan('fleet').name).toBe('Power');
      expect(getPlan('command').name).toBe('Command');
    });

    it('falls back to operator for invalid key', () => {
      expect(getPlan('nonexistent').name).toBe('Pro');
      expect(getPlan('').name).toBe('Pro');
    });
  });

  describe('getStripePriceId()', () => {
    it('throws when Stripe Price ID not configured', () => {
      const original = PLANS.operator.stripePriceId;
      // @ts-expect-error - overriding readonly for test
      PLANS.operator.stripePriceId = "";
      
      expect(() => getStripePriceId('operator')).toThrow('Stripe Price ID not configured');
      
      // @ts-expect-error - restoring readonly for test
      PLANS.operator.stripePriceId = original;
    });
  });

  describe('formatPrice()', () => {
    it('formats cents correctly', () => {
      expect(formatPrice(1900)).toBe('$19');
      expect(formatPrice(2900)).toBe('$29');
      expect(formatPrice(4900)).toBe('$49');
    });
  });

  describe('ACTIVE_PLAN_KEYS', () => {
    it('contains all sellable plan keys', () => {
      expect(ACTIVE_PLAN_KEYS).toEqual(['free', 'operator', 'fleet']);
    });
  });

  describe('pricing structure', () => {
    it('has expected prices (Pro/Power dropped to launch rates 2026-04-30; Command unchanged)', () => {
      expect(PLANS.free.price).toBe(0);
      expect(PLANS.operator.price).toBe(999);
      expect(PLANS.fleet.price).toBe(1999);
      expect(PLANS.command.price).toBe(4900);
    });

    it('free: one agent, 0.5 CPU, 1GB', () => {
      expect(PLANS.free.name).toBe('Free');
      expect(PLANS.free.maxAgents).toBe(1);
      expect(PLANS.free.maxCpuPerAgent).toBe(0.5);
      expect(PLANS.free.maxRamPerAgent).toBe(1024);
      expect(PLANS.free.totalCpu).toBe(0.5);
      expect(PLANS.free.totalRam).toBe(1024);
    });

    it('operator: 3 agents, 2 CPU, 4GB', () => {
      expect(PLANS.operator.maxAgents).toBe(3);
      expect(PLANS.operator.totalCpu).toBe(2);
      expect(PLANS.operator.totalRam).toBe(4096);
    });

    it('fleet: 5 agents, 4 CPU, 8GB', () => {
      expect(PLANS.fleet.maxAgents).toBe(5);
      expect(PLANS.fleet.maxCpuPerAgent).toBe(4);
      expect(PLANS.fleet.maxRamPerAgent).toBe(8192);
      expect(PLANS.fleet.totalCpu).toBe(4);
      expect(PLANS.fleet.totalRam).toBe(8192);
    });

    it('command: 8 agents, 8 CPU, 16GB', () => {
      expect(PLANS.command.maxAgents).toBe(8);
      expect(PLANS.command.maxCpuPerAgent).toBe(8);
      expect(PLANS.command.maxRamPerAgent).toBe(16384);
      expect(PLANS.command.totalCpu).toBe(8);
      expect(PLANS.command.totalRam).toBe(16384);
    });
  });

  describe('trial days', () => {
    it('operator has no trial', () => {
      expect(PLANS.operator.trialDays).toBe(0);
      expect(getTrialDays('operator')).toBe(0);
    });

    it('fleet has no trial', () => {
      expect(PLANS.fleet.trialDays).toBe(0);
      expect(getTrialDays('fleet')).toBe(0);
    });

    it('command has no trial', () => {
      expect(PLANS.command.trialDays).toBe(0);
      expect(getTrialDays('command')).toBe(0);
    });
  });
});
