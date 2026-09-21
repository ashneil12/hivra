import crypto from "node:crypto";
import { NextRequest } from "next/server";

import { POST } from "../route";
import { normalizeUsageRows } from "../usage-normalization";
import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function makeRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/agent-usage/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function mockInstance(row: unknown) {
  const instanceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
  };
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const snapshots = { upsert };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return instanceQuery;
    if (table === "instance_usage_snapshots") return snapshots;
    throw new Error(`Unexpected table ${table}`);
  });

  return { instanceQuery, upsert };
}

function mockOperatorSource(row: unknown) {
  const instanceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  const sourceQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
  };
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const snapshots = { upsert };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return instanceQuery;
    if (table === "operator_usage_sources") return sourceQuery;
    if (table === "operator_usage_snapshots") return snapshots;
    throw new Error(`Unexpected table ${table}`);
  });

  return { instanceQuery, sourceQuery, upsert };
}

const VALID_BODY = {
  instanceId: "00000000-0000-4000-8000-000000001032",
  days: [
    {
      stat_date: "2026-05-27",
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 500,
      reasoning_tokens: 7,
      estimated_cost_usd: 0.03,
      sessions: 2,
      api_calls: 6,
      by_model: { "gpt-5.5": { tokens: 140, requests: 6 } },
      by_provider: { "openai-codex": { tokens: 140, requests: 6 } },
    },
  ],
};

describe("normalizeUsageRows", () => {
  it("normalizes totals and legacy day/estimated_cost field names", () => {
    expect(
      normalizeUsageRows([
        {
          day: "2026-05-27",
          input_tokens: 10,
          output_tokens: 5,
          estimated_cost: 0.02,
        },
      ])
    ).toEqual([
      expect.objectContaining({
        stat_date: "2026-05-27",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        estimated_cost_usd: 0.02,
        by_model: {},
        by_provider: {},
      }),
    ]);
  });

  it("rejects invalid dates and negative counters", () => {
    expect(normalizeUsageRows([{ stat_date: "2026-5-7", input_tokens: 1, output_tokens: 1 }])).toBeNull();
    expect(normalizeUsageRows([{ stat_date: "2026-05-27", input_tokens: -1, output_tokens: 1 }])).toBeNull();
  });
});

describe("POST /api/agent-usage/ingest", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (decryptApiKey as jest.Mock).mockReturnValue("agent-secret");
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ error: null });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleErrorSpy.mockRestore();
  });

  it("returns 401 without a bearer", async () => {
    mockInstance({ api_server_key_encrypted: "enc" });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer does not match the instance key", async () => {
    mockInstance({ api_server_key_encrypted: "enc" });
    const res = await POST(makeRequest(VALID_BODY, "Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("upserts aggregate usage rows and refreshes affected daily rollups", async () => {
    const { instanceQuery, upsert } = mockInstance({ api_server_key_encrypted: "enc" });

    const res = await POST(makeRequest(VALID_BODY, "Bearer agent-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ ingested: 1, instanceId: VALID_BODY.instanceId, source: "agent_usage_beacon" });
    expect(instanceQuery.eq).toHaveBeenCalledWith("id", VALID_BODY.instanceId);
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          instance_id: VALID_BODY.instanceId,
          stat_date: "2026-05-27",
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          cache_read_tokens: 500,
          reasoning_tokens: 7,
          estimated_cost_usd: 0.03,
          sessions: 2,
          api_calls: 6,
          by_model: { "gpt-5.5": { tokens: 140, requests: 6 } },
          by_provider: { "openai-codex": { tokens: 140, requests: 6 } },
          source: "agent_usage_beacon",
        }),
      ],
      { onConflict: "instance_id,stat_date" }
    );
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith("compute_platform_stats_snapshot", { p_date: "2026-05-27" });
  });

  it("accepts a registered internal operator source without a prod instance row", async () => {
    const { sourceQuery, upsert } = mockOperatorSource({
      id: VALID_BODY.instanceId,
      name: "PB10 Augustine",
      source_type: "internal_operator_canary",
      api_key_sha256: sha256Hex("agent-secret"),
      active: true,
    });

    const res = await POST(makeRequest(VALID_BODY, "Bearer agent-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ ingested: 1, instanceId: VALID_BODY.instanceId, source: "operator_usage_beacon" });
    expect(sourceQuery.eq).toHaveBeenCalledWith("id", VALID_BODY.instanceId);
    expect(sourceQuery.eq).toHaveBeenCalledWith("active", true);
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          source_id: VALID_BODY.instanceId,
          stat_date: "2026-05-27",
          source_type: "internal_operator_canary",
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          cache_read_tokens: 500,
          reasoning_tokens: 7,
          source: "operator_usage_beacon",
        }),
      ],
      { onConflict: "source_id,stat_date" }
    );
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalledWith("compute_platform_stats_snapshot", expect.anything());
  });

  it("rejects an operator source when the bearer hash does not match", async () => {
    mockOperatorSource({
      id: VALID_BODY.instanceId,
      name: "PB10 Augustine",
      source_type: "internal_operator_canary",
      api_key_sha256: sha256Hex("different-secret"),
      active: true,
    });

    const res = await POST(makeRequest(VALID_BODY, "Bearer agent-secret"));
    expect(res.status).toBe(401);
  });

  it("caps payloads at 90 daily rows", async () => {
    const days = Array.from({ length: 91 }, (_, idx) => ({
      stat_date: `2026-05-${String((idx % 28) + 1).padStart(2, "0")}`,
      input_tokens: 1,
      output_tokens: 1,
    }));
    mockInstance({ api_server_key_encrypted: "enc" });
    const res = await POST(makeRequest({ instanceId: VALID_BODY.instanceId, days }, "Bearer agent-secret"));
    expect(res.status).toBe(400);
  });
});
