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
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
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

  // REGRESSION: writes used to go one profile per request (an insert per new
  // profile, an update per status change, a delete per stale row). Each kind
  // is now one request covering every affected row.
  it("writes new, status-changed and stale profiles in one request per kind", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: '[{ "name": "kept", "running": true }, { "name": "new-a", "running": true }, { "name": "new-b", "running": false }]',
      stderr: "",
    });

    const currentRows = [
      { id: "p_kept", name: "kept", status: "stopped", gateway_port: 8650 },
      { id: "p_gone", name: "gone", status: "running", gateway_port: 8651 },
    ];
    const mockEq = jest.fn().mockResolvedValue({ data: currentRows, error: null });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockInsert = jest.fn().mockResolvedValue({ error: null });
    const mockUpdateIn = jest.fn().mockResolvedValue({ error: null });
    const mockUpdate = jest.fn().mockReturnValue({ in: mockUpdateIn });
    const mockDeleteIn = jest.fn().mockResolvedValue({ error: null });
    const mockDelete = jest.fn().mockReturnValue({ in: mockDeleteIn });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "profiles") {
        return { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete };
      }
      return {};
    });

    await ProfileService.syncProfiles("inst_123", "user_123");

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ status: "running" });
    expect(mockUpdateIn).toHaveBeenCalledWith("id", ["p_kept"]);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({ instance_id: "inst_123", user_id: "user_123", name: "new-a", status: "running" }),
      expect.objectContaining({ instance_id: "inst_123", user_id: "user_123", name: "new-b", status: "stopped" }),
    ]);

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDeleteIn).toHaveBeenCalledWith("id", ["p_gone"]);
  });
});
