/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";

import { plainInline, renderInline } from "../inline";

describe("renderInline", () => {
  it("draws each **bold** run as <strong> and keeps the plain text around it", () => {
    const { container } = render(
      <p>{renderInline("This page separates **what you can use now**, **what we intend to build next**, and more.")}</p>,
    );
    const strong = [...container.querySelectorAll("strong")].map((node) => node.textContent);
    expect(strong).toEqual(["what you can use now", "what we intend to build next"]);
    expect(container.textContent).toBe("This page separates what you can use now, what we intend to build next, and more.");
    expect(container.textContent).not.toContain("**");
  });

  it("returns text with no bold run unchanged", () => {
    const { container } = render(<p>{renderInline("Those are the problems behind Hivra's wider ecosystem.")}</p>);
    expect(container.textContent).toBe("Those are the problems behind Hivra's wider ecosystem.");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("gives the first use of a glossary term in plain text, and inside a bold run, its tooltip", () => {
    const { container } = render(
      <p>{renderInline("We intend to explore **macOS where technically and legally feasible**, and **custom images**. Launch supported AI agents today.")}</p>,
    );
    const terms = [...container.querySelectorAll("[data-gloss]")].map((node) => node.textContent);
    expect(terms).toEqual(expect.arrayContaining(["macOS", "custom images", "AI agents"]));
    // The tooltip lives in an attribute, so the text a reader sees is unchanged.
    expect(container.textContent).toBe(
      "We intend to explore macOS where technically and legally feasible, and custom images. Launch supported AI agents today.",
    );
  });

  it("links a bold run when asked, and never puts a glossary tooltip inside the link", () => {
    const { container } = render(
      <p>
        {renderInline("**Gate** could let the agent use an account. **Elsewhere** stays plain.", {
          hrefForBold: (text) => (text === "Gate" ? "#gate" : undefined),
        })}
      </p>,
    );
    const link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "#gate");
    expect(link?.textContent).toBe("Gate");
    expect(link?.closest("strong")).not.toBeNull();
    expect(link?.querySelector("[data-gloss]")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("strong")).toHaveLength(2);
  });
});

describe("plainInline", () => {
  it("removes the bold markers and nothing else", () => {
    expect(plainInline("**Arena** and **Seal** could provide evidence.")).toBe("Arena and Seal could provide evidence.");
    expect(plainInline("No markers here.")).toBe("No markers here.");
  });
});
