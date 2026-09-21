import {
  cronFromFriendly,
  friendlyFromCron,
  describeFriendly,
  to12Hour,
  to24Hour,
  DEFAULT_FRIENDLY_SCHEDULE,
  type FriendlySchedule,
} from "../schedule/cron-friendly";

describe("cronFromFriendly", () => {
  it("builds hourly cron (minute only)", () => {
    expect(cronFromFriendly({ ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "hourly", minute: 15 })).toBe(
      "15 * * * *"
    );
  });

  it("builds daily cron", () => {
    expect(
      cronFromFriendly({ ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "daily", minute: 0, hour: 9 })
    ).toBe("0 9 * * *");
  });

  it("builds weekly cron with sorted day list", () => {
    expect(
      cronFromFriendly({
        ...DEFAULT_FRIENDLY_SCHEDULE,
        frequency: "weekly",
        minute: 30,
        hour: 14,
        daysOfWeek: [5, 1, 3],
      })
    ).toBe("30 14 * * 1,3,5");
  });

  it("falls back to Monday when weekly has no days", () => {
    expect(
      cronFromFriendly({ ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "weekly", daysOfWeek: [] })
    ).toBe("0 9 * * 1");
  });

  it("builds monthly cron", () => {
    expect(
      cronFromFriendly({
        ...DEFAULT_FRIENDLY_SCHEDULE,
        frequency: "monthly",
        minute: 0,
        hour: 8,
        dayOfMonth: 15,
      })
    ).toBe("0 8 15 * *");
  });
});

describe("friendlyFromCron", () => {
  it("parses the default daily-9am cron", () => {
    expect(friendlyFromCron("0 9 * * *")).toMatchObject({ frequency: "daily", minute: 0, hour: 9 });
  });

  it("parses hourly", () => {
    expect(friendlyFromCron("0 * * * *")).toMatchObject({ frequency: "hourly", minute: 0 });
  });

  it("parses weekly with a comma list", () => {
    expect(friendlyFromCron("0 9 * * 1,3,5")).toMatchObject({
      frequency: "weekly",
      daysOfWeek: [1, 3, 5],
    });
  });

  it("expands weekly ranges and normalises 7 to Sunday", () => {
    expect(friendlyFromCron("0 9 * * 1-5")?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(friendlyFromCron("0 9 * * 7")?.daysOfWeek).toEqual([0]);
  });

  it("parses monthly", () => {
    expect(friendlyFromCron("0 8 15 * *")).toMatchObject({
      frequency: "monthly",
      dayOfMonth: 15,
      hour: 8,
    });
  });

  it("returns null for unsupported shapes", () => {
    expect(friendlyFromCron("*/5 * * * *")).toBeNull(); // step minutes
    expect(friendlyFromCron("0 9 * 6 *")).toBeNull(); // specific month
    expect(friendlyFromCron("0 9 1 * 1")).toBeNull(); // dom + dow both set
    expect(friendlyFromCron("not a cron")).toBeNull();
    expect(friendlyFromCron("0 9 * *")).toBeNull(); // wrong field count
  });
});

describe("round-trip", () => {
  const cases = ["0 9 * * *", "15 * * * *", "30 14 * * 1,3,5", "0 8 15 * *", "0 9 * * 1,2,3,4,5"];
  it.each(cases)("%s survives parse -> build", (cron) => {
    const friendly = friendlyFromCron(cron) as FriendlySchedule;
    expect(friendly).not.toBeNull();
    expect(cronFromFriendly(friendly)).toBe(cron);
  });
});

describe("12/24 hour conversion", () => {
  it("converts 24h -> 12h", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: "AM" });
    expect(to12Hour(9)).toEqual({ hour12: 9, meridiem: "AM" });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: "PM" });
    expect(to12Hour(23)).toEqual({ hour12: 11, meridiem: "PM" });
  });

  it("converts 12h -> 24h", () => {
    expect(to24Hour(12, "AM")).toBe(0);
    expect(to24Hour(9, "AM")).toBe(9);
    expect(to24Hour(12, "PM")).toBe(12);
    expect(to24Hour(11, "PM")).toBe(23);
  });
});

describe("describeFriendly", () => {
  it("summarises each frequency", () => {
    expect(describeFriendly({ ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "hourly", minute: 5 })).toBe(
      "Every hour at :05"
    );
    expect(
      describeFriendly({ ...DEFAULT_FRIENDLY_SCHEDULE, frequency: "daily", hour: 9, minute: 0 })
    ).toBe("Every day at 9:00 AM");
    expect(
      describeFriendly({
        ...DEFAULT_FRIENDLY_SCHEDULE,
        frequency: "weekly",
        daysOfWeek: [1, 2, 3, 4, 5],
        hour: 9,
        minute: 0,
      })
    ).toBe("Every weekdays at 9:00 AM");
    expect(
      describeFriendly({
        ...DEFAULT_FRIENDLY_SCHEDULE,
        frequency: "monthly",
        dayOfMonth: 21,
        hour: 8,
        minute: 30,
      })
    ).toBe("Monthly on the 21st at 8:30 AM");
  });
});
