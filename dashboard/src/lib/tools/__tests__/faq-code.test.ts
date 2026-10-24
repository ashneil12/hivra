import { splitFaqCode } from "../faq-code";
import { TOOL_ENTRIES } from "../tool-catalog";

const join = (parts: { text: string }[]) => parts.map((part) => part.text).join("");

describe("splitFaqCode", () => {
  it("returns the answer whole when nothing is listed", () => {
    expect(splitFaqCode("Run tmux ls.", [])).toEqual([{ text: "Run tmux ls.", code: false }]);
  });

  it("marks listed phrases as code and gives the same words back", () => {
    const answer = "Run tmux ls to list sessions and tmux attach -t NAME to attach to one.";
    const parts = splitFaqCode(answer, ["tmux ls", "tmux attach -t NAME"]);
    expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual(["tmux ls", "tmux attach -t NAME"]);
    expect(join(parts)).toBe(answer);
  });

  it("prefers the longest phrase at a position", () => {
    const parts = splitFaqCode("Press Ctrl-b d to detach.", ["Ctrl-b", "Ctrl-b d"]);
    expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual(["Ctrl-b d"]);
  });

  it("only matches whole tokens, so -s is not found inside -is or systemd-inhibit", () => {
    const answer = "caffeinate -is claude keeps systemd-inhibit out. The -s flag is different.";
    const parts = splitFaqCode(answer, ["-s", "-i"]);
    expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual(["-s"]);
    expect(join(parts)).toBe(answer);
  });

  it("treats punctuation in a phrase literally", () => {
    const answer = "Run tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log' to log, or tmux pipe-pane -t NAME:, to stop.";
    const parts = splitFaqCode(answer, ["tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'", "tmux pipe-pane -t NAME:"]);
    expect(parts.filter((part) => part.code).map((part) => part.text)).toEqual(["tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'", "tmux pipe-pane -t NAME:"]);
  });
});

describe("the catalog's faqCode lists", () => {
  const withCode = TOOL_ENTRIES.filter((entry) => entry.faqCode);

  it("exist for the two pages that quote commands", () => {
    expect(withCode.map((entry) => entry.slug).sort()).toEqual(["keep-mac-awake", "tmux-cheat-sheet"]);
  });

  it.each(withCode.map((entry) => [entry.slug, entry] as const))("%s: every listed phrase is found in an answer", (_slug, entry) => {
    const found = new Set<string>();
    for (const faq of entry.faqs) {
      for (const part of splitFaqCode(faq.a, entry.faqCode!)) if (part.code) found.add(part.text);
    }
    expect([...entry.faqCode!].filter((phrase) => !found.has(phrase))).toEqual([]);
  });

  it.each(withCode.map((entry) => [entry.slug, entry] as const))("%s: no dash character or marks inside a phrase", (_slug, entry) => {
    for (const phrase of entry.faqCode!) expect(phrase).not.toMatch(/[\u2013\u2014`*]/);
  });
});
