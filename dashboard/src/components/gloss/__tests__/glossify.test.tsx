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

  it("explains a virtual machine at the start of a sentence too", () => {
    const { container } = render(<p>{glossify("Virtual machines start fast. A VM is cheap.")}</p>);
    expect(tips(container)).toEqual(["Virtual machines"]);
    const lower = render(<p>{glossify("Each virtual machine is separate.")}</p>);
    expect(tips(lower.container)).toEqual(["virtual machine"]);
  });

  it("defines each term accurately (F-20)", () => {
    const tip = (key: string) => glossary.find((entry) => entry.key === key)!.tip;
    // A signature shows who produced a result and that it is unchanged, not that the result is true.
    expect(tip("signed-result")).toMatch(/who produced/);
    expect(tip("signed-result")).not.toMatch(/\breal\b/);
    // Self-hosting is not limited to hardware you own.
    expect(tip("self-host")).toMatch(/computer or server you control/);
    // Not every stablecoin tracks the dollar.
    expect(tip("stablecoin")).toMatch(/usually one US dollar/);
    // The term is Base, so the tip defines Base and not just any blockchain.
    expect(tip("base-chain")).toMatch(/^Base is /);
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
