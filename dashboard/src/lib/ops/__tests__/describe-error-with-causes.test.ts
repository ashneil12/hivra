import { describeErrorWithCauses } from "../describe-error-with-causes";

describe("describeErrorWithCauses", () => {
  it("includes nested error causes so fetch failures expose the real network reason", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.hetzner.cloud"), {
        code: "ENOTFOUND",
      }),
    });

    expect(describeErrorWithCauses(error)).toBe(
      "TypeError: fetch failed | cause: Error: [ENOTFOUND]: getaddrinfo ENOTFOUND api.hetzner.cloud"
    );
  });

  it("falls back cleanly for non-Error values", () => {
    expect(describeErrorWithCauses("plain failure")).toBe("plain failure");
  });
});
