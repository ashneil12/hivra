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

  it("sizes the Linux computer from its own light floor, recommending 1 CPU / 2 GB that may burst to 2 / 4", () => {
    expect(LAUNCH_RESOURCE_POLICY["ubuntu-server"].floor).toEqual({ cpu: 0.5, ram: 1 });
    expect(recommendedResourceEnvelope("ubuntu-server")).toEqual({ cpu: 1, ram: 2, maximumCpu: 2, maximumRam: 4 });
    const small = { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 };
    expect(validateResourceEnvelope("ubuntu-server", small)).toEqual({ ok: true, envelope: small });
    expect(validateResourceEnvelope("ubuntu-desktop", small)).toEqual({ ok: false, reason: "below_floor" });
    expect(validateResourceEnvelope("ubuntu-server", { cpu: 0.5, ram: 0.5 })).toEqual({ ok: false, reason: "below_floor" });
  });

  it("holds DeepSeek Harness to its catalog floor and recommends the size its acceptance ran at, always kept", () => {
    expect(LAUNCH_RESOURCE_POLICY["deepseek-harness"].floor).toEqual({ cpu: 2, ram: 3 });
    expect(recommendedResourceEnvelope("deepseek-harness")).toEqual({ cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 });
    const accepted = { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 };
    expect(validateResourceEnvelope("deepseek-harness", accepted)).toEqual({ ok: true, envelope: accepted });
    expect(validateResourceEnvelope("deepseek-harness", { cpu: 1, ram: 4 })).toEqual({ ok: false, reason: "below_floor" });
    expect(validateResourceEnvelope("deepseek-harness", { cpu: 2, ram: 2 })).toEqual({ ok: false, reason: "below_floor" });
  });

  it("treats missing legacy maxima as pinned", () => {
    expect(validateResourceEnvelope("ubuntu-desktop", { cpu: 2, ram: 4 })).toEqual({
      ok: true,
      envelope: { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4 },
    });
  });
});
