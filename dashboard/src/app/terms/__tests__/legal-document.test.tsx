/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import LegalDocument, { LegalItem, LegalList } from "../legal-document";
import LegalContents from "../legal-contents.client";
import { keepHyphenatedWordsWhole } from "../legal-text";

const SECTIONS = [
  { id: "first", heading: "1. First", children: <p>First text.</p> },
  {
    id: "second",
    heading: "2. Second",
    children: (
      <LegalList variant="stacked">
        <li>
          <strong>Label:</strong> Second text.
        </li>
      </LegalList>
    ),
  },
];

function stubMatchMedia(wide: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({ matches: wide, media: query, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
  });
}

afterEach(() => {
  // jsdom has no matchMedia until a test defines one.
  (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
});

describe("LegalDocument", () => {
  it("renders one h1, the lead, the date and each section under its heading, with the contents outside <main>", () => {
    const { container } = render(
      <LegalDocument title="Example Terms" lead={<p>Lead text.</p>} lastUpdated={{ label: "May 2, 2026", iso: "2026-05-02" }} sections={SECTIONS} />,
    );
    const main = container.querySelector("main") as HTMLElement;
    expect(main).toHaveAttribute("id", "main-content");
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("Example Terms");
    expect(within(main).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["1. First", "2. Second"]);
    expect(main.querySelector("section#first")).toContainElement(screen.getByText("First text."));
    expect(main.querySelector("time")).toHaveAttribute("datetime", "2026-05-02");
    expect(main).toHaveTextContent("Last Updated: May 2, 2026");

    const nav = screen.getByRole("navigation", { name: "Contents" });
    expect(main.contains(nav)).toBe(false);
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["1. First", "#first"],
      ["2. Second", "#second"],
    ]);
  });

  it.each(["inline", "stacked", "columns"] as const)("renders a %s list of lead-in rows as a plain list", (variant) => {
    render(
      <LegalList variant={variant}>
        <li>
          <strong>Clerk:</strong> authentication.
        </li>
      </LegalList>,
    );
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Clerk: authentication.");
  });

  it("keeps every row's text when one row is marked as stacked", () => {
    render(
      <LegalList variant="columns">
        <LegalItem>
          <strong>Short:</strong> one line.
        </LegalItem>
        <LegalItem stacked>
          <strong>Long:</strong> many lines.
        </LegalItem>
      </LegalList>,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Short: one line.", "Long: many lines."]);
    expect(rows[0]).not.toHaveAttribute("data-stacked");
    expect(rows[1]).toHaveAttribute("data-stacked");
  });

  it("offers a skip link, outside <main>, that reaches the document", () => {
    const { container } = render(
      <LegalDocument title="Example Terms" lead={<p>Lead text.</p>} lastUpdated={{ label: "May 2, 2026", iso: "2026-05-02" }} sections={SECTIONS} />,
    );
    const skip = screen.getByRole("link", { name: "Skip to the document" });
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(container.querySelector("main")!.contains(skip)).toBe(false);
    expect(container.querySelector("#main-content")).not.toBeNull();
  });

  it("defaults to the inline list", () => {
    render(
      <LegalList>
        <li>
          <strong>Clerk:</strong> authentication.
        </li>
      </LegalList>,
    );
    expect(screen.getByRole("list")).toBeInTheDocument();
  });
});

describe("LegalContents", () => {
  const ITEMS = [
    { id: "a", label: "1. A" },
    { id: "b", label: "2. B" },
  ];

  it("stays open on a wide screen and marks itself ready", () => {
    stubMatchMedia(true);
    const { container } = render(<LegalContents items={ITEMS} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details).toHaveAttribute("data-ready");
  });

  it("collapses on a narrow screen once scripts have run, and closes again after a section is chosen", () => {
    stubMatchMedia(false);
    const { container } = render(<LegalContents items={ITEMS} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details).toHaveAttribute("data-ready");

    details.open = true;
    fireEvent.click(screen.getByRole("link", { name: "2. B" }));
    expect(details.open).toBe(false);
  });

  it("leaves the list open where the browser cannot report the screen width", () => {
    const { container } = render(<LegalContents items={ITEMS} label="On this page" />);
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
    expect(screen.getByText("On this page", { selector: "summary" })).toBeInTheDocument();
  });
});

describe("keepHyphenatedWordsWhole", () => {
  it("leaves text without a hyphenated word as the same string", () => {
    expect(keepHyphenatedWordsWhole("1. Acceptance of Terms")).toBe("1. Acceptance of Terms");
  });

  it("wraps each hyphenated word in its own element and changes no character", () => {
    const { container } = render(<h2>{keepHyphenatedWordsWhole("4. Service Providers and Sub-processors")}</h2>);
    expect(container.textContent).toBe("4. Service Providers and Sub-processors");
    const wrapped = Array.from(container.querySelectorAll("span")).map((span) => span.textContent);
    expect(wrapped).toEqual(["Sub-processors"]);
  });

  it("handles several hyphenated words and a word with more than one hyphen", () => {
    const { container } = render(<p>{keepHyphenatedWordsWhole("Free-tier and up-to-date data-protection")}</p>);
    expect(container.textContent).toBe("Free-tier and up-to-date data-protection");
    expect(Array.from(container.querySelectorAll("span")).map((span) => span.textContent)).toEqual(["Free-tier", "up-to-date", "data-protection"]);
  });
});
