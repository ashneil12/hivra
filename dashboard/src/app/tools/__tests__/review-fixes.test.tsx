/** @jest-environment jsdom */
// The fixes made after the first review of the copy overhaul (2026-10-21): commands quoted in FAQ answers are set in
// code without changing the words, the survival check carries a phone score bar and bold fix labels, the hosting
// table keeps its table roles when it restacks, and the tmux diagram has a stacked version for phones.
import "@testing-library/jest-dom";
import React from "react";
import { render, within } from "@testing-library/react";

import ToolPage from "../[slug]/page";
import { getToolEntry } from "@/lib/tools/tool-catalog";
import { TMUX_DIAGRAM } from "@/lib/tools/tmux-sheet";

jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="public-site">{children}</div>,
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
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image in jsdom
    <img src={src} alt={alt} width={width} height={height} className={className} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

async function renderTool(slug: string) {
  return render(await ToolPage({ params: Promise.resolve({ slug }) }));
}

function faqSchema(container: HTMLElement): { name: string; acceptedAnswer: { text: string } }[] {
  const graphs = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.innerHTML));
  const faq = graphs.flatMap((graph) => graph["@graph"] ?? [graph]).find((node) => node["@type"] === "FAQPage");
  return faq?.mainEntity ?? [];
}

describe("commands in FAQ answers are set in code and the words do not change", () => {
  it.each(["tmux-cheat-sheet", "keep-mac-awake"])("%s: every answer reads exactly as the catalog and the structured data", async (slug) => {
    const entry = getToolEntry(slug)!;
    const { container } = await renderTool(slug);
    const answers = Array.from(container.querySelectorAll("details")).map((details) => details.querySelector("p")?.textContent);
    expect(answers).toEqual(entry.faqs.map((faq) => faq.a));
    expect(faqSchema(container).map((item) => item.acceptedAnswer.text)).toEqual(entry.faqs.map((faq) => faq.a));
  });

  it("tmux: the logging command is one piece of code, and no answer has a bare command left in prose", async () => {
    const { container } = await renderTool("tmux-cheat-sheet");
    const logging = Array.from(container.querySelectorAll("details")).find((details) => details.textContent?.includes("How do I log tmux output to a file?"))!;
    const codes = Array.from(logging.querySelectorAll("code")).map((code) => code.textContent);
    expect(codes).toEqual([
      "tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'",
      "tmux pipe-pane -t NAME:",
      "tmux capture-pane -p -S - -t NAME: > file",
    ]);

    // Every "tmux ..." command in every answer sits inside a code element.
    for (const details of Array.from(container.querySelectorAll("details"))) {
      const paragraph = details.querySelector("p")!;
      const prose = Array.from(paragraph.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ");
      expect(prose).not.toMatch(/\btmux (?:ls|attach|new|set|pipe-pane|capture-pane)\b/);
    }
  });

  it("keep-mac-awake: flags and commands are code", async () => {
    const { container } = await renderTool("keep-mac-awake");
    const codes = Array.from(container.querySelectorAll("details code")).map((code) => code.textContent);
    expect(codes).toEqual(expect.arrayContaining(["caffeinate -i", "caffeinate -is claude", "-s", "-t", "pkill caffeinate", "Ctrl-C", "HandleLidSwitch=ignore"]));
    // The flag inside "-is" is not split out of it.
    expect(codes).not.toContain("-is");
  });

  it("pages that do not list commands keep their glossary answers", async () => {
    const { container } = await renderTool("claude-code-plan-calculator");
    expect(container.querySelectorAll("details code")).toHaveLength(0);
  });
});

describe("the survival check", () => {
  it("shows the score on a phone without repeating it for assistive tech, and sets the fix labels in bold", async () => {
    const { container } = await renderTool("agent-survival-check");
    const bar = within(container).getByTestId("asc-mini-score");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).toHaveTextContent(/^Score\d+\/100$/);

    const leads = Array.from(container.querySelectorAll("strong")).map((node) => node.textContent);
    expect(leads).toEqual(expect.arrayContaining(["Free fix:", "Honest tradeoff:"]));
    // The label is bold, the sentence around it is the same.
    const first = Array.from(container.querySelectorAll("strong")).find((node) => node.textContent === "Free fix:")!.closest("p")!;
    expect(first.textContent).toMatch(/^Free fix: keep the machine awake while the agent runs\./);
  });
});

describe("the hosting calculator", () => {
  it("states table roles, because its rows are laid out as a grid on a phone", async () => {
    const { container } = await renderTool("ai-agent-hosting-cost-calculator");
    const table = within(container).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((node) => node.textContent)).toEqual(["DIY line item", "Per month", "Notes"]);
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getByRole("cell", { name: "$2,035 over 12 months" })).toBeInTheDocument();
  });
});

describe("the tmux diagram", () => {
  it("serves the stacked drawing to phones and keeps one image with its alt text and size", async () => {
    const { container } = await renderTool("tmux-cheat-sheet");
    const picture = container.querySelector("picture")!;
    const source = picture.querySelector("source")!;
    expect(source).toHaveAttribute("media", `(max-width: ${TMUX_DIAGRAM.narrow.maxWidth}px)`);
    expect(source).toHaveAttribute("srcset", TMUX_DIAGRAM.narrow.src);
    const images = picture.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", TMUX_DIAGRAM.src);
    expect(images[0]).toHaveAttribute("width", String(TMUX_DIAGRAM.width));
    expect(images[0].getAttribute("alt")).toMatch(/^Diagram of how tmux nests its parts\./);
  });
});
