/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { within } from "@testing-library/react";
import { WorkTrail } from "../WorkTrail";
import { liveStepLabel, toolStep } from "../liveStep";
import type { ToolChip } from "../types";

// The orb paints on a canvas, which jsdom does not have; what it paints is not under test.
jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));
// A reasoning row opens to Markdown; the renderer is an ES module jest does not transform.
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("react-syntax-highlighter/dist/esm/prism-async-light", () => ({ __esModule: true, default: ({ children }: { children: string }) => <pre>{children}</pre> }));
jest.mock("@/components/markdown/prism-languages", () => ({ prismLanguage: (name: string) => name }));

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

describe("WorkTrail rich rows", () => {
  it("shows reasoning as its own muted row that opens to the text, never counted as a tool", () => {
    render(<WorkTrail hasText tools={[tool({ id: "t", name: "Thinking", kind: "thinking", detail: "Checking the parser", result: "It splits on commas." })]} />);
    // The fold is named for the reasoning, not for tools; its row opens to the whole text.
    expect(screen.queryByText(/Used \d+ tool/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    const row = screen.getByRole("button", { name: "Show thinking: Checking the parser" });
    expect(screen.queryByText("It splits on commas.")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText("It splits on commas.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide thinking" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps reasoning out of view while the reply streams, and says Thinking for it", () => {
    render(<WorkTrail streaming hasText={false} tools={[tool({ id: "t", name: "Thinking", kind: "thinking", status: "running", result: "Secret musings" })]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.queryByText("Secret musings")).not.toBeInTheDocument();
  });

  it("shows an edit as a file chip with its line counts, opening a diff of the change", () => {
    const edit = tool({ id: "e", name: "Edit", detail: "/w/src/a.ts", input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b\nc" } });
    render(<WorkTrail hasText tools={[edit, tool({ id: "b", name: "Bash", detail: "ls" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Used 2 tools" }));
    const chip = screen.getByRole("button", { name: "Preview changes: a.ts" });
    expect(chip).toHaveTextContent("+2");
    expect(chip).toHaveTextContent("1");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Change preview: a.ts" });
    expect(within(dialog).getByText("c")).toBeInTheDocument();
  });

  it("lists an edit whose input says nothing about the change as an ordinary tool row", () => {
    render(<WorkTrail hasText tools={[tool({ id: "e", name: "Edit", detail: "a.ts" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Used 1 tool" }));
    expect(screen.getByRole("button", { name: "Edit · a.ts — Completed" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Preview/ })).not.toBeInTheDocument();
  });

  it("leaves task lists and plans to their own cards", () => {
    render(<WorkTrail hasText tools={[tool({ id: "t", name: "TodoWrite", input: { todos: [{ content: "x", status: "pending" }] } }), tool({ id: "p", name: "ExitPlanMode", input: { plan: "# P" } })]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
