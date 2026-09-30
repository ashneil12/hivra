/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import AboutPage, { metadata } from "../page";
import { ABOUT_FAQ, ABOUT_LINKS, ABOUT_SECTIONS, DISAMBIGUATION } from "../about-content";
import { NON_AFFILIATION_LINE, SITE_DESCRIPTION } from "@/lib/brand-description";
import { MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { findBannedClaims } from "@/lib/tools/copy-rules";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// Shows only the offending words on failure instead of the whole page text.
function hits(text: string, pattern: RegExp): string[] {
  return text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? [];
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? "{}")["@graph"];
}

describe("/about", () => {
  it("is indexable on its own URL with a title and description that name Hivra and the former name", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/about");
    expect(String(metadata.title)).toBe("About Hivra, formerly HermesOS");
    // The root layout template appends " | Hivra".
    expect(String(metadata.title)).not.toMatch(/\| Hivra$/);
    expect(String(metadata.description)).toMatch(/^Hivra \(formerly HermesOS\) is an open-source computer for you and your AI agents\./);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
    expect(`${metadata.title} ${metadata.description}`).not.toMatch(/[–—]/);
  });

  it("opens with the one-line definition under a single H1", () => {
    const { container } = render(<AboutPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("About Hivra.");
    const lead = container.querySelector("header p");
    expect(lead?.textContent).toBe(SITE_DESCRIPTION);
    expect(SITE_DESCRIPTION).toBe(
      "Hivra (hivra.cloud, formerly HermesOS) is an open-source computer for you and your AI agents, on Hivra Cloud or your own server.",
    );
  });

  it("says what Hivra is and is not, with the Hermes and plan limits", () => {
    render(<AboutPage />);
    const is = screen.getByRole("region", { name: ABOUT_SECTIONS.is.heading });
    expect(is).toHaveTextContent("Hermes runs on Hivra Cloud only");
    expect(is).toHaveTextContent("OpenClaw and Agent Zero need a paid plan there");
    expect(is).toHaveTextContent("Hivra was called HermesOS before");

    const isNot = screen.getByRole("region", { name: ABOUT_SECTIONS.isNot.heading });
    expect(isNot).toHaveTextContent(NON_AFFILIATION_LINE);
    expect(isNot).toHaveTextContent("It is not an AI model");
    expect(isNot).toHaveTextContent("It does not need a token");
  });

  it("carries the non-affiliation line, the disambiguation and the money-back line, each exactly", () => {
    const { container } = render(<AboutPage />);
    const text = container.textContent ?? "";
    expect(NON_AFFILIATION_LINE).toBe("Hivra is not affiliated with Nous Research, Anthropic or OpenAI.");
    expect(text).toContain(NON_AFFILIATION_LINE);
    expect(DISAMBIGUATION).toBe(
      "Hivra at hivra.cloud is unrelated to other projects called Hivra, such as hivra.ai and hivra.app.",
    );
    expect(text).toContain(DISAMBIGUATION);
    expect(text).toContain(`Paid plans come with a ${MONEY_BACK_GUARANTEE}.`);
    expect(MONEY_BACK_GUARANTEE).toBe("7-day money-back guarantee on card payments");
    // Neutral: the namesakes are named for clarity and never linked or criticised.
    expect(container.querySelector('a[href*="hivra.ai"], a[href*="hivra.app"]')).toBeNull();
    expect(hits(text, /scam|fake|fraud|copycat|competitor/i)).toEqual([]);
  });

  it("links the repository, pricing, status, security, terms and privacy", () => {
    render(<AboutPage />);
    const region = screen.getByRole("region", { name: ABOUT_SECTIONS.contact.heading });
    const expected: Array<[string, string]> = [
      ["Source code", "https://github.com/ashneil12/hivra"],
      ["Pricing", "/pricing"],
      ["Status", "/status"],
      ["Security", "/security"],
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
    ];
    for (const [name, href] of expected) {
      expect(within(region).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    const github = within(region).getByRole("link", { name: "Source code" });
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(region).getByRole("link", { name: "X (@HivraOS)" })).toHaveAttribute("href", "https://x.com/HivraOS");
    expect(region).toHaveTextContent("info@hivra.cloud");
  });

  it("points every internal link at a page the app serves", () => {
    const appRoot = path.join(__dirname, "..", "..");
    const internal = ABOUT_LINKS.map((link) => link.href).filter((href) => href.startsWith("/"));
    expect(internal.length).toBeGreaterThan(4);
    for (const href of internal) {
      const exists = fs.existsSync(path.join(appRoot, href.slice(1), "page.tsx"));
      expect({ href, exists }).toEqual({ href, exists: true });
    }
  });

  it("invents no facts: no legal entity, registration, address, funding or founder details the site does not state", () => {
    const { container } = render(<AboutPage />);
    const text = container.textContent ?? "";
    expect(hits(text, /\b(Ltd|Limited|LLC|LLP|plc|Inc\.?|GmbH|Corp\.?|VAT|EIN)\b/)).toEqual([]);
    expect(hits(text, /registered (company|office|in)|company (number|no)|legal entity|headquarter/i)).toEqual([]);
    expect(hits(text, /\b(Street|Road|Avenue|Suite|PO Box|postcode)\b/i)).toEqual([]);
    expect(hits(text, /funded by|raised|investors?|venture|seed round|backed by|bootstrapped|profitable/i)).toEqual([]);
    expect(hits(text, /founded in|\bborn\b|lives in|based in|located in|years of experience/i)).toEqual([]);
    // The only founder detail is the one the homepage already shows: Ash, the founder.
    expect(text).toContain("Hivra is built by Ash, the founder");
    // Marketing copy never names the licence or says public domain.
    expect(hits(text, /apache|mit licen|\blicen[sc]e\b|public domain/i)).toEqual([]);
  });

  it("makes no banned public claim and uses the glossary, in the page, the FAQ and the markup", () => {
    const { container } = render(<AboutPage />);
    const text = [container.textContent ?? "", String(metadata.description), JSON.stringify(jsonLd(container))].join("\n");
    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/\b(box|boxes|runtime|runtimes|instance|instances)\b/i);
    expect(text).not.toMatch(/[–—]/);
  });

  it("marks up an AboutPage that points at the homepage Organization, and an FAQ that mirrors the page", () => {
    const { container } = render(<AboutPage />);
    const graph = jsonLd(container);
    const about = graph.find((node) => node["@type"] === "AboutPage") as Record<string, unknown>;
    expect(about.url).toBe("https://hivra.cloud/about");
    expect(about.about).toEqual({ "@id": "https://hivra.cloud/#organization" });
    expect(about.mainEntity).toEqual({ "@id": "https://hivra.cloud/#organization" });
    expect(about.isPartOf).toEqual({ "@id": "https://hivra.cloud/#website" });

    const faq = graph.find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.map((entry) => [entry.name, entry.acceptedAnswer.text])).toEqual(ABOUT_FAQ.map(({ q, a }) => [q, a]));
    for (const { q } of ABOUT_FAQ) expect(screen.getByText(q)).toBeInTheDocument();
    // No second Organization node: the homepage owns it.
    expect(graph.some((node) => node["@type"] === "Organization")).toBe(false);
  });
});
