import { shippedThisWeek, stillMovingCount, stuckPulls, weekRange, type WeekPull } from "../week-board";

const MONDAY = new Date("2026-10-19T00:00:00.000Z");
const SUNDAY_NIGHT = new Date("2026-10-18T23:59:59.999Z");
const NOW = new Date("2026-10-21T12:00:00.000Z");

function pull(overrides: Partial<WeekPull> & Pick<WeekPull, "number" | "title">): WeekPull {
  return {
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-10-21T11:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("weekRange", () => {
  it("treats Sunday night UTC as the previous week, and Monday 00:00 UTC as the new week", () => {
    expect(weekRange(SUNDAY_NIGHT)).toEqual({
      start: new Date("2026-10-12T00:00:00.000Z"),
      end: new Date("2026-10-19T00:00:00.000Z"),
    });
    expect(weekRange(MONDAY)).toEqual({
      start: new Date("2026-10-19T00:00:00.000Z"),
      end: new Date("2026-10-26T00:00:00.000Z"),
    });
    expect(weekRange(SUNDAY_NIGHT).end.getTime()).toBe(weekRange(MONDAY).start.getTime());
  });

  it("keeps a timestamp later on Monday inside the same week", () => {
    expect(weekRange(new Date("2026-10-19T18:30:00.000Z"))).toEqual(weekRange(MONDAY));
  });
});

describe("shippedThisWeek", () => {
  it("keeps merges inside the Monday window and drops a merge from Sunday night", () => {
    const pulls = [
      pull({ number: 1, title: "Sunday", state: "closed", merged_at: "2026-10-18T23:59:59.999Z" }),
      pull({ number: 2, title: "Monday open", state: "closed", merged_at: "2026-10-19T00:00:00.000Z" }),
      pull({ number: 3, title: "Midweek", state: "closed", merged_at: "2026-10-21T08:00:00.000Z" }),
      pull({ number: 4, title: "Next Monday", state: "closed", merged_at: "2026-10-26T00:00:00.000Z" }),
    ];

    expect(shippedThisWeek(pulls, NOW).map((item) => item.number)).toEqual([3, 2]);
    expect(shippedThisWeek(pulls, NOW)[0]).toMatchObject({
      title: "Midweek",
      mergedAt: "2026-10-21T08:00:00.000Z",
      url: "https://github.com/ashneil12/hivra/pull/3",
    });
  });

  it("does not count a closed pull that was never merged", () => {
    const pulls = [
      pull({
        number: 9,
        title: "Closed without merge",
        state: "closed",
        merged_at: null,
        closed_at: "2026-10-20T15:00:00.000Z",
      }),
    ];

    expect(shippedThisWeek(pulls, NOW)).toEqual([]);
  });
});

describe("stuckPulls", () => {
  it("marks a draft as stuck even when it was just updated", () => {
    const pulls = [pull({ number: 11, title: "Still drafting", draft: true, updated_at: "2026-10-21T11:30:00.000Z" })];

    expect(stuckPulls(pulls, NOW)).toEqual([
      {
        number: 11,
        title: "Still drafting",
        reason: "Draft",
        url: "https://github.com/ashneil12/hivra/pull/11",
      },
    ]);
  });

  it("marks an open pull with no update for more than 7 days, and counts whole days", () => {
    const justOver = pull({
      number: 12,
      title: "Quiet",
      updated_at: "2026-10-14T11:59:59.999Z",
    });
    const elevenDays = pull({
      number: 13,
      title: "Older",
      updated_at: "2026-10-10T12:00:00.000Z",
    });

    expect(stuckPulls([justOver], NOW)[0].reason).toBe("No update in 7 days");
    expect(stuckPulls([elevenDays], NOW)[0].reason).toBe("No update in 11 days");
  });

  it("does not mark a non-draft updated within the last 7 days, including exactly 7 days", () => {
    const recent = pull({ number: 14, title: "Moving", updated_at: "2026-10-20T12:00:00.000Z" });
    const exactly = pull({ number: 15, title: "Right on 7 days", updated_at: "2026-10-14T12:00:00.000Z" });

    expect(stuckPulls([recent, exactly], NOW)).toEqual([]);
    expect(stillMovingCount([recent, exactly], NOW)).toBe(2);
  });

  it("does not treat a closed pull as stuck", () => {
    const closed = pull({
      number: 16,
      title: "Already closed",
      state: "closed",
      draft: true,
      updated_at: "2026-09-01T00:00:00.000Z",
    });

    expect(stuckPulls([closed], NOW)).toEqual([]);
    expect(stillMovingCount([closed], NOW)).toBe(0);
  });

  it("prefers Draft when a draft is also stale", () => {
    const staleDraft = pull({
      number: 17,
      title: "Old draft",
      draft: true,
      updated_at: "2026-09-01T00:00:00.000Z",
    });

    expect(stuckPulls([staleDraft], NOW)[0].reason).toBe("Draft");
  });
});
