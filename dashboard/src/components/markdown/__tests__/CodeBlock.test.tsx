/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";
import { readdirSync } from "node:fs";
import path from "node:path";

// The browser gets the ES module build, whose grammars load on demand. Jest
// can't parse ES modules from node_modules, so this uses the build's CommonJS
// twin (the same code) and loads the real refractor core and grammars through
// Node's own require. The blocks below are highlighted by the real grammars.
const mockNativeRequire = (process as unknown as { getBuiltinModule(id: "node:module"): typeof import("node:module") })
  .getBuiltinModule("node:module").createRequire(__filename);
const mockGrammarsLoaded: string[] = [];
jest.mock("react-syntax-highlighter/dist/esm/prism-async-light", () =>
  jest.requireActual("react-syntax-highlighter/dist/cjs/prism-async-light"));
jest.mock("refractor/core", () => mockNativeRequire("refractor/core"));
for (const grammar of ["tsx", "python", "javascript"]) {
  jest.mock(`refractor/${grammar}`, () => {
    mockGrammarsLoaded.push(grammar);
    return mockNativeRequire(`refractor/${grammar}`);
  });
}
// Every grammar Prism knows, loaded up front, is what this component must
// never pull in again.
jest.mock("refractor", () => { throw new Error("CodeBlock loaded every Prism grammar up front"); });
jest.mock("refractor/all", () => { throw new Error("CodeBlock loaded every Prism grammar up front"); });

import { CodeBlock } from "../CodeBlock";
import { PRISM_LANGUAGE_ALIASES, prismLanguage } from "../prism-languages";

/** The rendered token spans, as the owner would see them coloured. */
const tokens = (container: HTMLElement) => Array.from(container.querySelectorAll("span.token"));
const tokenText = (container: HTMLElement) => tokens(container).map((token) => token.textContent);

describe("CodeBlock", () => {
  // First in the file, so no other block has loaded a grammar yet.
  it("loads a language's grammar only when a block needs it", async () => {
    const { container } = render(<CodeBlock language="py" value="import os" />);
    await waitFor(() => expect(tokenText(container)).toContain("import"));
    expect(mockGrammarsLoaded).toEqual(["python"]);
  });

  it("shows a tsx fence as plain code at once, then highlights it when its grammar arrives", async () => {
    const { container } = render(<CodeBlock language="tsx" value={"const view = <Panel open />;\n"} />);
    expect(container).toHaveTextContent("const view = <Panel open />;");
    expect(tokens(container)).toHaveLength(0);

    await waitFor(() => expect(tokenText(container)).toContain("const"));
    expect(tokenText(container)).toEqual(expect.arrayContaining(["Panel", "open"]));
    const keyword = tokens(container).find((token) => token.textContent === "const") as HTMLElement;
    expect(keyword.style.color).not.toBe("");
    expect(container).toHaveTextContent("const view = <Panel open />;");
  });

  it("highlights a python fence", async () => {
    const { container } = render(<CodeBlock language="python" value={"def greet(name):\n    return f\"hi {name}\""} />);
    await waitFor(() => expect(tokenText(container)).toContain("def"));
    expect(tokenText(container)).toContain("return");
  });

  it("reads a fence's short name as its Prism grammar", async () => {
    const { container } = render(<CodeBlock language="JS" value="let total = 1;" />);
    await waitFor(() => expect(tokenText(container)).toContain("let"));
    // The label keeps what the author wrote.
    expect(container).toHaveTextContent(/^js/);
  });

  it("keeps an unknown language as readable plain code", async () => {
    const { container } = render(<CodeBlock language="not-a-language" value="just words" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toHaveTextContent("just words");
    expect(tokens(container)).toHaveLength(0);
  });
});

describe("prismLanguage", () => {
  const loaders = jest.requireActual("react-syntax-highlighter/dist/cjs/async-languages/prism").default as Record<string, unknown>;
  const langDir = path.join(path.dirname(mockNativeRequire.resolve("refractor/core")), "..", "lang");
  const refractorAliases = readdirSync(langDir).filter((file) => file.endsWith(".js")).flatMap((file) => {
    const grammar = mockNativeRequire(path.join(langDir, file)).default as { displayName: string; aliases?: string[] };
    return (grammar.aliases ?? []).map((alias) => [alias, grammar.displayName] as const);
  });

  it("maps every short name refractor knows to a grammar the async build can load", () => {
    const loadable = refractorAliases.filter(([, language]) => typeof loaders[language] === "function");
    expect(loadable.length).toBeGreaterThan(80);
    for (const [alias, language] of loadable) expect([alias, prismLanguage(alias)]).toEqual([alias, language]);
    for (const [alias, language] of PRISM_LANGUAGE_ALIASES) {
      expect(refractorAliases).toContainEqual([alias, language]);
      expect(typeof loaders[language]).toBe("function");
    }
  });

  it("leaves Prism names, unknown labels and object keys alone", () => {
    expect(prismLanguage("TSX")).toBe("tsx");
    expect(prismLanguage("python")).toBe("python");
    expect(prismLanguage("constructor")).toBe("constructor");
    expect(prismLanguage("text")).toBe("text");
  });
});
