import {
  LAUNCH_RESOURCE_POLICY,
  recommendedResourceEnvelope,
  validateResourceEnvelope,
} from "../resource-envelope";

describe("launch resource envelope policy", () => {
  it("defaults Codex and Ubuntu to efficient bounded envelopes", () => {
    expect(recommendedResourceEnvelope("codex")).toEqual({ cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4 });
    expect(recommendedResourceEnvelope("ubuntu-desktop")).toEqual({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 });
  });

  it("keeps desktop and Windows floors at their accepted minima", () => {
    expect(LAUNCH_RESOURCE_POLICY["ubuntu-desktop"].floor).toEqual({ cpu: 2, ram: 4 });
    expect(LAUNCH_RESOURCE_POLICY.omarchy.floor).toEqual({ cpu: 4, ram: 8 });
    expect(LAUNCH_RESOURCE_POLICY.windows.floor).toEqual({ cpu: 4, ram: 8 });
  });

  it("rejects guarantees below the floor and maxima below guarantees", () => {
    expect(validateResourceEnvelope("windows", { cpu: 2, ram: 4 })).toEqual({ ok: false, reason: "below_floor" });
    expect(validateResourceEnvelope("ubuntu-desktop", { cpu: 4, ram: 8, maximumCpu: 2, maximumRam: 4 }))
      .toEqual({ ok: false, reason: "maximum_below_guarantee" });
  });

  it("enforces supplied plan or host maximum caps", () => {
    expect(validateResourceEnvelope("codex", { cpu: 1.5, ram: 3, maximumCpu: 4, maximumRam: 8 }, { maximumCpu: 2, maximumRam: 4 }))
      .toEqual({ ok: false, reason: "maximum_above_cap" });
  });

  it("treats missing legacy maxima as pinned", () => {
    expect(validateResourceEnvelope("ubuntu-desktop", { cpu: 2, ram: 4 })).toEqual({
      ok: true,
      envelope: { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 },
    });
  });
});
