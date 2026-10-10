import {
  LAUNCH_RESOURCE_POLICY,
  launchResourcePolicy,
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

  it("drops Codex to the pinned base floor only when its browser is off", () => {
    expect(launchResourcePolicy("codex", { browser: true }).floor).toEqual({ cpu: 1.5, ram: 3 });
    expect(launchResourcePolicy("codex", { browser: false }).floor).toEqual({ cpu: 0.5, ram: 1 });
    expect(recommendedResourceEnvelope("codex", { browser: false })).toEqual({ cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 });
    // Profiles without a browser sidecar ignore the option.
    expect(launchResourcePolicy("ubuntu-desktop", { browser: false })).toBe(LAUNCH_RESOURCE_POLICY["ubuntu-desktop"]);
  });

  it("admits browser-off Codex at 0.5 CPU / 1 GB and still refuses it with the browser", () => {
    const small = { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 };
    expect(validateResourceEnvelope("codex", small, undefined, { browser: false })).toEqual({ ok: true, envelope: small });
    expect(validateResourceEnvelope("codex", small, undefined, { browser: true })).toEqual({ ok: false, reason: "below_floor" });
    // Existing callers without the option keep the browser-on floor.
    expect(validateResourceEnvelope("codex", small)).toEqual({ ok: false, reason: "below_floor" });
  });

  it("treats missing legacy maxima as pinned", () => {
    expect(validateResourceEnvelope("ubuntu-desktop", { cpu: 2, ram: 4 })).toEqual({
      ok: true,
      envelope: { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 },
    });
  });
});
