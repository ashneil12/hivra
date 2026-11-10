import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.join(__dirname, "..", "home.module.css"), "utf8");

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The homepage scope is the dark glass scheme: ink hsl(240 0% 92%) over base hsl(240 0% 9%). Text tokens are the ink at an opacity. */
const INK = 235;
const BASE = 23;
const hex = (v: number) => `#${Math.round(v).toString(16).padStart(2, "0").repeat(3)}`;

/** Resolve a text token to the opaque colour it paints over the page base. */
function token(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*color-mix\\(in srgb, var\\(--hg-fg\\) (\\d+)%`)) ?? css.match(new RegExp(`${name}:\\s*var\\(--hg-(text-2|text-3|bg)\\)`));
  if (!match) throw new Error(`token ${name} not found`);
  if (match[1] === "bg") return hex(BASE);
  const pct = match[1] === "text-2" ? 68 : match[1] === "text-3" ? 46 : Number(match[1]);
  return hex(INK * (pct / 100) + BASE * (1 - pct / 100));
}

describe("homepage layout rules the render review found", () => {
  it("draws the reach-limits picture on its side on narrow phones, so no chip is cut off", () => {
    expect(css).toMatch(/\.boundaryTall\s*\{\s*display:\s*none;\s*\}/);
    const narrow = css.match(/@media \(max-width: 540px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow).not.toBeNull();
    expect(narrow?.[1]).toMatch(/\.boundaryWide\s*\{\s*display:\s*none;\s*\}/);
    expect(narrow?.[1]).toMatch(/\.boundaryTall\s*\{\s*display:\s*block;\s*\}/);
    expect(narrow?.[1]).toMatch(/\.boundaryVisual\s*\{\s*aspect-ratio:\s*360 \/ 500;\s*\}/);
    // The chips are placed from custom properties, never from a fixed inline top.
    expect(css).toMatch(/\.allowList li, \.blockList li \{[^}]*top: var\(--lane-y\)/);
    expect(narrow?.[1]).toMatch(/top: var\(--tall-y\); left: var\(--col-x\)/);
  });

  it("keeps the dimmest text token readable on the page background", () => {
    expect(contrast(token("--faint"), token("--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--muted"), token("--bg"))).toBeGreaterThanOrEqual(7);
  });

  it("sets the qualifying notes in the muted colour at a readable size", () => {
    for (const selector of [".reachNote", ".agentsFoot", ".howNote", ".fitNote"]) {
      const rule = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
      expect(rule?.[1]).toMatch(/color:\s*var\(--muted\)/);
    }
    expect(css.match(/\.reachNote\s*\{[^}]*font:\s*400 (\d+(?:\.\d+)?)px/)?.[1]).toBe("14");
  });

  it("reads text beside the picture for the stacked steps on wide screens", () => {
    expect(css).toMatch(/@media \(min-width: 1000px\)\s*\{\s*\.howStackStep\s*\{[^}]*grid-template-columns:\s*minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\)/);
  });
});
