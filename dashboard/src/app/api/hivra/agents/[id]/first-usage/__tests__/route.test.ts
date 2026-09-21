import { POST } from "../route";

const mockAuth = jest.fn();
const mockSupabaseFrom = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraApiAllowed: () => true,
}));

function makeRequest() {
  return new Request("https://hivra.cloud/api/hivra/agents/agent-1/first-usage", {
    method: "POST",
    headers: { Host: "hivra.cloud" },
  });
}

describe("POST /api/hivra/agents/[id]/first-usage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user-1" });
  });

  it("stamps first_usage_at write-once for the authenticated user's agent", async () => {
    const selectMock = jest.fn(async () => ({ data: [{ id: "agent-1" }], error: null }));
    const isMock = jest.fn(() => ({ select: selectMock }));
    const eq2Mock = jest.fn(() => ({ is: isMock }));
    const eq1Mock = jest.fn(() => ({ eq: eq2Mock }));
    const updateMock = jest.fn(() => ({ eq: eq1Mock }));
    mockSupabaseFrom.mockReturnValue({ update: updateMock });

    const response = await POST(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockSupabaseFrom).toHaveBeenCalledWith("hivra_agents");
    expect(updateMock).toHaveBeenCalledWith({ first_usage_at: expect.any(String) });
    expect(eq1Mock).toHaveBeenCalledWith("id", "agent-1");
    expect(eq2Mock).toHaveBeenCalledWith("user_id", "user-1");
    expect(isMock).toHaveBeenCalledWith("first_usage_at", null);
  });

  it("is idempotent when first_usage_at was already stamped", async () => {
    const selectMock = jest.fn(async () => ({ data: [], error: null }));
    const isMock = jest.fn(() => ({ select: selectMock }));
    const eq2Mock = jest.fn(() => ({ is: isMock }));
    const eq1Mock = jest.fn(() => ({ eq: eq2Mock }));
    const updateMock = jest.fn(() => ({ eq: eq1Mock }));
    mockSupabaseFrom.mockReturnValue({ update: updateMock });

    const response = await POST(makeRequest() as never, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { stamped: false } });
  });
});
