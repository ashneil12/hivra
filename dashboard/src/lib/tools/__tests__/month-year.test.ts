import { monthYear } from "../month-year";

describe("monthYear", () => {
  it("turns an ISO date into the month and year reader copy shows", () => {
    expect(monthYear("2026-09-30")).toBe("September 2026");
    expect(monthYear("2026-01-01")).toBe("January 2026");
    expect(monthYear("2025-12-31")).toBe("December 2025");
  });
});
