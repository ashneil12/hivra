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

  it("never uses buildWebsiteMetadata as a page's whole metadata, which drops the page title", () => {
    // buildWebsiteMetadata returns only canonical, Open Graph and Twitter fields.
    // A page that exports it alone shows the site default title and description.
    // /tokenomics still does; its title is token copy owned by the token workstream.
    const allowed = new Set([path.join("tokenomics", "page.tsx")]);
    const appRoot = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "api") walk(full);
        } else if (entry.name === "page.tsx" && /metadata\s*=\s*buildWebsiteMetadata\(/.test(fs.readFileSync(full, "utf8"))) {
          const relative = path.relative(appRoot, full);
          if (!allowed.has(relative)) offenders.push(relative);
        }
      }
    };
    walk(appRoot);
    expect(offenders).toEqual([]);
  });

  it("gives the site a current default title with no dashes and a Hivra contact address", () => {
    const layout = fs.readFileSync(path.join(__dirname, "..", "layout.tsx"), "utf8");
    const defaultTitle = layout.match(/default:\s*"([^"]+)"/)?.[1];
    expect(defaultTitle).toBe("Hivra | A computer for you and your agents");
    const metadataBlock = layout.slice(layout.indexOf("export const metadata"), layout.indexOf("async function getRootLocale"));
    // Visible default titles, descriptions and image alt text (search keywords are not shown to people).
    const visibleCopy = [...metadataBlock.matchAll(/(?:title|default|description|alt):\s*"([^"]+)"/g)].map(match => match[1]);
    expect(visibleCopy.length).toBeGreaterThanOrEqual(6);
    for (const copy of visibleCopy) {
      expect(copy).not.toMatch(/[\u2013\u2014]/);
      expect(copy).not.toMatch(/one click|24\/7 uptime|formerly HermesOS/i);
    }

    const footer = fs.readFileSync(path.join(__dirname, "..", "..", "components", "landing", "Footer.tsx"), "utf8");
    expect(footer).toContain("mailto:info@hivra.cloud");
    expect(footer).not.toContain("info@hermesos.cloud");
  });
});
