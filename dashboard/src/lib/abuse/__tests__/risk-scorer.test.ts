import {
  computeScore,
  scoreToTier,
  tierToDecision,
} from "@/lib/abuse/risk-scorer";
import type { NetworkSignals } from "@/lib/abuse/proxycheck";
import type { EmailSignals } from "@/lib/abuse/disposable-email";
import type { FingerprintSignals } from "@/lib/abuse/fingerprint";

// ── helpers ────────────────────────────────────────────────────────────────

function network(overrides: Partial<NetworkSignals> = {}): NetworkSignals {
  return {
    ip: "203.0.113.4",
    asn: "AS12345",
    asnOrganization: "Example ISP",
    countryCode: "US",
    isVpn: false,
    isProxy: false,
    isTor: false,
    isDatacenter: false,
    upstreamRiskScore: null,
    raw: {},
    ...overrides,
  };
}

function email(overrides: Partial<EmailSignals> = {}): EmailSignals {
  return {
    domain: "example.com",
    isDisposable: false,
    ...overrides,
  };
}

function fingerprint(
  overrides: Partial<FingerprintSignals> = {}
): FingerprintSignals {
  return {
    visitorId: "visitor_abc",
    requestId: "req_xyz",
    confidence: 0.95,
    incognito: false,
    bot: false,
    vpn: false,
    ipChanged: false,
    raw: {},
    ...overrides,
  };
}

// ── scoreToTier / tierToDecision ───────────────────────────────────────────

describe("scoreToTier", () => {
  it.each([
    ["buckets 0 as low", 0, "low"],
    ["buckets 29 as low (top of range)", 29, "low"],
    ["buckets 30 as medium (just above low)", 30, "medium"],
    ["buckets 59 as medium (top of range)", 59, "medium"],
    ["buckets 60 as high", 60, "high"],
    ["buckets 84 as high (top of range)", 84, "high"],
    ["buckets 85 as critical", 85, "critical"],
    ["buckets 100 as critical", 100, "critical"],
  ] as const)("%s", (_label, score, tier) => {
    expect(scoreToTier(score)).toBe(tier);
  });
});

describe("tierToDecision", () => {
  it.each([
    ["low → allow", "low", "allow"],
    ["medium → require_card", "medium", "require_card"],
    ["high → require_card", "high", "require_card"],
    ["critical → block", "critical", "block"],
  ] as const)("%s", (_label, tier, decision) => {
    expect(tierToDecision(tier)).toBe(decision);
  });
});

// ── computeScore — single-signal contributions ─────────────────────────────

describe("computeScore — single signals", () => {
  const input = (
    overrides: Partial<Parameters<typeof computeScore>[0]> = {}
  ): Parameters<typeof computeScore>[0] => ({
    network: null,
    email: null,
    fingerprint: null,
    fingerprintCollisionCount: 0,
    ...overrides,
  });

  it("returns 0 with no signals", () => {
    const { score, reasons } = computeScore(input());
    expect(score).toBe(0);
    expect(reasons).toEqual([]);
  });

  const singleCases: Array<
    [string, Partial<Parameters<typeof computeScore>[0]>, number, string | null]
  > = [
    ["Tor exit node alone → 50 (medium tier)", { network: network({ isTor: true }) }, 50, "medium"],
    ["VPN alone → 25 (low tier)", { network: network({ isVpn: true }) }, 25, "low"],
    ["datacenter IP alone → 30 (medium tier — crypto miner signal)", { network: network({ isDatacenter: true }) }, 30, "medium"],
    ["disposable email alone → 30 (medium tier)", { email: email({ isDisposable: true }) }, 30, "medium"],
    ["FPJS bot signal alone → 50 (medium tier)", { fingerprint: fingerprint({ bot: true }) }, 50, null],
    ["FPJS low confidence (<0.5) adds 10", { fingerprint: fingerprint({ confidence: 0.3 }) }, 10, null],
    ["FPJS confidence at 0.5 does NOT add (boundary)", { fingerprint: fingerprint({ confidence: 0.5 }) }, 0, null],
    ["proxycheck risk score 80+ adds 20", { network: network({ upstreamRiskScore: 90 }) }, 20, null],
    ["proxycheck risk score 79 does NOT add (boundary)", { network: network({ upstreamRiskScore: 79 }) }, 0, null],
  ];
  it.each(singleCases)("%s", (_label, overrides, expected, tier) => {
    const { score, reasons } = computeScore(input(overrides));
    expect(score).toBe(expected);
    if (tier) expect(scoreToTier(score)).toBe(tier);
    if (overrides.network?.isTor) {
      expect(reasons[0]).toMatch(/^tor_exit_node/);
    }
  });
});

