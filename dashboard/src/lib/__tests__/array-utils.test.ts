import { chunk } from "@/lib/array-utils";

describe("chunk", () => {
  it("splits into fixed-size chunks with a smaller final chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("returns a single chunk when size >= length", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("splits evenly when length is a multiple of size", () => {
    expect(chunk(["a", "b", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });
});
