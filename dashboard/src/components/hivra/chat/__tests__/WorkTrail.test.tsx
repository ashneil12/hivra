/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { WorkTrail } from "../WorkTrail";
import { liveStepLabel, toolStep } from "../liveStep";
import type { ToolChip } from "../types";

// The orb paints on a canvas, which jsdom does not have; what it paints is not under test.
jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));

const tool = (patch: Partial<ToolChip> & Pick<ToolChip, "name">): ToolChip => ({ detail: "", status: "done", ...patch });

describe("WorkTrail", () => {
  it("says what the agent is doing in plain words while it works", () => {
    render(<WorkTrail streaming hasText={false} tools={[tool({ id: "1", name: "Bash", detail: "npm test -- --runInBand", status: "running" })]} />);
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Running npm test");
    expect(screen.getByTestId("orb")).toBeInTheDocument();
  });

  it("falls back to Thinking, then Writing, when no tool is running", () => {
    const { rerender } = render(<WorkTrail streaming hasText={false} tools={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    rerender(<WorkTrail streaming hasText tools={[tool({ id: "1", name: "Read", detail: "/src/app.tsx" })]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Writing");
  });

  it("folds into a muted 'Used N tools' once the reply is done", () => {
    render(<WorkTrail hasText tools={[tool({ id: "1", name: "Bash", detail: "ls" }), tool({ id: "2", name: "Read", detail: "a.ts" }), tool({ id: "3", name: "Edit", detail: "a.ts" })]} />);
    const disclosure = screen.getByRole("button", { name: "Used 3 tools" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).not.toBeVisible();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Bash · ls — Completed" })).toBeVisible();
  });

  it("counts failures as a muted '· 1 failed', never a headline", () => {
    render(<WorkTrail hasText tools={[tool({ id: "1", name: "Bash", detail: "ls" }), tool({ id: "2", name: "Bash", detail: "bad", status: "error", result: "nope" })]} />);
    const disclosure = screen.getByRole("button", { name: "Used 2 tools · 1 failed" });
    expect(disclosure).toHaveTextContent("Used 2 tools· 1 failed");
    expect(screen.queryByText(/include failures/i)).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    // The failure shows inside the rows, with its output a click away.
    const failed = screen.getByRole("button", { name: "Bash · bad — Failed" });
    fireEvent.click(failed);
    expect(screen.getByText("nope")).toBeVisible();
  });

  it("uses the singular for one tool and shows nothing for a reply with none", () => {
    const { rerender, container } = render(<WorkTrail hasText tools={[tool({ id: "1", name: "Bash", detail: "ls" })]} />);
    expect(screen.getByRole("button", { name: "Used 1 tool" })).toBeInTheDocument();
    rerender(<WorkTrail hasText tools={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lets the owner open the rows while the agent is still working", () => {
    render(<WorkTrail streaming hasText={false} tools={[tool({ id: "1", name: "Bash", detail: "ls", status: "running" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    expect(screen.getByRole("button", { name: "Bash · ls — Running" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide activity" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("live step wording", () => {
  it.each([
    [{ name: "Bash", detail: "npm test" }, "Running npm test"],
    [{ name: "Bash", detail: "cd app && npm run build" }, "Running npm run build"],
    [{ name: "Bash", detail: "/usr/local/bin/tool --flag" }, "Running a command"],
    [{ name: "Read", detail: "/home/box/project/src/app.tsx" }, "Reading app.tsx"],
    [{ name: "Edit", detail: "src/lib/format.ts" }, "Editing format.ts"],
    [{ name: "WebSearch", detail: "hivra pricing" }, "Searching the web"],
    [{ name: "WebFetch", detail: "https://example.com" }, "Reading a web page"],
    [{ name: "Grep", detail: "TODO" }, "Searching the project"],
    [{ name: "mcp__linear__list_issues", detail: "" }, "Using Linear: list issues"],
  ])("%j reads as %s", (chip, expected) => {
    expect(toolStep(chip)).toBe(expected);
  });

  it("counts several running tools after the newest one", () => {
    const tools = [tool({ id: "1", name: "Bash", detail: "ls", status: "running" }), tool({ id: "2", name: "Bash", detail: "pwd", status: "running" })];
    expect(liveStepLabel(tools, false)).toBe("Running pwd · 2 running");
  });
});
