/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";

// The font parser next/font uses to size its own fallbacks.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fontkit = require("next/dist/compiled/@next/font/dist/fontkit").default;
const openFont = (file: string) => (fontkit.default || fontkit)(readFileSync(file));

const DASHBOARD = path.resolve(__dirname, "../../../..");
const css = readFileSync(path.join(DASHBOARD, "src/components/public-site/public-site.module.css"), "utf8");
const manrope = openFont(path.join(DASHBOARD, "public/fonts/Manrope-Variable.ttf"));

// next/font's average-width sample and its Arial figure. Arial Bold is the
// same sample measured on Arial Bold.ttf (2048 units per em).
const SAMPLE = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";
const ARIAL = 934.5116279069767 / 2048;
const ARIAL_BOLD = 1011.046511627907 / 2048;

type Font = { unitsPerEm: number; ascent: number; descent: number; lineGap: number; glyphsForString(text: string): { advanceWidth: number }[] };

function expected(font: Font, fallbackWidth: number) {
  const widths = font.glyphsForString(SAMPLE).map(glyph => glyph.advanceWidth);
  const sizeAdjust = widths.reduce((sum, width) => sum + width, 0) / widths.length / font.unitsPerEm / fallbackWidth;
  const pct = (value: number) => `${Math.abs(value * 100).toFixed(2)}%`;
  return {
    "size-adjust": pct(sizeAdjust),
    "ascent-override": pct(font.ascent / (font.unitsPerEm * sizeAdjust)),
    "descent-override": pct(font.descent / (font.unitsPerEm * sizeAdjust)),
    "line-gap-override": font.lineGap === 0 ? "0%" : pct(font.lineGap / (font.unitsPerEm * sizeAdjust)),
  };
}

function fallbackFace(weights: string) {
  const face = [...css.matchAll(/@font-face\{([^}]*)\}/g)]
    .map(match => Object.fromEntries(match[1].split(";").map(rule => rule.split(/:(.*)/s).map(part => part.trim()))))
    .find(rules => rules["font-family"] === '"Hivra Manrope Fallback"' && rules["font-weight"] === weights);
  if (!face) throw new Error(`no Hivra Manrope Fallback face for weights ${weights}`);
  return face as Record<string, string>;
}

describe("public site font fallback", () => {
  it("sizes Arial to Manrope 400 for regular text", () => {
    const face = fallbackFace("200 500");
    expect(face.src).toBe('local("Arial"),local("ArialMT")');
    expect(face).toMatchObject(expected(manrope.getVariation({ wght: 400 }), ARIAL));
  });

  it("sizes Arial Bold to Manrope 600 for headings", () => {
    const face = fallbackFace("501 800");
    expect(face.src).toBe('local("Arial Bold"),local("Arial-BoldMT")');
    expect(face).toMatchObject(expected(manrope.getVariation({ wght: 600 }), ARIAL_BOLD));
  });

  it("uses the sized fallback before any unsized one", () => {
    expect(css).toContain('--public-font:"Hivra Manrope","Hivra Manrope Fallback","Helvetica Neue",Arial,sans-serif;');
    expect(css.match(/font-family:"Hivra Manrope",(?!"Hivra Manrope Fallback")/g)).toBeNull();
  });
});
