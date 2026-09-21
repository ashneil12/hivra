import { parseTrialExtensionOptions } from "@/lib/billing/trial-extension-options";

describe("parseTrialExtensionOptions", () => {
  it("defaults the grant to the public 14-day trial extension", () => {
    expect(parseTrialExtensionOptions([])).toEqual({
      dryRun: true,
      extensionDays: 14,
      reapplyGrant: false,
    });
  });

  it("allows an explicit extension day override", () => {
    expect(
      parseTrialExtensionOptions(["--execute", "--extension-days=7", "--reapply-grant"])
    ).toEqual({
      dryRun: false,
      extensionDays: 7,
      reapplyGrant: true,
    });
  });
});
