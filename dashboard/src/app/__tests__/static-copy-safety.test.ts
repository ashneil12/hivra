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
      path.join(__dirname, "..", "..", "components", "landing", "home", "content.ts"),
      path.join(__dirname, "..", "..", "components", "landing", "home", "Hero.tsx"),
      path.join(__dirname, "..", "..", "components", "landing", "home", "Closing.tsx"),
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
    const appRoot = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "api") walk(full);
        } else if (entry.name === "page.tsx" && /metadata\s*=\s*buildWebsiteMetadata\(/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(appRoot, full));
        }
      }
    };
    walk(appRoot);
    expect(offenders).toEqual([]);
  });

  it("keeps refund and contact copy on the current policy: 7-day money-back and info@hivra.cloud", () => {
    // Card refunds are a 7-day money-back guarantee (owner decision 2026-09-24),
    // and the public contact is info@hivra.cloud.
    const srcRoot = path.join(__dirname, "..", "..");
    const staleRefund: string[] = [];
    const staleContact: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules" && entry.name !== "data") walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const source = fs.readFileSync(full, "utf8");
          const relative = path.relative(srcRoot, full);
          if (/48[- ]?(?:hour|hr)s?\.? refund|refund[^"'`\n]{0,20}48[- ]?(?:hour|hr)/i.test(source)) staleRefund.push(relative);
          if (source.includes("info@hermesos.cloud")) staleContact.push(relative);
        }
      }
    };
    walk(srcRoot);
    expect(staleRefund).toEqual([]);
    expect(staleContact).toEqual([]);
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
