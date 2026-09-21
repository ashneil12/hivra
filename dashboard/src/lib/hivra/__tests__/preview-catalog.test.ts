import { HIVRA_PREVIEWS, getHivraPreview } from "../preview-catalog";

describe("Hivra preview catalog", () => {
  it("keeps requested integrations discoverable without granting launch authority", () => {
    expect(HIVRA_PREVIEWS.map((preview) => preview.id)).toEqual([
      "deepseek-harness",
      "buzz",
      "omarchy",
    ]);
    expect(HIVRA_PREVIEWS.every((preview) => preview.launchable === false)).toBe(true);
    expect(getHivraPreview("buzz")).toMatchObject({ usableNow: true, href: "/dashboard/collaboration#buzz" });
    expect(getHivraPreview("deepseek-harness")).toMatchObject({
      usableNow: false,
      href: "/dashboard/agents#deepseek-harness",
    });
  });
});
