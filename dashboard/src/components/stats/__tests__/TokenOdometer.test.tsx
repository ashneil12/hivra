/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, render } from "@testing-library/react";

import { TokenOdometer } from "../stats-parts.client";

// Two hourly checkpoints: the odometer plays the older figure to the newer one over the hour
// that follows the newer checkpoint, so the displayed number is a pure function of the
// checkpoints and the clock.
const CHECKPOINTS = {
  prevVal: 1_000_000,
  prevAt: "2026-10-21T08:00:00.000Z",
  currVal: 1_600_000,
  currAt: "2026-10-21T09:00:00.000Z",
  fallback: 1_600_000,
  locale: "en-GB",
  reduceMotion: false,
};

const shownAt = (iso: string) => jest.spyOn(Date, "now").mockReturnValue(Date.parse(iso));

function figure(container: HTMLElement): string {
  return container.querySelector("span")?.textContent ?? "";
}

describe("TokenOdometer", () => {
  beforeEach(() => {
    // The clock is held still by the Date.now spy, so only the timers run.
    jest.useFakeTimers({ doNotFake: ["Date"] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("adds no noise: every tick shows the same figure while the clock and the checkpoints are the same", () => {
    shownAt("2026-10-21T09:30:00.000Z");
    const random = jest.spyOn(Math, "random");

    const { container } = render(<TokenOdometer {...CHECKPOINTS} />);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(figure(container)).toBe("1,300,000");

    // Thirty seconds of ticks, in the old flicker's own step size: not one digit moves.
    const seen = new Set<string>();
    for (let elapsed = 0; elapsed < 30_000; elapsed += 350) {
      act(() => {
        jest.advanceTimersByTime(350);
      });
      seen.add(figure(container));
    }
    expect([...seen]).toEqual(["1,300,000"]);
    expect(random).not.toHaveBeenCalled();
  });

  it("keeps the real movement: the figure follows the clock between the two checkpoints", () => {
    const now = shownAt("2026-10-21T09:15:00.000Z");
    const { container } = render(<TokenOdometer {...CHECKPOINTS} />);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("1,150,000");

    now.mockReturnValue(Date.parse("2026-10-21T09:45:00.000Z"));
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("1,450,000");
  });

  it("settles on the newer checkpoint once the hour has played out, and never runs past it", () => {
    shownAt("2026-10-21T13:00:00.000Z");
    const { container } = render(<TokenOdometer {...CHECKPOINTS} />);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("1,600,000");
  });

  it("does not call itself live: the figure plays between two hourly checkpoints, about an hour behind", () => {
    shownAt("2026-10-21T09:30:00.000Z");
    const { container } = render(<TokenOdometer {...CHECKPOINTS} />);
    expect(container.querySelector("span")).toHaveAttribute("aria-label", "Tokens processed");
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).not.toMatch(/live/i);
  });

  it("shows the measured total when there are no checkpoints", () => {
    shownAt("2026-10-21T09:30:00.000Z");
    const { container } = render(
      <TokenOdometer {...CHECKPOINTS} prevVal={null} prevAt={null} currVal={null} currAt={null} fallback={5_000_000} />,
    );
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("5,000,000");
  });

  it("ticks no faster than every two seconds when the visitor prefers reduced motion", () => {
    const now = shownAt("2026-10-21T09:30:00.000Z");
    const { container } = render(<TokenOdometer {...CHECKPOINTS} reduceMotion />);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(figure(container)).toBe("1,300,000");

    now.mockReturnValue(Date.parse("2026-10-21T09:45:00.000Z"));
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("1,300,000");
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(figure(container)).toBe("1,450,000");
  });
});
