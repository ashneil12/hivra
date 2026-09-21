import { surfaceMenuLayout } from "../surface-navigation-layout";

it.each([
  { name: "small phone", anchor: { top: 141, bottom: 185 }, bounds: { top: 85, bottom: 504 } },
  { name: "landscape phone", anchor: { top: 141, bottom: 185 }, bounds: { top: 85, bottom: 326 } },
  { name: "safe areas", anchor: { top: 188, bottom: 232 }, bounds: { top: 132, bottom: 569 } },
  { name: "keyboard", anchor: { top: 141, bottom: 185 }, bounds: { top: 85, bottom: 300 } },
])("keeps the Tools menu inside the usable $name area", ({ anchor, bounds }) => {
  const { placement, maxHeight } = surfaceMenuLayout(anchor, bounds);
  const top = placement === "below" ? anchor.bottom + 8 : anchor.top - 8 - maxHeight;
  expect(maxHeight).toBeGreaterThanOrEqual(44);
  expect(top).toBeGreaterThanOrEqual(bounds.top + 8);
  expect(top + maxHeight).toBeLessThanOrEqual(bounds.bottom - 8);
});

it("opens above a low anchor when the space below is obstructed", () => {
  expect(surfaceMenuLayout({ top: 410, bottom: 454 }, { top: 85, bottom: 504 }))
    .toEqual({ placement: "above", maxHeight: 309 });
});

it("caps tall menus and never invents space when fully occluded", () => {
  expect(surfaceMenuLayout({ top: 100, bottom: 144 }, { top: 0, bottom: 1200 }).maxHeight).toBe(420);
  expect(surfaceMenuLayout({ top: 0, bottom: 44 }, { top: 0, bottom: 44 }).maxHeight).toBe(0);
});
