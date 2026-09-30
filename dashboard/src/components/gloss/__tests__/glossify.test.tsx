/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import glossary from "@/lib/glossary.json";
import { glossify } from "../glossify";

const tips = (container: HTMLElement) => [...container.querySelectorAll("[data-tip]")].map((node) => node.textContent);

describe("glossify", () => {
  it("explains the first use of a term and leaves the words unchanged", () => {
    const { container } = render(<p>{glossify("AI agents open a terminal. AI agents are everywhere.")}</p>);
    expect(container.textContent).toBe("AI agents open a terminal. AI agents are everywhere.");
    expect(tips(container)).toEqual(["AI agents", "terminal"]);
    expect(container.querySelector("[data-tip]")).toHaveAttribute("tabindex", "0");
  });

  it("returns plain text when no term appears", () => {
    expect(glossify("Close the laptop.")).toBe("Close the laptop.");
  });

  it("keeps token terms off unless a token-reviewed page asks", () => {
    const text = "Holders get a stablecoin reward.";
    expect(glossify(text)).toBe(text);
    const { container } = render(<p>{glossify(text, { token: true })}</p>);
    expect(tips(container)).toEqual(["stablecoin"]);
  });

  it("matches whole words only", () => {
    expect(glossify("The ramp is steep and the terminalia blooms.")).toBe("The ramp is steep and the terminalia blooms.");
  });

  it("has a unique key, a valid pattern and a short plain tip for every term", () => {
    const keys = glossary.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of glossary) {
      expect(() => new RegExp(entry.pattern)).not.toThrow();
      expect(entry.tip.length).toBeLessThanOrEqual(200);
      expect(entry.tip).not.toMatch(/[–—]/);
    }
  });
});
