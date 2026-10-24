import { parseMarkup, stripMarkup } from "../markup";

describe("tools catalog inline marks", () => {
  it("reads italic, bold and code runs and keeps the words around them", () => {
    expect(parseMarkup("each command builder tells you what it *cannot* fix.")).toEqual([
      { kind: "text", text: "each command builder tells you what it " },
      { kind: "em", text: "cannot" },
      { kind: "text", text: " fix." },
    ]);
    expect(parseMarkup("a **short** word and `Ctrl-b d` typed")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "short" },
      { kind: "text", text: " word and " },
      { kind: "code", text: "Ctrl-b d" },
      { kind: "text", text: " typed" },
    ]);
  });

  it("leaves text without marks alone, including a lone asterisk and arithmetic", () => {
    expect(parseMarkup("Max 5x is 5 * Pro")).toEqual([{ kind: "text", text: "Max 5x is 5 * Pro" }]);
    expect(stripMarkup("Plain words, nothing marked.")).toBe("Plain words, nothing marked.");
  });

  it("strips the marks to the text a reader sees", () => {
    expect(stripMarkup("show a *possible* end, then run `caffeinate` and **stop**")).toBe(
      "show a possible end, then run caffeinate and stop",
    );
  });
});
