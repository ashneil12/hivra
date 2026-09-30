/** @jest-environment node */
// What a crawler that does not run JavaScript receives for the plan calculator
// and the two newer tools: the H1, the default result, the method section with
// its verified date, the worked examples, the FAQ and the structured data. Rendered without a window,
// exactly as the server renders the static page.
import React from "react";
import { renderToString } from "react-dom/server";

import ToolPage from "../[slug]/page";
import { getToolEntry } from "@/lib/tools/tool-catalog";
import { TMUX_AGENT_SECTION, TMUX_DIAGRAM, TMUX_SECTIONS } from "@/lib/tools/tmux-sheet";

jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("next/image", () => {
  const MockImage = ({ src, alt, width, height, className }: { src: string; alt: string; width: number; height: number; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image on the server render
    <img src={src} alt={alt} width={width} height={height} className={className} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

async function serverHtml(slug: string): Promise<string> {
  return renderToString(await ToolPage({ params: Promise.resolve({ slug }) }));
}

/** The page's text with the tags removed, as a crawler reads it. */
const textOf = (markup: string) => markup.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "");

/** React escapes quotes and apostrophes in text; compare against the escaped form. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("server HTML of /tools/claude-code-plan-calculator", () => {
  let html: string;
  beforeAll(async () => {
    html = await serverHtml("claude-code-plan-calculator");
  });

  it("carries the H1, the default verdict and the estimate without any script running", () => {
    const entry = getToolEntry("claude-code-plan-calculator")!;
    expect(html).toMatch(new RegExp(`<h1[^>]*>${escaped(entry.h1)}</h1>`));
    expect(textOf(html)).toContain(
      "Max 5x at $100/month is the cheapest plan that fits. The same usage at API list price is an estimated $376/month.",
    );
    expect(textOf(html)).toContain("API list price, estimated");
    expect(textOf(html)).toContain("Every number here is an estimate, not a quote");
    // Opus 5.5 is the default model, so the mix starts there.
    expect(textOf(html)).toContain("100% Opus 5.5");
  });

  it("prints the verified date as plain contiguous text, so a grep for it matches the raw HTML", () => {
    const dates = html.match(/[Ll]ast verified [0-9]{4}-[0-9]{2}-[0-9]{2}/g) ?? [];
    expect(dates.length).toBeGreaterThanOrEqual(2);
    for (const date of dates) expect(date).toMatch(/2026-09-30$/);
  });

  it("carries the method heading, every dated source link, the worked examples, the FAQ and the cite block", () => {
    const entry = getToolEntry("claude-code-plan-calculator")!;
    expect(html).toContain(`<h2 id="method-heading">${entry.method!.heading}</h2>`);
    const sources = entry.method!.paragraphs.flatMap((paragraph) => paragraph.sources ?? []);
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const source of sources) expect(html).toContain(`href="${source.url}"`);
    expect(html).toContain("<h2>Worked examples</h2>");
    for (const example of entry.examples!) expect(html).toContain(escaped(example.command).split("\n")[0]);
    for (const faq of entry.faqs) expect(html).toContain(escaped(faq.q));
    expect(html).toContain("Cite this page");
    expect(html).toContain('data-testid="cite-block"');
  });

  it("names what Anthropic does not publish instead of inventing it", () => {
    const text = textOf(html);
    expect(text).toContain(escaped("No Anthropic page states a weekly multiple, a token or message count, or the size of Pro"));
    expect(text).toContain(escaped("Hivra's assumptions. Anthropic publishes neither."));
  });

  it("has the structured data, the vendor line and no placeholder leakage or banned name", () => {
    expect(html).toContain('"@type":"WebApplication"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(textOf(html)).toContain("Hivra is independent and is not affiliated with Anthropic.");
    expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/\bWindows\b/);
  });
});

describe("server HTML of /tools/keep-mac-awake", () => {
  let html: string;
  beforeAll(async () => {
    html = await serverHtml("keep-mac-awake");
  });

  it("carries the H1, the default command and its verdict without any script running", () => {
    const entry = getToolEntry("keep-mac-awake")!;
    expect(html).toMatch(new RegExp(`<h1[^>]*>${escaped(entry.h1)}</h1>`));
    expect(html).toContain(">caffeinate -is claude</pre>");
    expect(html).toContain("Keeps this Mac awake while the lid stays open");
    expect(html).toContain("What this will not cover");
    expect(html).toContain("pmset -g assertions");
    expect(html).toContain("is enough for a run you can keep an eye on");
  });

  it("prints the verified date as plain contiguous text, so a grep for it matches the raw HTML", () => {
    const dates = html.match(/[Ll]ast verified [0-9]{4}-[0-9]{2}-[0-9]{2}/g) ?? [];
    expect(dates.length).toBeGreaterThanOrEqual(2);
    for (const date of dates) expect(date).toMatch(/2026-09-30$/);
  });

  it("carries the method heading, every source link, the worked examples, the FAQ and the cite block", () => {
    const entry = getToolEntry("keep-mac-awake")!;
    expect(html).toContain(`<h2 id="method-heading">${entry.method!.heading}</h2>`);
    for (const source of entry.method!.paragraphs.flatMap((paragraph) => paragraph.sources ?? [])) {
      expect(html).toContain(`href="${source.url}"`);
    }
    expect(html).toContain("<h2>Worked examples</h2>");
    for (const example of entry.examples!) expect(html).toContain(escaped(example.command).split("\n")[0]);
    for (const faq of entry.faqs) expect(html).toContain(escaped(faq.q));
    expect(html).toContain("Cite this page");
    expect(html).toContain('data-testid="cite-block"');
  });

  it("has the structured data and no placeholder leakage", () => {
    expect(html).toContain('"@type":"WebApplication"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
  });
});

describe("server HTML of /tools/tmux-cheat-sheet", () => {
  let html: string;
  beforeAll(async () => {
    html = await serverHtml("tmux-cheat-sheet");
  });

  it("carries the H1 and the whole cheat sheet in the page source", () => {
    expect(html).toMatch(/<h1[^>]*>tmux cheat sheet<\/h1>/);
    for (const section of TMUX_SECTIONS) {
      expect(html).toContain(`id="${section.id}-heading"`);
      for (const row of section.rows) {
        // Read as text: a command's words sit in their own spans, and its copy button repeats it in an attribute.
        if (row.command) expect(textOf(html)).toContain(escaped(row.command));
        if (row.keys) expect(textOf(html)).toContain(escaped(row.keys));
        // Flags in the explanation sit in <code>, so compare the text, not the markup.
        expect(textOf(html)).toContain(escaped(row.does));
      }
    }
    for (const row of TMUX_AGENT_SECTION.rows) expect(textOf(html)).toContain(escaped(row.command));
  });

  it("carries the default builder result and the diagram with its width, height and alt text", () => {
    expect(html).toContain("tmux send-keys -t claude: &#x27;claude&#x27; Enter");
    expect(html).toContain(`src="${TMUX_DIAGRAM.src}"`);
    expect(html).toContain(`width="${TMUX_DIAGRAM.width}"`);
    expect(html).toContain(`height="${TMUX_DIAGRAM.height}"`);
    expect(html).toMatch(/alt="Diagram of how tmux nests its parts\./);
  });

  it("prints the verified date as plain contiguous text and carries the method and cite block", () => {
    const dates = html.match(/[Ll]ast verified [0-9]{4}-[0-9]{2}-[0-9]{2}/g) ?? [];
    expect(dates.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("How this cheat sheet was checked");
    expect(html).toContain('href="https://man7.org/linux/man-pages/man1/tmux.1.html"');
    expect(html).toContain("<h2>Worked examples</h2>");
    expect(html).toContain("Cite this page");
    expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
  });

  it("never prints the capitalised operating-system name the copy rules ban", () => {
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/\bWindows\b/);
  });
});
