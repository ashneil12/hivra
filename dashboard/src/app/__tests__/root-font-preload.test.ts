import fs from "node:fs";
import path from "node:path";

// next/font preloads every font declared in the root layout on every route
// (as `Link: rel=preload` response headers). Public pages render in their own
// "Hivra Manrope"/"Hivra Plex Mono" faces, so root-declared Google fonts were
// putting five unused woff2 files (~130 KB) on the same constrained link as
// the render-blocking CSS. Root fonts must therefore opt out of preloading;
// their @font-face rules and CSS variables stay, so routes that do use them
// still fetch them on demand.
const layout = fs.readFileSync(path.resolve(__dirname, "..", "layout.tsx"), "utf8");

describe("root layout next/font declarations", () => {
  const declarations = [...layout.matchAll(/=\s*([A-Z][A-Za-z_]+)\(\{([\s\S]*?)\}\);/g)];

  it("declares the expected Google fonts", () => {
    expect(declarations.map((match) => match[1]).sort()).toEqual([
      "Outfit",
      "Playfair_Display",
      "Space_Grotesk",
      "Space_Mono",
    ]);
  });

  it.each(declarations.map((match) => [match[1], match[2]]))(
    "%s does not preload on every route",
    (_name, body) => {
      expect(body).toMatch(/preload:\s*false/);
    },
  );
});
