import {
  baseName,
  diffFromToolInput,
  isPlanTool,
  isTaskListTool,
  planFromToolInput,
  planSummary,
  planTitle,
  taskListFromToolInput,
  taskListProgressLabel,
} from "../toolInput";
import { isCardTool, trailRows, usedToolsLabel } from "../liveStep";
import type { ToolChip } from "../types";

describe("task lists", () => {
  it("reads a TodoWrite call into rows with their states", () => {
    const items = taskListFromToolInput("TodoWrite", {
      todos: [
        { content: "Read the test", status: "completed" },
        { content: "Fix it", activeForm: "Fixing it", status: "in_progress" },
        { content: "Ship", status: "pending" },
        { content: "Skip me", status: "cancelled" },
        { content: "   ", status: "pending" },
        { content: "Odd status", status: "weird" },
      ],
    });
    expect(items?.map((i) => [i.text, i.status])).toEqual([
      ["Read the test", "completed"],
      ["Fix it", "in_progress"],
      ["Ship", "pending"],
      ["Skip me", "cancelled"],
      ["Odd status", "pending"],
    ]);
    expect(isTaskListTool("todo_write")).toBe(true);
    expect(isTaskListTool("Bash")).toBe(false);
  });

  it("is null for another tool, or an input with no tasks", () => {
    expect(taskListFromToolInput("Bash", { todos: [{ content: "x" }] })).toBeNull();
    expect(taskListFromToolInput("TodoWrite", { todos: [] })).toBeNull();
    expect(taskListFromToolInput("TodoWrite", "nope")).toBeNull();
  });

  it("counts progress without the cancelled, and says Complete when all are done", () => {
    expect(taskListProgressLabel([{ text: "a", status: "completed" }, { text: "b", status: "pending" }, { text: "c", status: "cancelled" }])).toBe("1 of 2");
    expect(taskListProgressLabel([{ text: "a", status: "completed" }, { text: "c", status: "cancelled" }])).toBe("Complete");
  });
});

describe("diffs", () => {
  it("shows an edit's removed and added lines with the unchanged lines around them", () => {
    const diff = diffFromToolInput("Edit", { file_path: "/w/a.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\nthree" });
    expect(diff?.contentOnly).toBe(false);
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
    expect(diff?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "one"],
      ["remove", "two"],
      ["add", "2"],
      ["context", "three"],
    ]);
  });

  it("shows a write as content only, with nothing removed", () => {
    const diff = diffFromToolInput("Write", { file_path: "/w/new.txt", content: "a\nb" });
    expect(diff).toMatchObject({ contentOnly: true, added: 2, removed: 0 });
  });

  it("joins a MultiEdit's edits with a gap, and caps a long change", () => {
    const multi = diffFromToolInput("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] });
    expect(multi?.lines.map((l) => l.text)).toEqual(["a", "b", "⋯", "c", "d"]);
    const long = diffFromToolInput("Write", { file_path: "/w/big.txt", content: Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") });
    expect(long?.lines).toHaveLength(80);
    expect(long?.truncated).toBe(true);
  });

  it("is null when the input does not say what changed", () => {
    expect(diffFromToolInput("Edit", { file_path: "/w/a.ts" })).toBeNull();
    expect(diffFromToolInput("Edit", { old_string: "a", new_string: "b" })).toBeNull();
    expect(diffFromToolInput("Bash", { command: "ls" })).toBeNull();
  });

  it("names a file by its last path part", () => {
    expect(baseName("/work/src/parser.ts")).toBe("parser.ts");
    expect(baseName("C:\\work\\a.txt")).toBe("a.txt");
  });
});

describe("plans", () => {
  it("reads the plan of an ExitPlanMode call, and its title and summary", () => {
    const text = "# Move the parser\n\nSplit it in **two** files.\n\n- first step";
    expect(isPlanTool("ExitPlanMode")).toBe(true);
    expect(planFromToolInput("ExitPlanMode", { plan: text })).toBe(text);
    expect(planFromToolInput("ExitPlanMode", { plan: "  " })).toBeNull();
    expect(planFromToolInput("Bash", { plan: text })).toBeNull();
    expect(planTitle(text)).toBe("Move the parser");
    expect(planSummary(text)).toBe("Split it in two files. first step");
  });
});

describe("what the work trail counts", () => {
  const tool = (name: string, extra: Partial<ToolChip> = {}): ToolChip => ({ name, detail: "", status: "done", ...extra });

  it("keeps task lists, plans and reasoning out of the tool count", () => {
    const tools = [
      tool("TodoWrite", { input: { todos: [{ content: "x", status: "pending" }] } }),
      tool("ExitPlanMode"),
      tool("Thinking", { kind: "thinking" }),
      tool("Bash"),
      tool("Edit"),
    ];
    expect(isCardTool(tools[0])).toBe(true);
    expect(isCardTool(tools[3])).toBe(false);
    expect(usedToolsLabel(tools).used).toBe("Used 2 tools");
  });

  it("says Thinking when reasoning is all there is, and keeps reasoning rows in the trail", () => {
    const tools = [tool("Thinking", { kind: "thinking" })];
    expect(usedToolsLabel(tools).used).toBe("Thinking");
    expect(trailRows(tools)).toHaveLength(1);
    expect(trailRows([tool("TodoWrite"), tool("Bash")]).map((t) => t.name)).toEqual(["Bash"]);
  });
});
