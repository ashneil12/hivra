/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import AgentsDeployedStat from "../AgentsDeployedStat";

test("shows the count it is given, with its date, as a link to /stats", () => {
  render(<AgentsDeployedStat total={12345} asOf="2026-10-20" />);
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "/stats");
  expect(link).toHaveTextContent("12,345");
  expect(link).toHaveTextContent("agents and computers launched on Hivra");
  expect(link).toHaveTextContent("As of 20 October 2026");
  expect(link).toHaveAccessibleName("12,345 agents and computers launched on Hivra, As of 20 October 2026. Full stats");
});

test.each([
  ["a count of zero", { total: 0, asOf: "2026-10-20" }],
  ["a negative count", { total: -3, asOf: "2026-10-20" }],
  ["a count that is not a number", { total: Number.NaN, asOf: "2026-10-20" }],
  ["no count", { asOf: "2026-10-20" }],
  ["no date", { total: 10 }],
])("shows nothing for %s", (_label, props) => {
  const { container } = render(<AgentsDeployedStat {...props} />);
  expect(container).toBeEmptyDOMElement();
});

// The pack: "Never hard-code an old or sample count." The component takes its
// number from the page and holds no number of its own.
test("holds no number in its source", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "AgentsDeployedStat.tsx"), "utf8");
  expect(source).not.toMatch(/\b\d{1,3},\d{3}\b|\b[1-9]\d{3,}\b/);
  expect(source).not.toMatch(/useAgentsDeployedPolling|RELAUNCH_AGENTS_TOTAL/);
});
