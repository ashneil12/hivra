import { summarizeInstanceUsage, type UsageSnapshotRow } from "@/lib/usage-summary";

const row = (over: Partial<UsageSnapshotRow> & { stat_date: string }): UsageSnapshotRow => ({
  total_tokens: 0,
  sessions: 0,
  api_calls: 0,
  tool_calls: 0,
  estimated_cost_usd: 0,
  by_model: null,
  ...over,
});

describe("summarizeInstanceUsage", () => {
  it("sums counters and tracks active days + last active date", () => {
    const s = summarizeInstanceUsage(
      [
        row({ stat_date: "2026-06-10", sessions: 3, api_calls: 12, tool_calls: 4, total_tokens: 1000, estimated_cost_usd: 0.5 }),
        row({ stat_date: "2026-06-12", sessions: 2, api_calls: 8, tool_calls: 1, total_tokens: 500, estimated_cost_usd: 0.25 }),
        row({ stat_date: "2026-06-11" }), // zero-activity day — not counted active
      ],
      7,
    );
    expect(s.sessions).toBe(5);
    expect(s.apiCalls).toBe(20);
    expect(s.toolCalls).toBe(5);
    expect(s.totalTokens).toBe(1500);
    expect(s.estimatedCostUsd).toBeCloseTo(0.75);
    expect(s.activeDays).toBe(2);
    expect(s.lastActiveDate).toBe("2026-06-12");
    expect(s.isEmpty).toBe(false);
    expect(s.days).toBe(7);
  });

  it("picks the top model by aggregated tokens across days", () => {
    const s = summarizeInstanceUsage(
      [
        row({ stat_date: "2026-06-10", total_tokens: 300, sessions: 1, by_model: { "hermes-4": { tokens: 200 }, "gpt-4o": { tokens: 100 } } }),
        row({ stat_date: "2026-06-11", total_tokens: 400, sessions: 1, by_model: { "gpt-4o": { tokens: 400 } } }),
      ],
      7,
    );
    // gpt-4o: 100+400=500 > hermes-4: 200
    expect(s.topModel).toBe("gpt-4o");
  });

  it("flags an empty window and leaves topModel null", () => {
    const s = summarizeInstanceUsage([], 7);
    expect(s.isEmpty).toBe(true);
    expect(s.sessions).toBe(0);
    expect(s.topModel).toBeNull();
    expect(s.lastActiveDate).toBeNull();
    expect(s.activeDays).toBe(0);
  });

  it("ignores null/garbage counters and zero-token models", () => {
    const s = summarizeInstanceUsage(
      [
        row({ stat_date: "2026-06-10", sessions: null, api_calls: null, total_tokens: null, by_model: { "x": { tokens: 0 }, "y": { tokens: null } } }),
        row({ stat_date: "2026-06-11", tool_calls: 2, total_tokens: 50, by_model: { "z": { tokens: 50 } } }),
      ],
      7,
    );
    expect(s.toolCalls).toBe(2);
    expect(s.totalTokens).toBe(50);
    expect(s.topModel).toBe("z");
    expect(s.activeDays).toBe(1);
  });
});
