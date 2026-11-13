import { HIVRA_PREVIEWS, getHivraPreview } from "../preview-catalog";

describe("Hivra preview catalog", () => {
  it("keeps requested integrations discoverable without granting launch authority", () => {
    expect(HIVRA_PREVIEWS.map((preview) => preview.id)).toEqual(["buzz"]);
    expect(HIVRA_PREVIEWS.every((preview) => preview.launchable === false)).toBe(true);
    expect(getHivraPreview("buzz")).toMatchObject({ usableNow: true, href: "/dashboard/collaboration#buzz" });
  });

  it("no longer lists DeepSeek Harness, which launches from Launch", () => {
    expect(getHivraPreview("deepseek-harness")).toBeUndefined();
  });
});
