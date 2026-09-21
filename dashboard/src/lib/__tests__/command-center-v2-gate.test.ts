import { isCommandCenterV2EnabledForUser } from "@/lib/command-center/v2-gate";

describe("command center v2 pilot gate", () => {
  const originalEnv = process.env.COMMAND_CENTER_V2_ALLOWLIST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMMAND_CENTER_V2_ALLOWLIST;
    } else {
      process.env.COMMAND_CENTER_V2_ALLOWLIST = originalEnv;
    }
  });

  it("keeps the v2 Command Center closed when no server allowlist is configured", () => {
    expect(
      isCommandCenterV2EnabledForUser({
        id: "user_fixture_pilot",
        primaryEmailAddress: { emailAddress: "pilot@example.com" },
      })
    ).toBe(false);
  });

  it("recognizes an allowlisted email case-insensitively", () => {
    process.env.COMMAND_CENTER_V2_ALLOWLIST = "pilot@example.com";
    expect(
      isCommandCenterV2EnabledForUser({
        id: "user_different_id",
        primaryEmailAddress: { emailAddress: "PILOT@example.com" },
      })
    ).toBe(true);
  });

  it("allows adding extra testers through the server allowlist without enabling everyone", () => {
    process.env.COMMAND_CENTER_V2_ALLOWLIST = "user_extra, pilot@example.com";

    expect(isCommandCenterV2EnabledForUser({ id: "user_extra" })).toBe(true);
    expect(
      isCommandCenterV2EnabledForUser({
        id: "user_other",
        primaryEmailAddress: { emailAddress: "pilot@example.com" },
      })
    ).toBe(true);
    expect(
      isCommandCenterV2EnabledForUser({
        id: "user_other",
        primaryEmailAddress: { emailAddress: "not-pilot@example.com" },
      })
    ).toBe(false);
  });
});
