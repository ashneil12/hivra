import { ProfileService } from "../profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("ProfileService gateway status persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws when marking a started profile as running fails", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    const updateAgentCaddyRoutingSpy = jest
      .spyOn(ProfileService, "updateAgentCaddyRouting")
      .mockResolvedValue(undefined);

    const profileTable = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "prof_123", gateway_port: 8651 },
        error: null,
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: { message: "db unavailable" } }),
      }),
    };

    (supabaseAdmin!.from as jest.Mock).mockReturnValue(profileTable);
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    await expect(ProfileService.startProfileGateway("inst_123", "user_123", "agent-x")).rejects.toThrow(
      "Failed to mark profile gateway as running"
    );

    expect(updateAgentCaddyRoutingSpy).toHaveBeenCalledWith("inst_123", "user_123");
  });

  it("throws when marking a stopped profile as stopped fails", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    const updateAgentCaddyRoutingSpy = jest
      .spyOn(ProfileService, "updateAgentCaddyRouting")
      .mockResolvedValue(undefined);

    // stopProfileGateway resolves the profile row before touching the box.
    const lookupTable = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "prof_123", gateway_port: 8651 },
        error: null,
      }),
    };

    const statusUpdateChain = {
      eq: jest.fn(),
    };
    statusUpdateChain.eq
      .mockReturnValueOnce(statusUpdateChain)
      .mockResolvedValueOnce({ error: { message: "db unavailable" } });

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce(lookupTable)
      .mockReturnValueOnce({ update: jest.fn().mockReturnValue(statusUpdateChain) });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    await expect(ProfileService.stopProfileGateway("inst_123", "user_123", "agent-x")).rejects.toThrow(
      "Failed to mark profile gateway as stopped"
    );

    expect(updateAgentCaddyRoutingSpy).not.toHaveBeenCalled();
  });

  // REGRESSION: a webfree profile row never gets a gateway_port
  // (persistWebUIProfileToSupabase doesn't write one). stopProfileGateway used
  // to skip this check entirely, SSH into the box, and then rebuild its
  // Caddyfile with the legacy upstreams — taking the box down. Bail before any
  // SSH / Caddy work, exactly like startProfileGateway already does.
  it("refuses to stop a profile that owns no gateway port, before touching the box", async () => {
    const getHostIpSpy = jest.spyOn(ProfileService, "getGuestSshForInstance");
    const updateAgentCaddyRoutingSpy = jest
      .spyOn(ProfileService, "updateAgentCaddyRouting")
      .mockResolvedValue(undefined);

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "prof_webfree", gateway_port: null },
        error: null,
      }),
    });

    await expect(ProfileService.stopProfileGateway("inst_123", "user_123", "agent-x")).rejects.toThrow(
      "Profile has no allocated gateway port"
    );

    expect(sshExec).not.toHaveBeenCalled();
    expect(getHostIpSpy).not.toHaveBeenCalled();
    expect(updateAgentCaddyRoutingSpy).not.toHaveBeenCalled();
  });
});
