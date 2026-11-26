import { auth } from "@clerk/nextjs/server";
import { GET } from "../route";

const mockRpc = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

describe("GET /api/billing/holder-admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the exact current-user admitted state", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_current" });
    mockRpc.mockResolvedValue({ data: { state: "admitted" }, error: null });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "admitted" });
    expect(mockRpc).toHaveBeenCalledWith("holder_admission_state", {
      p_user_id: "user_current",
    });
  });

  it.each(["none", "waitlisted"] as const)("returns %s without wrapping it", async (state) => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_current" });
    mockRpc.mockResolvedValue({ data: { state }, error: null });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state });
  });

  it("uses only authenticated identity and rejects an unauthenticated read", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("fails closed to none only for an unknown durable value and errors on read failure", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_current" });
    mockRpc.mockResolvedValueOnce({ data: { state: "other-user-value" }, error: null });
    expect(await (await GET()).json()).toEqual({ state: "none" });

    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    const response = await GET();
    expect(response.status).toBe(500);
  });
});
