import fs from "fs";
import path from "path";

import { findBannedClaims } from "@/lib/tools/copy-rules";

// The root layout sets `title.template = "%s | Hivra"`, so a page that writes
// its own " | Hivra" suffix ships "Sign Up | Hivra | Hivra" (seen on canary for
// /sign-up, /sign-in, /get-started, /reserve, /reserved and /newupdate). Static
// metadata on every route is scanned here; dynamic generateMetadata pages are
// covered by their own tests (agents, tools, blog, compare, features).
const APP_ROOT = path.join(__dirname, "..");

interface StaticMetadata {
  file: string;
  title?: string;
  description?: string;
}

function readStaticMetadata(): StaticMetadata[] {
  const found: StaticMetadata[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "api") walk(full);
        continue;
      }
      if (!/^(page|layout)\.tsx$/.test(entry.name)) continue;
      const block = fs.readFileSync(full, "utf8").match(/export const metadata[^=]*=\s*\{[\s\S]*?\n\};/)?.[0];
      if (!block) continue;
      // Top-level keys only (two-space indent): nested openGraph titles are not
      // passed through the layout template and may carry the brand.
      found.push({
        file: path.relative(APP_ROOT, full),
        title: block.match(/^ {2}title:\s*"([^"]*)"/m)?.[1],
        description: block.match(/^ {2}description:\s*"([^"]*)"/m)?.[1],
      });
    }
  };
  walk(APP_ROOT);
  return found;
}

describe("static route metadata", () => {
  const routes = readStaticMetadata();

  it("finds the static metadata it is meant to guard", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map(route => route.file)).toEqual(
      expect.arrayContaining(["sign-up/layout.tsx", "get-started/layout.tsx", "privacy/page.tsx"]),
    );
  });

  it("never repeats the brand: the root layout template already appends ' | Hivra'", () => {
    const offenders = routes
      .filter(route => route.title && /\|\s*Hivra\s*$/.test(route.title))
      .map(route => `${route.file}: ${route.title}`);
    expect(offenders).toEqual([]);
  });

  it("carries no retired offer or speed claim in a title or description", () => {
    // "deploy ... in under 5 minutes" and "the free tier is live" were on
    // /get-started and /reserve. The shared rule set is the one /tools, /blog
    // and /agents already scan against.
    // The shared list misses "in under 5 minutes", so name that form here.
    const SPEED_CLAIM = /\bin under \d+ (?:minutes|seconds)\b/i;
    const offenders = routes.flatMap(route =>
      [route.title, route.description]
        .filter((text): text is string => Boolean(text))
        .flatMap(text => [
          ...findBannedClaims(text).map(hit => `${route.file}: "${hit.match}" in "${text}" (${hit.why})`),
          ...(SPEED_CLAIM.test(text) ? [`${route.file}: unmeasured speed claim in "${text}"`] : []),
        ]),
    );
    expect(offenders).toEqual([]);
  });
});
