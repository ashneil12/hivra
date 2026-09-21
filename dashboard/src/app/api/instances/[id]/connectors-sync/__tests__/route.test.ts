import { NextRequest } from "next/server";

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { syncComposioToInstance } from "@/lib/composio/sync-connectors";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/composio/sync-connectors", () => ({ syncComposioToInstance: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/webui/client", () => ({ WebUIError: class WebUIError extends Error {} }));
jest.mock("@/lib/webui/runtime-settings", () => ({
  mapWebUIRuntimeError: () => ({
    message: "err",
    status: 502,
    failureType: "webui_runtime_request_failed",
    retryable: false,
    upstreamStatus: 502,
  }),
}));

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.single = jest.fn(() => Promise.resolve(result));
  return chain;
}

const ctx = { params: Promise.resolve({ id: "inst-1" }) };
const req = {} as unknown as NextRequest;

describe("POST /api/instances/[id]/connectors-sync (composio)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (syncComposioToInstance as jest.Mock).mockResolvedValue({
      applied: true,
      backend: "webfree",
      changed: true,
      restarted: true,
    });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(
      makeChain({ data: { id: "inst-1", backend: "webui" }, error: null }),
    );
  });

  it("401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it("404 when the instance is not found / not owned by the user", async () => {
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(
      makeChain({ data: null, error: { message: "no rows" } }),
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it("routine mount (no body) syncs the composio entry without force", async () => {
    const res = await POST(req, ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ applied: true, backend: "webfree" });
    expect(syncComposioToInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst-1", userId: "user_123", force: false }),
    );
  });

  it("force body regenerates: passes force:true to the sync", async () => {
    const reqWithBody = { json: () => Promise.resolve({ force: true }) } as unknown as NextRequest;
    await POST(reqWithBody, ctx);
    expect(syncComposioToInstance).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("maps a benign no-key skip to applied:false", async () => {
    (syncComposioToInstance as jest.Mock).mockResolvedValue({ applied: false, reason: "composio_disabled" });
    const res = await POST(req, ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.applied).toBe(false);
    expect(json.data.reason).toBe("composio_disabled");
  });

  it("maps no_public_ipv4 to 502", async () => {
    (syncComposioToInstance as jest.Mock).mockResolvedValue({ applied: false, reason: "no_public_ipv4" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(502);
  });
});
