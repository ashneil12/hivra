import { memoryFloorFor } from "../memory-floor";

const measured = { samples: 2000, spanHours: 72 };

describe("memoryFloorFor", () => {
  it("sets the floor from the measured peak: twice the peak, plus a margin, in whole steps", () => {
    // 1000 MB peak of 8192: 2000 + 512 = 2512, rounded up to 2560.
    expect(memoryFloorFor({ memoryMb: 8192, peakUsedMb: 1000, ...measured })).toEqual({ floorMb: 2560, reason: "measured" });
  });

  it("never goes under the minimum, however little the computer uses", () => {
    expect(memoryFloorFor({ memoryMb: 8192, peakUsedMb: 100, ...measured })).toEqual({ floorMb: 1024, reason: "measured" });
  });

  it("leaves a computer that uses most of its memory with all of it", () => {
    // 1547 MB peak of 2048: 3606 wanted, which is more than it has.
    expect(memoryFloorFor({ memoryMb: 2048, peakUsedMb: 1547, ...measured })).toEqual({ floorMb: 2048, reason: "keeps_all" });
    // A floor within a tenth of the full memory is not set either.
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: 1600, ...measured })).toEqual({ floorMb: 4096, reason: "keeps_all" });
  });

  it("keeps everything until there is a day of samples", () => {
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: null, samples: 0, spanHours: 0 }).floorMb).toBe(4096);
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: 900, samples: 99, spanHours: 72 }))
      .toEqual({ floorMb: 4096, reason: "not_enough_samples" });
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: 900, samples: 5000, spanHours: 23 }))
      .toEqual({ floorMb: 4096, reason: "not_enough_samples" });
  });

  it("keeps everything on a peak that cannot be right, and never touches the smallest computers", () => {
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: 9000, ...measured }).reason).toBe("not_enough_samples");
    expect(memoryFloorFor({ memoryMb: 4096, peakUsedMb: Number.NaN, ...measured }).floorMb).toBe(4096);
    expect(memoryFloorFor({ memoryMb: 1024, peakUsedMb: 200, ...measured })).toEqual({ floorMb: 1024, reason: "too_small" });
    expect(memoryFloorFor({ memoryMb: 0, peakUsedMb: 200, ...measured }).reason).toBe("invalid");
  });
});
