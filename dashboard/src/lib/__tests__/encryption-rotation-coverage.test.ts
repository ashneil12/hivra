import {
  formatRotationCoverage,
  inspectRotationCoverage,
  UNHANDLED_ROTATION_DEPENDENCIES,
} from "@/lib/encryption-rotation-coverage";

describe("encryption rotation coverage", () => {
  it("includes ciphertext and HMAC dependencies without reading values", async () => {
    const requested: string[] = [];
    const coverage = await inspectRotationCoverage(async ({table,column}) => {
      requested.push(`${table}.${column}`); return 0;
    });
    expect(requested).toEqual(UNHANDLED_ROTATION_DEPENDENCIES.map(d => `${d.table}.${d.column}`));
    expect(requested).toContain("hivra_launch_model_requests.fingerprint_key_tag");
    expect(UNHANDLED_ROTATION_DEPENDENCIES.find(d => d.column === "fingerprint_key_tag"))
      .toEqual(expect.objectContaining({ equals: { fingerprint_version: 1 } }));
    expect(coverage).toEqual(expect.objectContaining({blocksApply:false,keyRetirementProven:false}));
    expect(formatRotationCoverage(coverage)).toContain("Key retirement is NOT proven");
  });

  it.each(["missing", "error", "timeout", "malformed"])("fails closed on an unavailable %s count", async () => {
    let first = true;
    const coverage = await inspectRotationCoverage(async () => {
      if (first) { first=false; throw new Error("database detail must not escape: synthetic-ciphertext"); }
      return 0;
    });
    expect(coverage.blocksApply).toBe(true);
    expect(coverage.observations[0].count).toBeNull();
    expect(formatRotationCoverage(coverage)).not.toContain("synthetic-ciphertext");
  });

  it("blocks apply when one unhandled record exists", async () => {
    const coverage = await inspectRotationCoverage(async ({ column }) => column === "encrypted_token" ? 1 : 0);
    expect(coverage.blocksApply).toBe(true);
  });
});
