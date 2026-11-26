import {
  macDownloadFromEnv,
  windowsDownloadFromEnv,
} from "@/lib/public-project-links";

describe("desktop download links", () => {
  it("stays coming soon without a real https address", () => {
    expect(macDownloadFromEnv(undefined)).toEqual({
      status: "pending",
      href: null,
    });
    expect(macDownloadFromEnv("  ")).toEqual({ status: "pending", href: null });
    expect(macDownloadFromEnv("http://example.com/Hivra.dmg")).toEqual({
      status: "pending",
      href: null,
    });
    expect(macDownloadFromEnv("javascript:alert(1)")).toEqual({
      status: "pending",
      href: null,
    });
  });

  it("publishes an https installer address", () => {
    const release = macDownloadFromEnv(
      "https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg",
    );
    expect(release.status).toBe("published");
    expect(release.href).toBe(
      "https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg",
    );
  });
});

describe("Windows download link", () => {
  it("stays coming soon without a real https address", () => {
    expect(windowsDownloadFromEnv(undefined)).toEqual({
      status: "pending",
      href: null,
    });
    expect(windowsDownloadFromEnv("  ")).toEqual({
      status: "pending",
      href: null,
    });
    expect(
      windowsDownloadFromEnv("http://example.com/Hivra-setup.exe"),
    ).toEqual({ status: "pending", href: null });
  });

  it("publishes an https installer address", () => {
    const release = windowsDownloadFromEnv(
      "https://github.com/ashneil12/hivra/releases/download/windows-v0.1.0/Hivra-setup.exe",
    );
    expect(release.status).toBe("published");
    expect(release.href).toBe(
      "https://github.com/ashneil12/hivra/releases/download/windows-v0.1.0/Hivra-setup.exe",
    );
    expect(release.label).toBe("For 64-bit Windows 10 or newer.");
  });
});
