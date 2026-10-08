/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

import { articleMarkdownComponents } from "../article-markdown";

jest.mock("@/components/markdown/CodeBlock", () => ({
  CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
jest.mock("@/components/public-editorial/Editorial", () => ({
  EditorialMarkdownLink: (props: { href?: string; children?: React.ReactNode }) => <a href={props.href}>{props.children}</a>,
}));

type ImgProps = { node?: unknown; src?: unknown; alt?: string; title?: string };
type PProps = { node?: { children: Array<{ type: string; tagName?: string }> }; children?: React.ReactNode };

const Img = articleMarkdownComponents.img as unknown as (props: ImgProps) => React.ReactElement | null;
const P = articleMarkdownComponents.p as unknown as (props: PProps) => React.ReactElement;

describe("article markdown renderers", () => {
  it("renders an image as a figure, with the Markdown title as its caption", () => {
    const { container } = render(<>{Img({ src: "/images/laptop-sleep.webp", alt: "A laptop asleep", title: "What sleep pauses" })}</>);
    const figure = container.querySelector("figure");
    expect(figure).not.toBeNull();
    const img = figure!.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/images/laptop-sleep.webp");
    expect(img).toHaveAttribute("alt", "A laptop asleep");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(figure!.querySelector("figcaption")).toHaveTextContent("What sleep pauses");
  });

  it("gives an image without a title no caption, and drops one without a source", () => {
    const { container } = render(<>{Img({ src: "/a.webp", alt: "" })}</>);
    expect(container.querySelector("figcaption")).toBeNull();
    expect(Img({ alt: "no source" })).toBeNull();
  });

  it("does not wrap a lone image in a paragraph (a figure cannot sit inside one)", () => {
    const lone = render(<>{P({ node: { children: [{ type: "element", tagName: "img" }] }, children: <span data-testid="kid" /> })}</>);
    expect(lone.container.querySelector("p")).toBeNull();
    expect(lone.getByTestId("kid")).toBeInTheDocument();

    const text = render(<>{P({ node: { children: [{ type: "text" }] }, children: "Some words" })}</>);
    expect(text.container.querySelector("p")).toHaveTextContent("Some words");
  });
});

// The syntax highlighter renders its <code> inside a <div>, so the inline-code chip rule matched every line of every code
// block (pale text on a pale chip). This guards the rule that resets it; the layout itself is checked in a browser.
describe("article stylesheet", () => {
  const css = readFileSync(path.resolve(__dirname, "../secondary-site.module.css"), "utf8");

  it("resets the inline-code chip inside code blocks", () => {
    expect(css).toMatch(/\.articleBody \.code div code\s*\{[^}]*background:\s*none[^}]*border:\s*0[^}]*padding:\s*0/);
  });

  it("keeps the short answer box and a readable line length", () => {
    expect(css).toMatch(/\.articleBody \.shortAnswer\s*\{/);
    expect(css).toMatch(/\.articleBody p,[^{]*\{\s*max-width:\s*68ch/);
  });
});
