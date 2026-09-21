import fs from "fs";
import path from "path";

describe("Static copy safety", () => {
  it("avoids runtime Date rendering in shared footer and legal pages", () => {
    const files = [
      path.join(__dirname, "..", "privacy", "page.tsx"),
      path.join(__dirname, "..", "terms", "page.tsx"),
      path.join(__dirname, "..", "..", "components", "landing", "Footer.tsx"),
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toContain("new Date()");
      expect(source).not.toContain("toLocaleDateString()");
    }
  });

  it("does not publish stale waitlist or no-free-tier claims on registration surfaces", () => {
    const files = [
      path.join(__dirname, "..", "page.tsx"),
      path.join(__dirname, "..", "compare", "[slug]", "page.tsx"),
      path.join(__dirname, "..", "..", "components", "landing", "HeroSection.tsx"),
      path.join(__dirname, "..", "..", "components", "landing", "FinalCTASection.tsx"),
      path.join(__dirname, "..", "..", "components", "layout", "LandingHeader.tsx"),
      path.join(__dirname, "..", "..", "components", "reserve", "ReserveForm.tsx"),
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/free tier launching now/i);
      expect(source).not.toMatch(/reserve your spot/i);
      expect(source).not.toMatch(/one reservation per email/i);
      expect(source).not.toMatch(/already on the waitlist/i);
      expect(source).not.toMatch(/you're on the waitlist/i);
      expect(source).not.toMatch(/closed beta invites/i);
      expect(source).not.toContain('hermesOs: "No — from $9.99/mo"');
    }
  });
});
