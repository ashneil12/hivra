import { assessDesktopLatencyCampaign, type DesktopLatencyCampaign } from "../latency-evidence";

function campaign(overrides: Partial<DesktopLatencyCampaign> = {}): DesktopLatencyCampaign {
  return {
    transportId: "sunshine-moonlight",
    transportRevision: "14ffa6fdaa53f7b51512be2b3d24f3939695403c",
    adapterRevision: "adapter-sha",
    imageDigest: `sha256:${"a".repeat(64)}`,
    profile: "1080p60",
    condition: "regional-wired-reference",
    route: "direct",
    evidenceClass: "browser-telemetry",
    samples: Array.from({ length: 200 }, (_, sequence) => ({
      sequence,
      inputToVisibleMs: sequence < 190 ? 50 : 75,
      rttMs: 20,
      jitterMs: 0.8,
      packetLossPercent: 0.1,
      encodeMs: 4,
      decodeMs: 3,
    })),
    ...overrides,
  };
}

describe("desktop latency evidence", () => {
  it("accepts a complete 200-sample telemetry campaign without calling it physical proof", () => {
    const summary = assessDesktopLatencyCampaign(campaign());

    expect(summary).toMatchObject({
      sampleCount: 200,
      p50InputToVisibleMs: 50,
      p95InputToVisibleMs: 50,
      p99InputToVisibleMs: 75,
      p95RttMs: 20,
      evidenceClass: "browser-telemetry",
      accepted: true,
      issues: [],
    });
  });

  it("requires pinned raw optical evidence before accepting a physical latency claim", () => {
    const summary = assessDesktopLatencyCampaign(campaign({ evidenceClass: "optical" }));

    expect(summary.accepted).toBe(false);
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OPTICAL_PROOF_MISSING" }),
    ]));
  });

  it("includes optical uncertainty in the latency budget", () => {
    const summary = assessDesktopLatencyCampaign(campaign({
      evidenceClass: "optical",
      optical: {
        method: "1000fps input LED and display capture",
        uncertaintyMs: 12,
        recordingSha256: "b".repeat(64),
      },
      samples: Array.from({ length: 200 }, (_, sequence) => ({
        sequence,
        inputToVisibleMs: 50,
        rttMs: 20,
        jitterMs: 1,
        packetLossPercent: 0,
        encodeMs: 4,
        decodeMs: 3,
      })),
    }));

    expect(summary.accepted).toBe(false);
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "P50_BUDGET_EXCEEDED" }),
    ]));
  });

  it("rejects insufficient, invalid, duplicate, and over-budget samples", () => {
    const samples = Array.from({ length: 199 }, (_, sequence) => ({
      sequence,
      inputToVisibleMs: 120,
      rttMs: 40,
      jitterMs: 2,
      packetLossPercent: sequence === 0 ? 101 : 0,
      encodeMs: 5,
      decodeMs: 4,
    }));
    samples[198] = { ...samples[198], sequence: 197 };

    const summary = assessDesktopLatencyCampaign(campaign({ samples }));

    expect(summary.accepted).toBe(false);
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      "INSUFFICIENT_SAMPLES",
      "DUPLICATE_SEQUENCE",
      "INVALID_SAMPLE",
      "REFERENCE_RTT_EXCEEDED",
      "P50_BUDGET_EXCEEDED",
      "P95_BUDGET_EXCEEDED",
    ]);
  });
});