// ── computeScore — fingerprint collision capping ───────────────────────────

describe("computeScore — fingerprint collisions", () => {
  it.each([
    ["1 collision → 40", 1, 40],
    ["2 collisions caps at 60 (not 80)", 2, 60],
    ["10 collisions still caps at 60", 10, 60],
    ["0 collisions adds nothing", 0, 0],
  ] as const)("%s", (_label, collisions, expected) => {
    const { score, reasons } = computeScore({
      network: null,
      email: null,
      fingerprint: fingerprint(),
      fingerprintCollisionCount: collisions,
    });
    expect(score).toBe(expected);
    if (collisions === 2) expect(reasons.some((r) => r.includes("(+60)"))).toBe(true);
    if (collisions === 0) expect(reasons).toEqual([]);
  });
});

// ── computeScore — combined signals (the cases that actually matter) ───────

describe("computeScore — realistic abuse patterns", () => {
  it("clean residential signup → 0 (allow)", () => {
    const { score } = computeScore({
      network: network(),
      email: email(),
      fingerprint: fingerprint(),
      fingerprintCollisionCount: 0,
    });
    expect(score).toBe(0);
    expect(tierToDecision(scoreToTier(score))).toBe("allow");
  });

  it("VPN user with clean fingerprint → require_card (medium)", () => {
    // 25 (vpn) + 15 (fpjs vpn cross-signal) = 40 → medium → require_card
    const { score } = computeScore({
      network: network({ isVpn: true }),
      email: email(),
      fingerprint: fingerprint({ vpn: true }),
      fingerprintCollisionCount: 0,
    });
    expect(score).toBe(40);
    expect(tierToDecision(scoreToTier(score))).toBe("require_card");
  });

  it("Tor + disposable email → require_card (high tier)", () => {
    // 50 (tor) + 30 (disposable) = 80 → high → require_card
    const { score } = computeScore({
      network: network({ isTor: true }),
      email: email({ isDisposable: true }),
      fingerprint: fingerprint(),
      fingerprintCollisionCount: 0,
    });
    expect(score).toBe(80);
    expect(scoreToTier(score)).toBe("high");
    expect(tierToDecision(scoreToTier(score))).toBe("require_card");
  });

  it("Tor + disposable + fingerprint collision → block (critical)", () => {
    // 50 (tor) + 30 (disposable) + 40 (1 collision) = 120 → clamped to 100 → critical → block
    const { score } = computeScore({
      network: network({ isTor: true }),
      email: email({ isDisposable: true }),
      fingerprint: fingerprint(),
      fingerprintCollisionCount: 1,
    });
    expect(score).toBe(100);
    expect(scoreToTier(score)).toBe("critical");
    expect(tierToDecision(scoreToTier(score))).toBe("block");
  });

  it("datacenter IP + bot → block (critical)", () => {
    // 30 (datacenter) + 50 (bot) = 80 → high → require_card
    // (Note: bot+datacenter is a strong abuse signal but still recoverable
    // with a card. If we want to BLOCK these, raise FPJS_BOT to 60.)
    const { score } = computeScore({
      network: network({ isDatacenter: true }),
      email: email(),
      fingerprint: fingerprint({ bot: true }),
      fingerprintCollisionCount: 0,
    });
    expect(score).toBe(80);
    expect(tierToDecision(scoreToTier(score))).toBe("require_card");
  });

  it("score is clamped to 100 when signals would overflow", () => {
    // Tor 50 + disposable 30 + bot 50 + collision cap 60 + datacenter 30 = 220
    // → clamped to 100
    const { score } = computeScore({
      network: network({ isTor: true, isDatacenter: true }),
      email: email({ isDisposable: true }),
      fingerprint: fingerprint({ bot: true }),
      fingerprintCollisionCount: 5,
    });
    expect(score).toBe(100);
  });
});
