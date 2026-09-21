import "@testing-library/jest-dom";

import {
  buildHermesFadeSlideVariants,
  hermesMotion,
} from "../motion";

describe("buildHermesFadeSlideVariants", () => {
  it("defaults to a vertical fade and slide entrance", () => {
    const variants = buildHermesFadeSlideVariants(false);
    const hidden = variants.hidden as Record<string, unknown>;
    const visible = variants.visible as Record<string, unknown>;
    const exit = variants.exit as Record<string, unknown>;
    const visibleTransition = visible.transition as Record<string, unknown>;
    const exitTransition = exit.transition as Record<string, unknown>;

    expect(hidden).toMatchObject({ opacity: 0, y: 18 });
    expect(hidden).not.toHaveProperty("x");
    expect(visible).toMatchObject({ opacity: 1, y: 0 });
    expect(visibleTransition).toMatchObject({
      duration: hermesMotion.duration.base,
      ease: hermesMotion.ease,
    });
    expect(exit).toMatchObject({ opacity: 0, y: 12 });
    expect(exitTransition).toMatchObject({
      duration: hermesMotion.duration.fast,
      ease: hermesMotion.snappyEase,
    });
  });

  it("supports horizontal motion with explicit offsets", () => {
    const variants = buildHermesFadeSlideVariants(false, {
      axis: "x",
      offset: 24,
      exitOffset: 14,
      duration: hermesMotion.duration.fast,
    });
    const hidden = variants.hidden as Record<string, unknown>;
    const visible = variants.visible as Record<string, unknown>;
    const exit = variants.exit as Record<string, unknown>;
    const visibleTransition = visible.transition as Record<string, unknown>;

    expect(hidden).toMatchObject({ opacity: 0, x: 24 });
    expect(hidden).not.toHaveProperty("y");
    expect(visible).toMatchObject({ opacity: 1, x: 0 });
    expect(visibleTransition).toMatchObject({
      duration: hermesMotion.duration.fast,
      ease: hermesMotion.ease,
    });
    expect(exit).toMatchObject({ opacity: 0, x: 14 });
  });

  it("falls back to opacity-only motion when reduced motion is enabled", () => {
    const variants = buildHermesFadeSlideVariants(true, {
      axis: "x",
      offset: 24,
      exitOffset: 14,
    });
    const hidden = variants.hidden as Record<string, unknown>;
    const visible = variants.visible as Record<string, unknown>;
    const exit = variants.exit as Record<string, unknown>;
    const visibleTransition = visible.transition as Record<string, unknown>;
    const exitTransition = exit.transition as Record<string, unknown>;

    expect(hidden).toEqual({ opacity: 0 });
    expect(visible).toMatchObject({ opacity: 1 });
    expect(visible).not.toHaveProperty("x");
    expect(visible).not.toHaveProperty("y");
    expect(visibleTransition).toMatchObject({
      duration: hermesMotion.duration.instant,
      delay: 0,
    });
    expect(exit).toMatchObject({ opacity: 0 });
    expect(exit).not.toHaveProperty("x");
    expect(exitTransition).toMatchObject({
      duration: hermesMotion.duration.instant,
    });
  });
});
