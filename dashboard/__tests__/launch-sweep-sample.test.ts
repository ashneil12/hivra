import { SWEEP_TARGETS, pickNightlySample } from "../e2e/launch-sweep/targets";

const DAY = 86_400_000;

describe("nightly rotating sample", () => {
  it("covers every target within ceil(targets / size) nights", () => {
    const size = 3;
    const nights = Math.ceil(SWEEP_TARGETS.length / size);
    const seen = new Set<string>();
    for (let night = 0; night < nights; night += 1) {
      const sample = pickNightlySample(new Date(night * DAY), size);
      expect(sample).toHaveLength(size);
      sample.forEach((target) => seen.add(target.profileId));
    }
    expect(seen.size).toBe(SWEEP_TARGETS.length);
  });

  it("is the same all day and moves on the next day", () => {
    const morning = pickNightlySample(new Date("2026-11-19T01:00:00Z"), 3).map((t) => t.profileId);
    expect(pickNightlySample(new Date("2026-11-19T23:00:00Z"), 3).map((t) => t.profileId)).toEqual(morning);
    expect(pickNightlySample(new Date("2026-11-20T01:00:00Z"), 3).map((t) => t.profileId)).not.toEqual(morning);
  });

  it("never asks for more than the catalog has", () => {
    expect(pickNightlySample(new Date(0), 99)).toHaveLength(SWEEP_TARGETS.length);
    expect(pickNightlySample(new Date(0), 0)).toHaveLength(1);
    expect(pickNightlySample(new Date(0), 3, [])).toEqual([]);
  });
});
