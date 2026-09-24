import { daysUntil, relativeDays, tokenExpiryInputFor, tokenExpiryState } from "../token-expiry";

const now = new Date(2026, 8, 24, 15, 0, 0);
const declaredAt = "2026-09-01T00:00:00.000Z";

describe("token expiry", () => {
  it("turns picker choices into what Hivra records", () => {
    expect(tokenExpiryInputFor("unknown", "", now)).toBeUndefined();
    expect(tokenExpiryInputFor("none", "", now)).toEqual({ mode: "none" });
    expect(tokenExpiryInputFor("30", "", now)).toEqual({ mode: "date", date: "2026-10-24" });
    expect(tokenExpiryInputFor("date", "2027-01-02", now)).toEqual({ mode: "date", date: "2027-01-02" });
  });

  it("counts calendar days in the viewer's time zone", () => {
    expect(daysUntil("2026-09-24", now)).toBe(0);
    expect(daysUntil("2026-10-01", now)).toBe(7);
    expect(relativeDays(0)).toBe("today");
    expect(relativeDays(1)).toBe("tomorrow");
  });

  it("warns inside seven days, and reports expired and unknown states", () => {
    expect(tokenExpiryState(null, now)).toEqual({ kind: "unknown" });
    expect(tokenExpiryState({ source: "owner-declared", noExpiry: true, expiresOn: null, declaredAt }, now)).toEqual({ kind: "never" });
    expect(tokenExpiryState({ source: "owner-declared", noExpiry: false, expiresOn: "2026-10-01", declaredAt }, now)).toMatchObject({ kind: "soon", days: 7 });
    expect(tokenExpiryState({ source: "owner-declared", noExpiry: false, expiresOn: "2026-10-02", declaredAt }, now)).toMatchObject({ kind: "later", days: 8 });
    expect(tokenExpiryState({ source: "owner-declared", noExpiry: false, expiresOn: "2026-09-23", declaredAt }, now)).toMatchObject({ kind: "expired" });
  });
});
