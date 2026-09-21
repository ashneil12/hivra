import {
  HACKATHON_PROMO_CUTOFF_ISO,
  HACKATHON_PROMO_TRIAL_DAYS,
  getHackathonCountdownParts,
  getHackathonPromoTrialDays,
  isHackathonPromoActive,
} from "../hackathon";

describe("hackathon promo helpers", () => {
  it("marks the promo active before the cutoff and inactive at the cutoff", () => {
    expect(isHackathonPromoActive(new Date("2026-05-03T23:58:59.000Z"))).toBe(true);
    expect(isHackathonPromoActive(new Date(HACKATHON_PROMO_CUTOFF_ISO))).toBe(false);
  });

  it("returns a fixed 17-day trial for operator during the promo window", () => {
    expect(getHackathonPromoTrialDays("operator", new Date("2026-04-18T12:00:00.000Z"))).toBe(
      HACKATHON_PROMO_TRIAL_DAYS
    );
    expect(getHackathonPromoTrialDays("fleet", new Date("2026-04-18T12:00:00.000Z"))).toBeNull();
    expect(getHackathonPromoTrialDays("operator", new Date(HACKATHON_PROMO_CUTOFF_ISO))).toBeNull();
  });

  it("formats countdown parts against the promo deadline", () => {
    expect(getHackathonCountdownParts(new Date("2026-05-02T21:29:00.000Z"))).toEqual({
      days: 2,
      hours: 2,
      minutes: 30,
      seconds: 0,
      expired: false,
    });

    expect(getHackathonCountdownParts(new Date("2026-05-04T00:00:00.000Z"))).toEqual({
      days: 0,
      hours: 23,
      minutes: 59,
      seconds: 0,
      expired: false,
    });
  });
});
