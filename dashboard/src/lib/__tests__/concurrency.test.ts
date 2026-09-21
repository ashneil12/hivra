import { mapWithConcurrencyLimit } from "../concurrency";

describe("mapWithConcurrencyLimit", () => {
  it("preserves input order while respecting the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      await new Promise((resolve) => setTimeout(resolve, 5));

      inFlight -= 1;
      return value * 10;
    });

    expect(result).toEqual([10, 20, 30, 40]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("rejects when the mapper throws", async () => {
    await expect(
      mapWithConcurrencyLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) {
          throw new Error("boom");
        }

        return value;
      })
    ).rejects.toThrow("boom");
  });
});
