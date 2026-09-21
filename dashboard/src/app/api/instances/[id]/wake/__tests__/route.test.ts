import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { captureWakeEvent } from "@/lib/telemetry/wake-events";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/telemetry/wake-events", () => ({
  captureWakeEvent: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn((value: Record<string, unknown>) => value),
}));

function mockInstanceRow(row: Record<string, unknown> | null) {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            neq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: row, error: row ? null : { code: "PGRST116" } }),
            }),
          }),
        }),
      }),
    };
  });
}

function wakeRequest(query = "") {
  return new NextRequest(`http://localhost/api/instances/inst-123/wake${query}`);
}

const routeParams = { params: Promise.resolve({ id: "inst-123" }) };

describe("GET /api/instances/[id]/wake", () => {
  beforeEach(() => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
  });

  it("401s when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const response = await GET(wakeRequest(), routeParams);
    expect(response.status).toBe(401);
  });

  it("404s when the instance is missing or owned by someone else", async () => {
    mockInstanceRow(null);
    const response = await GET(wakeRequest(), routeParams);
    expect(response.status).toBe(404);
    expect(captureWakeEvent).not.toHaveBeenCalled();
  });

  it("reports a parked instance as wakeable with its box URL", async () => {
    mockInstanceRow({
      id: "inst-123",
      status: "stopped",
      lifecycle_state: "active",
      paused_reason: "inactivity",
      gateway_url: "https://abc123.agents.hermesos.cloud",
    });
    const response = await GET(wakeRequest(), routeParams);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      status: "stopped",
      running: false,
      wakeable: true,
      boxUrl: "https://abc123.agents.hermesos.cloud",
    });
    expect(captureWakeEvent).not.toHaveBeenCalled();
  });

  it("does not mark transitional states as wakeable", async () => {
    mockInstanceRow({
      id: "inst-123",
      status: "provisioning",
      lifecycle_state: "active",
      paused_reason: null,
      gateway_url: "https://abc123.agents.hermesos.cloud",
    });
    const response = await GET(wakeRequest(), routeParams);
    const json = await response.json();
    expect(json.data.wakeable).toBe(false);
  });

  it("emits wake_succeeded (deduped by wake_id) once the row is running", async () => {
    mockInstanceRow({
      id: "inst-123",
      status: "running",
      lifecycle_state: "active",
      paused_reason: null,
      gateway_url: "https://abc123.agents.hermesos.cloud",
    });
    const response = await GET(wakeRequest("?wake_id=wk-42&elapsed_ms=71000"), routeParams);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ running: true, wakeable: false });
    expect(captureWakeEvent).toHaveBeenCalledTimes(1);
    expect(captureWakeEvent).toHaveBeenCalledWith("wake_succeeded", {
      userId: "user_123",
      instanceId: "inst-123",
      wakeId: "wk-42",
      source: "wake_page",
      properties: { elapsed_ms: 71000 },
    });
  });

  it("does not emit wake_succeeded without a wake_id (plain status check)", async () => {
    mockInstanceRow({
      id: "inst-123",
      status: "running",
      lifecycle_state: "active",
      paused_reason: null,
      gateway_url: "https://abc123.agents.hermesos.cloud",
    });
    await GET(wakeRequest(), routeParams);
    expect(captureWakeEvent).not.toHaveBeenCalled();
  });

  it("does not emit wake_succeeded while still waking (running=false)", async () => {
    mockInstanceRow({
      id: "inst-123",
      status: "provisioning",
      lifecycle_state: "active",
      paused_reason: null,
      gateway_url: "https://abc123.agents.hermesos.cloud",
    });
    await GET(wakeRequest("?wake_id=wk-42"), routeParams);
    expect(captureWakeEvent).not.toHaveBeenCalled();
  });
});
