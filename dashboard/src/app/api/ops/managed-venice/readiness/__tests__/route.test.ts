import { NextRequest } from "next/server";

import { GET } from "../route";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type QueryError = { message?: string } | null;

function tableProbe(data: unknown[] = [], error: QueryError = null) {
  const chain: {
    select: jest.Mock;
    limit: jest.Mock;
  } = {
    select: jest.fn(() => chain),
    limit: jest.fn(async () => ({ data, error })),
  };
  return chain;
}

describe("GET /api/ops/managed-venice/readiness", () => {
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "expected-secret",
      VENICE_API_KEY: "venice_server_key",
      MANAGED_VENICE_PROXY_KEY_PEPPER: "pepper",
      MANAGED_VENICE_SETTLEMENT_SECRET: "settle",
      STRIPE_SECRET_KEY: "sk_test",
      NEXT_PUBLIC_APP_URL: "https://app.hermesos.test",
      MANAGED_VENICE_TREASURY_BASE_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    };
    mockedSupabaseAdmin.from.mockReturnValue(tableProbe());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function request(secret = "expected-secret") {
    return new NextRequest("http://localhost/api/ops/managed-venice/readiness", {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  it("fails closed without the cron bearer", async () => {
    const response = await GET(request("wrong"));

    expect(response.status).toBe(401);
    expect(mockedSupabaseAdmin.from).not.toHaveBeenCalled();
  });

  it("reports ready when env, treasury, and managed Venice tables are reachable", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(true);
    expect(body.data.blockers).toEqual([]);
    expect(body.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "VENICE_UPSTREAM_KEYS", status: "ok" }),
        expect.objectContaining({ key: "MANAGED_VENICE_TREASURY_BASE_ADDRESS", status: "ok" }),
        expect.objectContaining({ key: "managed_venice_wallet_accounts", status: "ok" }),
      ])
    );
  });

  it("accepts managed inference key pool as the upstream Venice readiness key", async () => {
    delete process.env.VENICE_API_KEY;
    process.env.MANAGED_VENICE_INFERENCE_KEYS = JSON.stringify(["pool_key_a", "pool_key_b"]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(true);
    expect(body.data.blockers).not.toContain("VENICE_API_KEY");
    expect(body.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "VENICE_UPSTREAM_KEYS", status: "ok" }),
      ])
    );
  });

  it("surfaces missing launch-critical configuration as blockers", async () => {
    delete process.env.VENICE_API_KEY;
    delete process.env.MANAGED_VENICE_PROXY_KEY_PEPPER;
    delete process.env.MANAGED_VENICE_TREASURY_BASE_ADDRESS;
    delete process.env.HERMES_TREASURY_ADDRESS;
    delete process.env.HERMES_TREASURY_BASE_ADDRESS;
    mockedSupabaseAdmin.from.mockImplementation((tableName: string) => {
      if (tableName === "managed_venice_usage_events") {
        return tableProbe([], { message: "relation missing" });
      }
      return tableProbe();
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(false);
    expect(body.data.blockers).toEqual(
      expect.arrayContaining([
        "VENICE_UPSTREAM_KEYS",
        "MANAGED_VENICE_PROXY_KEY_PEPPER",
        "MANAGED_VENICE_TREASURY_BASE_ADDRESS",
        "managed_venice_usage_events",
      ])
    );
  });
});
