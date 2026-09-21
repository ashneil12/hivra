import { getSecureUserInstance } from "../lib/services/instance-security";
import { supabaseAdmin } from "../lib/supabase";

jest.mock("../lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    single: jest.fn(),
  },
}));

describe("Instance Security Utils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should fail if instance doesn't exist", async () => {
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              single: async () => ({ data: null, error: new Error("Not Found") }),
            }),
          }),
        }),
      }),
    });

    const result = await getSecureUserInstance({ id: "123", userId: "u_abc" });
    expect(result.error).toBe("Instance not found or unauthorized");
    expect(result.instance).toBeNull();
  });

  it("should fail if gateway url is absent", async () => {
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              single: async () => ({
                data: { id: "123", gateway_url: null, status: "running" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const result = await getSecureUserInstance({ id: "123", userId: "u_abc" });
    expect(result.error).toBe("Gateway URL not configured");
  });

  it("should fail closed when a running instance is missing its API server key", async () => {
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              single: async () => ({
                data: { 
                  id: "123", 
                  gateway_url: "http://10.240.0.1",
                  status: "running",
                  api_server_key_encrypted: null
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const result = await getSecureUserInstance({ id: "123", userId: "u_abc", requireRunning: true });
    expect(result.error).toBe("Instance API server key not configured");
    expect(result.instance).toBeNull();
    expect(result.apiServerKey).toBe("");
  });
});
