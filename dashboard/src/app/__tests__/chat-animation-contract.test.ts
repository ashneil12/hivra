import fs from "fs";
import path from "path";
import postcss from "postcss";

describe("chat text animation contract", () => {
  const globalsCss = fs.readFileSync(path.join(__dirname, "..", "globals.css"), "utf8");

  it("uses a premium reveal instead of the old upward-only fade", () => {
    expect(globalsCss).toContain("@keyframes chat-text-reveal");
    expect(globalsCss).toContain("filter: blur(6px)");
    expect(globalsCss).toContain("transform: translate3d(0, 4px, 0) scale(0.992)");
    expect(globalsCss).toContain(".animate-fade-up { animation: chat-text-reveal 0.38s");
  });

  it("removes the reveal motion for reduced-motion users", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalsCss).toContain(".animate-fade-up { animation: none;");
  });
});


describe("Hivra chat motion accessibility", () => {
  const css = postcss.parse(fs.readFileSync(path.join(__dirname, "..", "globals.css"), "utf8"));

  it.each([
    ".hivra-chat-message", ".hivra-chat-activity-wrap", ".hivra-chat-tool-history-list",
    ".hivra-chat-activity-dot.is-running", ".hivra-chat-spinner", ".hivra-chat-message .animate-bounce",
  ])("disables animation for %s inside the reduced-motion query", (selector) => {
    let disabled = false;
    css.walkAtRules("media", (media) => {
      if (media.params !== "(prefers-reduced-motion: reduce)") return;
      media.walkRules((rule) => {
        if (rule.selectors.includes(selector)) {
          rule.walkDecls("animation", (decl) => { if (decl.value === "none") disabled = true; });
        }
      });
    });
    expect(disabled).toBe(true);
  });

  it("keeps chat entrance motion within 120–200ms", () => {
    let entrances = 0;
    css.walkDecls("animation", (decl) => {
      if (!decl.value.startsWith("hivra-chat-activity-in")) return;
      const duration = Number(decl.value.match(/(\d+)ms/)?.[1]);
      expect(duration).toBeGreaterThanOrEqual(120);
      expect(duration).toBeLessThanOrEqual(200);
      entrances += 1;
    });
    expect(entrances).toBeGreaterThan(0);
  });

  it("does not override reduced-motion spinner styles with inline animations", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../components/hivra/HivraChat.tsx"), "utf8");
    expect(source).not.toMatch(/animation\s*:/);
  });
});
