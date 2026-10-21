import { isHivraLapseEnforceLive } from "../lapse-flags";

describe("isHivraLapseEnforceLive", () => {
  it("is on only for the exact string true", () => {
    expect(isHivraLapseEnforceLive({ HIVRA_LAPSE_ENFORCE_LIVE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each([undefined, "", "TRUE", "True", "1", "yes", "false", " true", "true "])("is off for %p", (value) => {
    const env = (value === undefined ? {} : { HIVRA_LAPSE_ENFORCE_LIVE: value }) as unknown as NodeJS.ProcessEnv;
    expect(isHivraLapseEnforceLive(env)).toBe(false);
  });
});
