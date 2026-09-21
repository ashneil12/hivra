import { NextRequest } from "next/server";

import { GET } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { redeployPendingResizes } from "@/lib/services/pending-resize";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/services/pending-resize", () => ({
  redeployPendingResizes: jest.fn(),
  PENDING_RESIZE_SELECT: "id, backend",
}));

const fromMock = supabaseAdmin!.from as jest.Mock;
const mockRedeploy = redeployPendingResizes as jest.Mock;

function makeReq(authorization = "Bearer cron-secret") {
  return new Request("http://localhost/api/cron/apply-pending-resizes", {
    headers: { authorization },
  }) as unknown as NextRequest;
}

function mockQuery(rows: unknown[]) {
  const builder = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: rows, error: null }),
  };
  fromMock.mockReturnValue(builder);
  return builder;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/cron/apply-pending-resizes", () => {
  it("rejects requests without the cron secret", async () => {
    const res = await GET(makeReq("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRedeploy).not.toHaveBeenCalled();
  });

  it("returns early when nothing is pending", async () => {
    mockQuery([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.pending).toBe(0);
    expect(mockRedeploy).not.toHaveBeenCalled();
  });

  it("redeploys pending instances and returns the summary", async () => {
    mockQuery([{ id: "i1", backend: "webui" }]);
    mockRedeploy.mockResolvedValue({ redeployed: 1, failed: 0, skipped: 0, results: [] });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ pending: 1, redeployed: 1, failed: 0, skipped: 0 });
    expect(mockRedeploy).toHaveBeenCalledTimes(1);
  });
});
