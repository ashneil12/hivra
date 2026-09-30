import { ProfileService } from "@/lib/services/profile-service";
import { sshExec } from "@/lib/hetzner/ssh";
import { supabaseAdmin } from "@/lib/supabase";

// Mock dependencies
jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

const mockChain = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  not: jest.fn().mockReturnThis(),
  single: jest.fn(),
  update: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
};

jest.mock("@/lib/supabase", () => {
    return {
        supabaseAdmin: {
            from: jest.fn(() => mockChain),
        }
    };
});

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn().mockResolvedValue({ ipv4: "127.0.0.1" }),
  buildAgentCaddyfile: jest.fn().mockReturnValue("mock caddyfile"),
}));

describe("ProfileService.deleteProfile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("safely stops gateway, deletes profile from disk and db, and reloads caddy", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    const updateAgentCaddyRoutingSpy = jest
      .spyOn(ProfileService, "updateAgentCaddyRouting")
      .mockResolvedValue(undefined);

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    await ProfileService.deleteProfile("inst-1", "user-1", "agent-x");

    expect(sshExec).toHaveBeenCalledTimes(1);

    const sshCalls = (sshExec as jest.Mock).mock.calls;
    
    // Call 1: Stop gateway, delete profile dirs
    expect(sshCalls[0][1]).toContain("gateway stop");
    expect(sshCalls[0][1]).toContain("kill -9");
    expect(sshCalls[0][1]).toContain("rm -rf /opt/data/profiles/agent-x");
    expect(sshCalls[0][1]).toContain("rm -rf /workspace/profiles/agent-x");
    expect(updateAgentCaddyRoutingSpy).toHaveBeenCalledWith("inst-1", "user-1");

    // Supabase DB delete called
    expect(supabaseAdmin!.from).toHaveBeenCalledWith("profiles");
    expect(mockChain.delete).toHaveBeenCalled();
    expect(mockChain.eq).toHaveBeenCalledWith("instance_id", "inst-1");
    expect(mockChain.eq).toHaveBeenCalledWith("name", "agent-x");
  });

  it("throws when the profile record cannot be deleted from the database", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    const updateAgentCaddyRoutingSpy = jest
      .spyOn(ProfileService, "updateAgentCaddyRouting")
      .mockResolvedValue(undefined);

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    mockChain.eq.mockReset();
    mockChain.eq
      .mockReturnValueOnce(mockChain)
      .mockResolvedValueOnce({ error: { message: "db unavailable" } });

    await expect(ProfileService.deleteProfile("inst-1", "user-1", "agent-x")).rejects.toThrow(
      "Failed to delete profile record"
    );
    expect(updateAgentCaddyRoutingSpy).not.toHaveBeenCalled();
  });
});
