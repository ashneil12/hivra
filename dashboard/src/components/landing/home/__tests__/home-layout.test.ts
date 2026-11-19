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
  it("keeps the dimmest text token readable on the page background", () => {
    expect(contrast(token("--faint"), token("--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--muted"), token("--bg"))).toBeGreaterThanOrEqual(7);
  });

  it("sets the small print under the agents in the muted colour", () => {
    const rule = css.match(/\.agentsFoot\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/color:\s*var\(--muted\)/);
  });

  it("stacks the steps and the prices into one column on narrow screens", () => {
    expect(css).toMatch(/@media \(max-width: 999px\)\s*\{[^@]*\.stepList, \.priceGrid \{ grid-template-columns: 1fr; \}/);
  });
});
