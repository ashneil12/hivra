import {
  aggregateManagedVeniceUsage,
  modalityFromEndpoint,
  getManagedVeniceUsageSummary,
  type UsageEventRow,
} from "@/lib/billing/managed-venice-usage-summary";

describe("modalityFromEndpoint", () => {
  it("buckets each endpoint family", () => {
    expect(modalityFromEndpoint("/api/v1/chat/completions")).toBe("chat");
    expect(modalityFromEndpoint("/api/v1/image/generate")).toBe("image");
    expect(modalityFromEndpoint("/api/v1/videos/queue")).toBe("video");
    expect(modalityFromEndpoint("/api/v1/audio/speech")).toBe("audio");
    expect(modalityFromEndpoint("/api/v1/embeddings")).toBe("embeddings");
    expect(modalityFromEndpoint("/api/v1/augment/search")).toBe("search");
    expect(modalityFromEndpoint(null)).toBe("other");
  });
});

describe("aggregateManagedVeniceUsage", () => {
  const now = new Date("2026-06-15T00:00:00Z"); // 15th of a 30-day month
  const rows: UsageEventRow[] = [
    { endpoint: "/api/v1/chat/completions", model: "deepseek-v4-pro", charged_micro_usd: 1000, prompt_tokens: 100, completion_tokens: 50 },
    { endpoint: "/api/v1/chat/completions", model: "deepseek-v4-pro", charged_micro_usd: 2000, prompt_tokens: 200, completion_tokens: 80 },
    { endpoint: "/api/v1/chat/completions", model: "qwen3-235b", charged_micro_usd: 500, prompt_tokens: 40, completion_tokens: 20 },
    { endpoint: "/api/v1/image/generate", model: "venice-sd35", charged_micro_usd: 0 },
  ];

  it("totals charged + request count", () => {
    const s = aggregateManagedVeniceUsage(rows, now);
    expect(s.totalChargedMicroUsd).toBe(3500);
    expect(s.totalRequests).toBe(4);
    expect(s.monthStart).toBe("2026-06-01T00:00:00.000Z");
  });

  it("groups by model, sorted by spend, summing tokens", () => {
    const s = aggregateManagedVeniceUsage(rows, now);
    expect(s.byModel[0]).toEqual({ model: "deepseek-v4-pro", chargedMicroUsd: 3000, requests: 2, promptTokens: 300, completionTokens: 130 });
    expect(s.byModel[1].model).toBe("qwen3-235b");
  });

  it("groups by modality", () => {
    const s = aggregateManagedVeniceUsage(rows, now);
    const chat = s.byModality.find((m) => m.modality === "chat")!;
    const image = s.byModality.find((m) => m.modality === "image")!;
    expect(chat).toEqual({ modality: "chat", chargedMicroUsd: 3500, requests: 3 });
    expect(image).toEqual({ modality: "image", chargedMicroUsd: 0, requests: 1 });
  });

  it("projects linearly to month end (spend/day × days-in-month)", () => {
    const s = aggregateManagedVeniceUsage(rows, now);
    // 3500 over 15 days → 233.33/day × 30 = 7000
    expect(s.projectedMonthEndMicroUsd).toBe(7000);
  });

  it("does not inflate the projection on the 1st of the month", () => {
    // On day 1 only a fraction of a day has elapsed; multiplying by ~30 would
    // wildly inflate the projection for new spenders. Fall back to the actual
    // month-to-date total instead.
    const day1 = new Date("2026-06-01T06:00:00Z");
    const s = aggregateManagedVeniceUsage(rows, day1);
    expect(s.projectedMonthEndMicroUsd).toBe(3500);
  });

  it("tolerates missing fields", () => {
    const s = aggregateManagedVeniceUsage([{ charged_micro_usd: 100 }, {}], now);
    expect(s.totalChargedMicroUsd).toBe(100);
    expect(s.byModel.find((m) => m.model === "unknown")?.requests).toBe(2);
  });
});

describe("getManagedVeniceUsageSummary", () => {
  it("queries this user's events since the month start and aggregates", async () => {
    const capture: { gte?: unknown; eq?: unknown } = {};
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    chain.select = ret;
    chain.eq = (_c: string, v: unknown) => { capture.eq = v; return chain; };
    chain.gte = (_c: string, v: unknown) => { capture.gte = v; return chain; };
    chain.then = (resolve: (x: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: [{ endpoint: "/api/v1/chat/completions", model: "m", charged_micro_usd: 42 }], error: null }).then(resolve);
    const db = { from: () => chain };
    const s = await getManagedVeniceUsageSummary("user-9", new Date("2026-06-10T00:00:00Z"), db);
    expect(capture.eq).toBe("user-9");
    expect(capture.gte).toBe("2026-06-01T00:00:00.000Z");
    expect(s.totalChargedMicroUsd).toBe(42);
  });
});
