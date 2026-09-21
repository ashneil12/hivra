import {
  getInteractiveBackgroundParticleCount,
  shouldPauseInteractiveBackground,
} from "../interactive-background-config";

describe("interactive background config", () => {
  it("caps desktop particle density on very large screens", () => {
    expect(
      getInteractiveBackgroundParticleCount({
        width: 3840,
        height: 2160,
      })
    ).toBe(72);
  });

  it("uses a smaller cap on coarse pointers", () => {
    expect(
      getInteractiveBackgroundParticleCount({
        width: 1920,
        height: 1080,
        coarsePointer: true,
      })
    ).toBe(32);
  });

  it("supports denser page-specific backgrounds without changing the default caps", () => {
    expect(
      getInteractiveBackgroundParticleCount({
        width: 1920,
        height: 1080,
        densityMultiplier: 1.75,
        maxParticles: 120,
      })
    ).toBe(120);
  });

  it("disables particles when reduced-motion or save-data hints are present", () => {
    expect(
      getInteractiveBackgroundParticleCount({
        width: 1440,
        height: 900,
        prefersReducedMotion: true,
      })
    ).toBe(0);

    expect(
      getInteractiveBackgroundParticleCount({
        width: 1440,
        height: 900,
        saveData: true,
      })
    ).toBe(0);
  });

  it("pauses animation when the document is hidden or motion should be reduced", () => {
    expect(shouldPauseInteractiveBackground({ hidden: true })).toBe(true);
    expect(shouldPauseInteractiveBackground({ prefersReducedMotion: true })).toBe(true);
    expect(shouldPauseInteractiveBackground({ saveData: true })).toBe(true);
    expect(shouldPauseInteractiveBackground({ hidden: false })).toBe(false);
  });
});
