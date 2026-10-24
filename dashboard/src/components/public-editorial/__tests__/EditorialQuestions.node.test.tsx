/** @jest-environment jsdom */
import fs from "fs";
import path from "path";
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { EditorialQuestions, type EditorialQuestion } from "../Editorial";

describe("EditorialQuestions answers with markup", () => {
  const questions: EditorialQuestion[] = [
    { q: "Plain question?", a: "A plain answer." },
    {
      q: "Where are the terms?",
      a: "The terms are on the terms page.",
      node: (
        <>
          <p>The terms are on the <a href="/terms">terms page</a>.</p>
          <ul><li>First point</li><li>Second point</li></ul>
        </>
      ),
    },
  ];

  it("renders the node in place of the plain text, and the plain text for answers without one", () => {
    const { container } = render(<EditorialQuestions questions={questions} />);
    expect(screen.getByText("A plain answer.")).toBeVisible();
    expect(screen.getByRole("link", { name: "terms page" })).toHaveAttribute("href", "/terms");
    expect(screen.getByText("First point")).toBeVisible();
    // The node replaces `a`: the plain mirror is not shown twice.
    expect(screen.queryByText("The terms are on the terms page.")).not.toBeInTheDocument();
    expect(container.querySelectorAll("details")).toHaveLength(2);
  });

  it("keeps every question open, as before", () => {
    const { container } = render(<EditorialQuestions questions={questions} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(2);
  });

  it("keeps a plain answer as one paragraph inside its question", () => {
    const { container } = render(<EditorialQuestions questions={[questions[0]]} />);
    const answer = container.querySelector("details > p");
    expect(answer).toHaveTextContent("A plain answer.");
    expect(container.querySelector("details > div")).toBeNull();
  });

  it("wraps a node answer in one block, so its paragraphs and list sit inside the question", () => {
    const { container } = render(<EditorialQuestions questions={[questions[1]]} />);
    const block = container.querySelector("details > div")!;
    expect(block.querySelectorAll("p")).toHaveLength(1);
    expect(block.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("details > p")).toBeNull();
  });

  it("falls back to the plain text when the node is empty", () => {
    render(<EditorialQuestions questions={[{ q: "Empty node?", a: "Still answered.", node: null }]} />);
    expect(screen.getByText("Still answered.")).toBeVisible();
  });

  it("keeps the heading Common questions and takes another through the title prop", () => {
    const { rerender } = render(<EditorialQuestions questions={[questions[0]]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Common questions" })).toBeVisible();
    rerender(<EditorialQuestions questions={[questions[0]]} title="Questions people usually ask" />);
    expect(screen.getByRole("heading", { level: 2, name: "Questions people usually ask" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Common questions" })).not.toBeInTheDocument();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<EditorialQuestions questions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("editorial-extras.module.css", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "editorial-extras.module.css"), "utf8");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("styles lists and links in a node answer without redefining any existing selector", () => {
    expect(rules).toMatch(/\.answerNode ul/);
    expect(rules).toMatch(/\.answerNode a\b/);
    expect(rules).not.toMatch(/\.questions\b/);
  });

  it("holds no em or en dash", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });
});
