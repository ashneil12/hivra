import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { supabaseAdmin } from "@/lib/supabase";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn(),
}));

describe("resolveInstanceIpv4", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the cached instance ipv4 without querying supabase or hetzner", async () => {
    await expect(
      resolveInstanceIpv4({
        id: "inst-123",
        user_id: "user-123",
        name: "Test Instance",
        status: "running",
        created_at: "2026-04-21T00:00:00.000Z",
        provider: "openai",
        api_key_encrypted: "enc",
        ipv4_address: "203.0.113.10",
      })
    ).resolves.toBe("203.0.113.10");

    expect(supabaseAdmin?.from).not.toHaveBeenCalled();
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
  });

  it("returns the cached host ipv4 without calling hetzner", async () => {
    const single = jest.fn().mockResolvedValue({
      data: {
        hetzner_server_id: 123,
        ipv4_address: "198.51.100.7",
      },
    });
    const eq = jest.fn().mockReturnValue({ single });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });

    if (!supabaseAdmin) {
      throw new Error("supabaseAdmin mock missing");
    }

    (supabaseAdmin.from as jest.Mock).mockImplementation(from);

    await expect(
      resolveInstanceIpv4({
        id: "inst-123",
        user_id: "user-123",
        name: "Test Instance",
        status: "running",
        created_at: "2026-04-21T00:00:00.000Z",
        provider: "openai",
        api_key_encrypted: "enc",
        host_id: "host-123",
      })
    ).resolves.toBe("198.51.100.7");

    expect(supabaseAdmin.from).toHaveBeenCalledWith("hermes_hosts");
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
  });
});
