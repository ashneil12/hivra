/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";

import Prose, { withInlineCode } from "../InlineCode";

const codes = (text: string) => {
  const { container } = render(<Prose text={text} />);
  return { container, codes: [...container.querySelectorAll("code")].map((node) => node.textContent) };
};

describe("Prose: flags in running text", () => {
  it("sets single-letter and double-hyphen flags in code, and leaves the text itself unchanged", () => {
    const text = "The -i flag stops idle sleep, -s stops system sleep, and --what=sleep:handle-lid-switch blocks the lid.";
    const { container, codes: found } = codes(text);
    expect(found).toEqual(["-i", "-s", "--what=sleep:handle-lid-switch"]);
    expect(container.textContent).toBe(text);
  });

  it("finds a flag at the start of the text, in brackets and before punctuation, without swallowing the punctuation", () => {
    expect(codes("-t sets a timeout").codes).toEqual(["-t"]);
    expect(codes("a timeout (-t) in seconds").codes).toEqual(["-t"]);
    expect(codes("turn on -s.").codes).toEqual(["-s"]);
    expect(codes("turn on -s, then -i").codes).toEqual(["-s", "-i"]);
    const { container } = codes("turn on -s.");
    expect(container.textContent).toBe("turn on -s.");
  });

  it("leaves hyphenated words, key chords, numbers and stray hyphens alone", () => {
    for (const text of ["closed-lid use and plugged-in power", "Ctrl-b then d", "a five-hour window", "takes 5 - 10 seconds", "minus -5 degrees", "a well-known tmux-like tool"]) {
      expect(codes(text).codes).toEqual([]);
    }
  });

  it("returns plain text parts and code elements in order", () => {
    const parts = withInlineCode("use -i now");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("use ");
    expect(parts[2]).toBe(" now");
  });

  it("returns the text untouched when there is nothing to set", () => {
    expect(withInlineCode("nothing to see")).toEqual(["nothing to see"]);
    expect(withInlineCode("")).toEqual([]);
  });
});
