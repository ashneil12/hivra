const loadEnvConfig = jest.fn();
const createClient = jest.fn();
jest.mock("@next/env", () => ({ loadEnvConfig: (...args: unknown[]) => loadEnvConfig(...args) }));
jest.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => createClient(...args) }));

import { main, parseArgs } from "../scripts/rotate-encryption-keys";

describe("encryption rotation command", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("defaults to a read-only inspection and requires an explicit apply flag", () => {
    expect(parseArgs([])).toEqual({dryRun:true,batchSize:100,coverageOnly:false,help:false});
    expect(parseArgs(["--apply","--batch-size","17"])).toEqual(
      {dryRun:false,batchSize:17,coverageOnly:false,help:false});
  });

  it.each([
    ["--apply","--dry-run"], ["--apply","--coverage-only"],
    ["--apply","--apply"], ["--batch-size","0"], ["--batch-size","1001"],
  ])("rejects conflicting, repeated, or unbounded options: %s %s", (...args) => {
    expect(() => parseArgs(args.filter(Boolean) as string[])).toThrow();
  });

  it("does not reflect an unknown option that might contain a pasted secret", () => {
    const pasted = "hcloud-secret-fixture-never-print";
    expect(() => parseArgs([pasted])).toThrow("Unknown option; see --help");
    try { parseArgs([pasted]); } catch (error) { expect(String(error)).not.toContain(pasted); }
  });

  it("prints help before loading environment files or constructing a database client", async () => {
    const log = jest.spyOn(console,"log").mockImplementation(() => undefined);
    await expect(main(["--help"])).resolves.toBe(0);
    expect(loadEnvConfig).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("safe retirement");
    log.mockRestore();
  });
});
