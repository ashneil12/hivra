import fs from "fs";
import path from "path";

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
