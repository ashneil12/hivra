/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { EditorialMarkdownLink, EditorialQuestions } from "../Editorial";

describe("editorial reading controls", () => {
  it("opens external web sources separately while keeping site and section links in place", () => {
    render(<>
      <EditorialMarkdownLink href="https://docs.example.org/guide">External source</EditorialMarkdownLink>
      <EditorialMarkdownLink href="//docs.example.org/guide">Protocol-relative source</EditorialMarkdownLink>
      <EditorialMarkdownLink href="/blog/guide">Article</EditorialMarkdownLink>
      <EditorialMarkdownLink href="https://hivra.cloud/features">Feature</EditorialMarkdownLink>
      <EditorialMarkdownLink href="#section-2">Section</EditorialMarkdownLink>
      <EditorialMarkdownLink href="mailto:info@hermesos.cloud">Email</EditorialMarkdownLink>
    </>);
    for (const name of ["External source", "Protocol-relative source"]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("target", "_blank");
      expect(screen.getByRole("link", { name })).toHaveAttribute("rel", "noopener noreferrer");
    }
    for (const name of ["Article", "Feature", "Section", "Email"]) {
      expect(screen.getByRole("link", { name })).not.toHaveAttribute("target");
    }
  });

  it("keeps every supplied question and answer visible before the reader collapses it", () => {
    const questions = [{ q: "Can I keep my key?", a: "The supplied answer stays complete." }, { q: "Where does it run?", a: "A second distinct answer." }];
    const { container } = render(<EditorialQuestions questions={questions} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(2);
    for (const { q, a } of questions) {
      expect(screen.getByText(q)).toBeVisible();
      expect(screen.getByText(a)).toBeVisible();
    }
  });
});
