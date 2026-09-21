import { activationRate, intersectionCount } from "../telegram-activation";

describe("activationRate", () => {
  it("is 0 when there are no deployers", () => {
    expect(activationRate(0, 0)).toBe(0);
    expect(activationRate(0, 5)).toBe(0);
  });

  it("computes a rounded fraction", () => {
    expect(activationRate(10, 8)).toBe(0.8);
    expect(activationRate(3, 1)).toBe(0.333);
    expect(activationRate(7, 7)).toBe(1);
  });
});

describe("intersectionCount", () => {
  it("counts shared members regardless of which set is larger", () => {
    const deployers = new Set(["a", "b", "c", "d"]);
    const connected = new Set(["b", "d", "z"]);
    expect(intersectionCount(deployers, connected)).toBe(2);
    expect(intersectionCount(connected, deployers)).toBe(2);
  });

  it("is 0 with no overlap", () => {
    expect(intersectionCount(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(intersectionCount(new Set(), new Set(["b"]))).toBe(0);
  });
});
