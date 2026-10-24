/** @jest-environment jsdom */
import fs from "fs";
import path from "path";
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// Marks the anchors that went through next/link, so the test can tell them from plain anchors.
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} data-next-link="" {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

import ActionLinksDefault, { ActionLinks, isExternalHref, type ActionLink } from "../ActionLinks";

const ITEMS: ActionLink[] = [
  { label: "Start with Hivra Cloud", href: "/sign-up", kind: "primary", cta: "closing-start" },
  { label: "See pricing", href: "/pricing", kind: "secondary" },
  { label: "Read the source", href: "https://github.com/ashneil12/hivra", kind: "secondary", cta: "closing-source" },
];

describe("ActionLinks", () => {
  it("renders one link per item with its label and href, in order", () => {
    render(<ActionLinks items={ITEMS} />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Start with Hivra Cloud", "See pricing", "Read the source"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/sign-up", "/pricing", "https://github.com/ashneil12/hivra"]);
  });

  it("marks the button and the text links so a stylesheet and a test can tell them apart", () => {
    render(<ActionLinks items={ITEMS} />);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("data-kind"))).toEqual(["primary", "secondary", "secondary"]);
  });

  it("passes data-cta through where given, and adds none where not", () => {
    render(<ActionLinks items={ITEMS} />);
    expect(screen.getByRole("link", { name: "Start with Hivra Cloud" })).toHaveAttribute("data-cta", "closing-start");
    expect(screen.getByRole("link", { name: "See pricing" })).not.toHaveAttribute("data-cta");
    expect(screen.getByRole("link", { name: "Read the source" })).toHaveAttribute("data-cta", "closing-source");
  });

  it("opens an address off hivra.cloud in a new tab, safely, and keeps site routes in place", () => {
    render(<ActionLinks items={ITEMS} />);
    const external = screen.getByRole("link", { name: "Read the source" });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    expect(external).not.toHaveAttribute("data-next-link");
    for (const name of ["Start with Hivra Cloud", "See pricing"]) {
      const internal = screen.getByRole("link", { name });
      expect(internal).not.toHaveAttribute("target");
      expect(internal).toHaveAttribute("data-next-link");
    }
  });

  it("lets an item force or refuse a new tab", () => {
    render(
      <ActionLinks
        items={[
          { label: "Pinned open", href: "/terms", kind: "secondary", external: true },
          { label: "Pinned in place", href: "https://example.org/guide", kind: "secondary", external: false },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Pinned open" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Pinned in place" })).not.toHaveAttribute("target");
  });

  it("uses plain anchors for static documents, in-page anchors, mail and phone links", () => {
    render(
      <ActionLinks
        items={[
          { label: "Document", href: "/docs/litepaper/index.html", kind: "secondary" },
          { label: "Section", href: "#faq", kind: "secondary" },
          { label: "Email", href: "mailto:info@hivra.cloud", kind: "secondary" },
          { label: "Phone", href: "tel:+10000000000", kind: "secondary" },
        ]}
      />,
    );
    for (const name of ["Document", "Section", "Email", "Phone"]) {
      const link = screen.getByRole("link", { name });
      expect(link).not.toHaveAttribute("data-next-link");
      expect(link).not.toHaveAttribute("target");
    }
  });

  it("renders nothing for an empty list, so a page can filter links out", () => {
    const { container } = render(<ActionLinks items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the row only when a label is given", () => {
    const { rerender } = render(<ActionLinks items={ITEMS} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    rerender(<ActionLinks items={ITEMS} label="Next steps" />);
    expect(screen.getByRole("group", { name: "Next steps" })).toBeInTheDocument();
  });

  it("hides its decorative arrows from assistive technology", () => {
    const { container } = render(<ActionLinks items={ITEMS} />);
    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(ITEMS.length);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("is also the default export", () => {
    expect(ActionLinksDefault).toBe(ActionLinks);
  });
});

describe("isExternalHref", () => {
  it.each([
    ["https://github.com/ashneil12/hivra", true],
    ["http://example.org", true],
    ["//example.org/guide", true],
    ["https://hivra.cloud/pricing", false],
    ["/pricing", false],
    ["#faq", false],
    ["mailto:info@hivra.cloud", false],
  ])("%s -> %s", (href, expected) => {
    expect(isExternalHref(href)).toBe(expected);
  });
});

describe("action-links.module.css", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "action-links.module.css"), "utf8");

  it("holds no em or en dash and no text below 13px", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
    const sizes = [...css.matchAll(/font(?:-size)?:\s*(?:[a-z0-9\s]*?\s)?(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
  });
});
