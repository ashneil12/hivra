import { ProfileService } from "../profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("ProfileService.syncProfiles failure handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(ProfileService, "getHostIpForInstance").mockResolvedValue("127.0.0.1");
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
  });

  it("throws when the host output does not contain a profile JSON array", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "warning: no JSON payload returned",
      stderr: "",
    });

    await expect(ProfileService.syncProfiles("inst_123", "user_123")).rejects.toThrow(
      "Failed to parse profile sync output: missing JSON array"
    );

    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("throws when loading the current profile rows fails", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: '[{ "name": "native-agent", "running": true }]',
      stderr: "",
    });

    const mockEq = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "db unavailable" },
    });
    const mockSelect = jest.fn().mockReturnValue({
      eq: mockEq,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "profiles") {
        return {
          select: mockSelect,
        };
      }
      return {};
    });

    await expect(ProfileService.syncProfiles("inst_123", "user_123")).rejects.toThrow(
      "Failed to load existing profiles for sync"
    );
  });

  it("throws when a discovered host profile cannot be assigned a gateway port", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: '[{ "name": "native-agent", "running": true }]',
      stderr: "",
    });

    const mockEq = jest.fn().mockResolvedValue({
      data: Array.from({ length: 21 }, (_, index) => ({
        id: `profile_${index}`,
        name: `existing-${index}`,
        status: "running",
        gateway_port: 8650 + index,
      })),
      error: null,
    });
    const mockSelect = jest.fn().mockReturnValue({
      eq: mockEq,
    });
    const mockInsert = jest.fn();

    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "profiles") {
        return {
          select: mockSelect,
          insert: mockInsert,
        };
      }
      return {};
    });

    await expect(ProfileService.syncProfiles("inst_123", "user_123")).rejects.toThrow(
      "No available ports for new profile. Maximum of 18 profiles reached."
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("includes ssh transport errors when the remote command fails without stdout", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: no matching host key type found client_secret=super-secret",
    });

    await expect(ProfileService.syncProfiles("inst_123", "user_123")).rejects.toThrow(
      "Failed to sync profiles: SSH connection error: no matching host key type found client_secret=[REDACTED]"
    );
  });
});
