import { getDesktopDownloads } from "@/lib/public-project-links";

describe("Mac download link", () => {
  it.each([{}, { HIVRA_DESKTOP_BROWSER_SIGNIN: "0" }, {
    HIVRA_DESKTOP_BROWSER_SIGNIN: "on", HIVRA_AUTH_MODE: "local",
  }])("hides the download where browser sign-in is unavailable: %j", (env) => {
    expect(getDesktopDownloads(env).macos).toEqual({ status: "pending", href: null });
  });

  it("links the verified versioned DMG when browser sign-in is enabled", () => {
    expect(getDesktopDownloads({ HIVRA_DESKTOP_BROWSER_SIGNIN: " ON " }).macos).toEqual({
      status: "published",
      href: "https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg",
      label: "For Apple silicon and Intel Macs, macOS 14 or newer.",
    });
  });
});
