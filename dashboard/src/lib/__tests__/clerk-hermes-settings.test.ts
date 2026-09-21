import { clerkClient } from "@clerk/nextjs/server";

import { loadGlobalHermesSettingsForUser } from "@/lib/clerk-hermes-settings";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

describe("loadGlobalHermesSettingsForUser", () => {
  let getUserMock: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getUserMock = jest.fn();
    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: { getUser: getUserMock },
    });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns extracted hermesSettings when the Clerk user resolves", async () => {
    getUserMock.mockResolvedValue({
      publicMetadata: {
        hermesSettings: {
          sessionExpiryHours: 12,
          memoryContextLimit: 4000,
        },
      },
    });

    const result = await loadGlobalHermesSettingsForUser("user_123");

    expect(result).toEqual({
      sessionExpiryHours: 12,
      memoryContextLimit: 4000,
      userContextLimit: undefined,
    });
    expect(getUserMock).toHaveBeenCalledWith("user_123");
  });

  it("falls back to default settings when the Clerk user is gone", async () => {
    // Regression for the 2026-05-01 fleet-update gap: a deleted Clerk
    // owner left a Hermes instance row pinned to the old vanilla-hermes-
    // agent image because every updater that looked up Clerk threw on
    // Not Found. The helper now swallows the error and returns the same
    // defaults the manual trigger script falls back to.
    const notFound = new Error("Not Found");
    notFound.name = "ClerkAPIError";
    getUserMock.mockRejectedValue(notFound);

    const result = await loadGlobalHermesSettingsForUser(
      "user_fixture_deleted",
      { instanceId: "00000000-0000-4000-8000-000000000001" },
    );

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    const warnLine = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnLine).toContain("clerk_user_lookup_failed");
    expect(warnLine).toContain("user_fixture_deleted");
    expect(warnLine).toContain("00000000-0000-4000-8000-000000000001");
  });

  it("falls back to default settings on transient Clerk failures (e.g. network)", async () => {
    getUserMock.mockRejectedValue(new Error("ECONNRESET"));

    const result = await loadGlobalHermesSettingsForUser("user_x");

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });
});
