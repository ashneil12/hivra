import { macDownloadFromEnv } from "@/lib/public-project-links";

describe("Mac download link", () => {
  it("stays coming soon without a real https address", () => {
    expect(macDownloadFromEnv(undefined)).toEqual({ status: "pending", href: null });
    expect(macDownloadFromEnv("  ")).toEqual({ status: "pending", href: null });
    expect(macDownloadFromEnv("http://example.com/Hivra.dmg")).toEqual({ status: "pending", href: null });
    expect(macDownloadFromEnv("javascript:alert(1)")).toEqual({ status: "pending", href: null });
  });

  it("publishes an https installer address", () => {
    const release = macDownloadFromEnv("https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg");
    expect(release.status).toBe("published");
    expect(release.href).toBe("https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg");
  });
});
