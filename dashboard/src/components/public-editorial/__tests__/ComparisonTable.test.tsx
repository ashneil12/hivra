/** @jest-environment jsdom */
import fs from "fs";
import path from "path";
import React from "react";
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

import ComparisonTableDefault, { ComparisonTable, type ComparisonTableProps } from "../ComparisonTable";

const CAPTION = "Where each option stands";

const PROPS: ComparisonTableProps = {
  caption: CAPTION,
  columns: ["Your own server", "A hosting service", "Hivra Cloud"],
  rows: [
    { label: "Who runs the computer", cells: ["You", "The provider", "Hivra"] },
    { label: "Setup", cells: ["Install it yourself", "A template", <a key="start" href="/pricing">Pick a size</a>] },
  ],
};

describe("ComparisonTable", () => {
  it("is a real table, named by its caption, with a column heading per column and a row heading per row", () => {
    render(<ComparisonTable {...PROPS} />);
    const table = screen.getByRole("table", { name: CAPTION });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Your own server",
      "A hosting service",
      "Hivra Cloud",
    ]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Who runs the computer", "Setup"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getAllByRole("cell")).toHaveLength(1 + 6);
  });

  it("scopes every heading: columns in the header row, rows in the body", () => {
    const { container } = render(<ComparisonTable {...PROPS} />);
    const head = container.querySelectorAll("thead th");
    const body = container.querySelectorAll("tbody th");
    expect(head).toHaveLength(3);
    expect(body).toHaveLength(2);
    for (const heading of head) expect(heading).toHaveAttribute("scope", "col");
    for (const heading of body) expect(heading).toHaveAttribute("scope", "row");
  });

  it("puts the plain column label on every data cell, for the stacked layout", () => {
    const { container } = render(<ComparisonTable {...PROPS} />);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.querySelectorAll("td")].map((cell) => cell.getAttribute("data-label"))).toEqual([
        "Your own server",
        "A hosting service",
        "Hivra Cloud",
      ]);
    }
  });

  it("keeps the data label plain when a column carries a note", () => {
    const { container } = render(
      <ComparisonTable
        {...PROPS}
        columns={[{ label: "Your own server", note: "A VPS you manage" }, "A hosting service", { label: "Hivra Cloud", note: <em>Managed</em> }]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Your own server/ })).toHaveTextContent("A VPS you manage");
    expect(screen.getByRole("columnheader", { name: /Hivra Cloud/ })).toHaveTextContent("Managed");
    const labels = [...container.querySelectorAll("tbody tr:first-child td")].map((cell) => cell.getAttribute("data-label"));
    expect(labels).toEqual(["Your own server", "A hosting service", "Hivra Cloud"]);
  });

  it("renders React nodes in cells and row headings", () => {
    render(<ComparisonTable {...PROPS} rows={[{ label: <strong>Cost</strong>, cells: ["a", "b", <a key="c" href="/pricing">c</a>] }]} />);
    expect(screen.getByRole("rowheader")).toContainHTML("<strong>Cost</strong>");
    expect(screen.getByRole("link", { name: "c" })).toHaveAttribute("href", "/pricing");
  });

  it("marks only the highlighted column, in the heading and in every row", () => {
    const { container } = render(<ComparisonTable {...PROPS} highlight={2} />);
    const marked = [...container.querySelectorAll("[data-highlight]")];
    expect(marked.map((cell) => cell.textContent)).toEqual(["Hivra Cloud", "Hivra", "Pick a size"]);
    for (const cell of container.querySelectorAll("tbody td:not(:last-child)")) expect(cell).not.toHaveAttribute("data-highlight");
    expect(container.querySelectorAll("[data-highlight]")).toHaveLength(1 + PROPS.rows.length);
  });

  it("marks no column when none is highlighted", () => {
    const { container } = render(<ComparisonTable {...PROPS} />);
    expect(container.querySelectorAll("[data-highlight]")).toHaveLength(0);
  });

  it("uses the editorial variant unless told otherwise", () => {
    const { container, rerender } = render(<ComparisonTable {...PROPS} />);
    expect(container.querySelector("[data-comparison-table]")).toHaveAttribute("data-variant", "editorial");
    rerender(<ComparisonTable {...PROPS} variant="home" />);
    expect(container.querySelector("[data-comparison-table]")).toHaveAttribute("data-variant", "home");
  });

  it("shows an empty corner cell, or the row heading column's own heading", () => {
    const { container, rerender } = render(<ComparisonTable {...PROPS} />);
    expect(container.querySelector("thead tr")!.firstElementChild).toBeEmptyDOMElement();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    rerender(<ComparisonTable {...PROPS} rowHeading="Question" />);
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Question",
      "Your own server",
      "A hosting service",
      "Hivra Cloud",
    ]);
  });

  it("pads a short row with empty cells and drops cells beyond the last column", () => {
    const { container } = render(<ComparisonTable {...PROPS} rows={[{ label: "Short", cells: ["only one"] }, { label: "Long", cells: ["1", "2", "3", "4"] }]} />);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect([...rows[0].querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["only one", "", ""]);
    expect([...rows[1].querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["1", "2", "3"]);
  });

  it("adds no visible text of its own: the caption names the table without becoming a line of page text", () => {
    const { container } = render(<ComparisonTable {...PROPS} />);
    expect(container.textContent).not.toContain(CAPTION);
    expect(container.querySelector("caption")).toBeNull();
  });

  it("is a keyboard reachable, named region and tells the stylesheet how many columns to fit", () => {
    render(<ComparisonTable {...PROPS} />);
    const region = screen.getByRole("region", { name: CAPTION });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.style.getPropertyValue("--ct-cols")).toBe("3");
  });

  it("is also the default export", () => {
    expect(ComparisonTableDefault).toBe(ComparisonTable);
  });
});

describe("comparison-table.module.css", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "comparison-table.module.css"), "utf8");

  it("stacks each row at 700px and below, labelling cells from data-label", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 700px)"));
    expect(css).toContain("@media (max-width: 700px)");
    expect(narrow).toMatch(/content:\s*attr\(data-label\)/);
    expect(narrow).toMatch(/\.table tr[^{]*\{[^}]*display:\s*block/);
  });

  it("sets no text smaller than 13px", () => {
    const sizes = [...css.matchAll(/font(?:-size)?:\s*(?:[a-z0-9\s]*?\s)?(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
  });

  it("holds no em or en dash", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });
});
