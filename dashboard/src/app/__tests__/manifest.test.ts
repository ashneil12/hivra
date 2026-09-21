import manifest from "../manifest";

describe("app manifest", () => {
  it("launches the original agent dashboard without credential state", () => {
    const result = manifest();

    expect(result.name).toBe("Hivra");
    expect(result.short_name).toBe("Hivra");
    expect(result.start_url).toBe("/dashboard");
    expect(result.scope).toBe("/dashboard/");
    expect(result.display).toBe("standalone");
    expect(result).not.toHaveProperty("orientation");
    expect(result.background_color).toBe("#0d0d0d");
    expect(result.theme_color).toBe("#0d0d0d");
    expect(result.start_url).not.toMatch(/[?#]|token|secret|key/i);
    expect(result.shortcuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Agents", url: "/dashboard" }),
        expect.objectContaining({ name: "Chat", url: "/dashboard/chat" }),
        expect.objectContaining({ name: "Workspace preview", url: "/dashboard/workspace" }),
        expect.objectContaining({ name: "Wallet", url: "/dashboard/wallet" }),
        expect.objectContaining({ name: "Billing", url: "/dashboard/billing" }),
      ])
    );
    expect(result.shortcuts?.every(({ url }) => url.startsWith("/dashboard"))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/bearer|api[_-]?token|secret|api[_-]?key/i);
    expect(result.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/pwa-icon-192", sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ src: "/pwa-icon-512", sizes: "512x512", type: "image/png" }),
        expect.objectContaining({ src: "/apple-icon", sizes: "180x180", type: "image/png" }),
      ])
    );
  });
});
