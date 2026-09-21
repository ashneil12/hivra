import {
  appendWebUIAppearanceSearchParams,
  normalizeWebUIAppearanceSkin,
  normalizeWebUIAppearanceTheme,
  resolveWebUIAppearanceFromDashboardTheme,
} from "@/lib/webui-appearance";

describe("webui appearance", () => {
  it("maps dashboard dark mode to the black Hivra chat skin instead of the Nous-blue skin", () => {
    expect(resolveWebUIAppearanceFromDashboardTheme("dark")).toEqual({
      theme: "dark",
      skin: "hivra",
      colorScheme: "dark",
    });
  });

  it("keeps dashboard light mode on the Hivra skin too so chat and dashboard stay paired", () => {
    expect(resolveWebUIAppearanceFromDashboardTheme("light")).toEqual({
      theme: "hermesos-light",
      skin: "hivra",
      colorScheme: "light",
    });
  });

  it("accepts the modern Hivra skin while preserving the legacy HermesOS skin for old handoff URLs", () => {
    expect(normalizeWebUIAppearanceSkin("hivra")).toBe("hivra");
    expect(normalizeWebUIAppearanceSkin(" hermesos ")).toBe("hermesos");
    expect(normalizeWebUIAppearanceSkin("nous")).toBeNull();
  });

  it("keeps unsupported themes out of the signed iframe handoff URL", () => {
    expect(normalizeWebUIAppearanceTheme("dark")).toBe("dark");
    expect(normalizeWebUIAppearanceTheme("hermesos-light")).toBe("hermesos-light");
    expect(normalizeWebUIAppearanceTheme("nous")).toBeNull();
  });

  it("appends the requested Hivra skin to the iframe URL", () => {
    const url = appendWebUIAppearanceSearchParams("https://agent.example.com/#iframe_token=secret", {
      theme: "dark",
      skin: "hivra",
      colorScheme: "dark",
    });

    expect(url).toBe("https://agent.example.com/?theme=dark&skin=hivra#iframe_token=secret");
  });
});
