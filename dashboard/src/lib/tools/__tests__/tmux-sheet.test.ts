import {
  TMUX_AGENT_SECTION,
  TMUX_BUILDER_DEFAULTS,
  TMUX_DIAGRAM,
  TMUX_FACTS,
  TMUX_HIERARCHY_ALT,
  TMUX_HIERARCHY_TEXT,
  TMUX_KEYS_NOTE,
  TMUX_SECTIONS,
  TMUX_SESSION_NAME_MAX,
  TMUX_SLEEP_NOTE,
  TMUX_TARGET_NOTE,
  buildTmuxCommands,
  cleanOtherCommand,
  cleanSessionName,
  shellSingleQuote,
  type TmuxBuilderInput,
} from "../tmux-sheet";
import { findBannedClaims } from "../copy-rules";
import { getToolEntry } from "../tool-catalog";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import fs from "fs";
import path from "path";

const builder = (overrides: Partial<TmuxBuilderInput> = {}): TmuxBuilderInput => ({ ...TMUX_BUILDER_DEFAULTS, ...overrides });

const allRows = [...TMUX_SECTIONS.flatMap((section) => section.rows), ...TMUX_AGENT_SECTION.rows];
const allText = [
  TMUX_KEYS_NOTE,
  TMUX_TARGET_NOTE,
  TMUX_SLEEP_NOTE,
  TMUX_HIERARCHY_ALT,
  TMUX_HIERARCHY_TEXT,
  ...TMUX_SECTIONS.flatMap((section) => [section.title, section.intro]),
  TMUX_AGENT_SECTION.title,
  TMUX_AGENT_SECTION.intro,
  ...allRows.flatMap((row) => [("keys" in row && row.keys) || "", ("command" in row && row.command) || "", row.does]),
].filter(Boolean);

describe("tmux cheat sheet data", () => {
  it("covers every topic the page promises", () => {
    expect(TMUX_SECTIONS.map((section) => section.id)).toEqual(["sessions", "windows", "panes", "detach-attach", "copy-mode", "logging"]);
    expect(TMUX_AGENT_SECTION.id).toBe("ai-agents");
  });

  it("gives every row a unique id and an explanation, and every command starts with tmux", () => {
    const ids = allRows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of allRows) {
      expect(row.does.trim().length).toBeGreaterThan(10);
      const command = "command" in row ? row.command : undefined;
      const keys = "keys" in row ? row.keys : undefined;
      expect(Boolean(command || keys)).toBe(true);
      if (command) expect(command).toMatch(/^tmux [a-z-]+/);
    }
  });

  it("states the default keys the tmux manual lists", () => {
    const byId = Object.fromEntries(allRows.map((row) => [row.id, row]));
    expect(byId["detach"]).toMatchObject({ keys: "Ctrl-b d", command: "tmux detach" });
    // % splits into left and right panes, " into top and bottom: the two are easy to swap.
    expect(byId["split-lr"]).toMatchObject({ keys: "Ctrl-b %", command: "tmux split-window -h" });
    expect(byId["split-lr"].does).toMatch(/left and right/);
    expect(byId["split-tb"]).toMatchObject({ keys: 'Ctrl-b "', command: "tmux split-window -v" });
    expect(byId["split-tb"].does).toMatch(/top and bottom/);
    expect(byId["enter-copy"]).toMatchObject({ keys: "Ctrl-b [" });
    expect(byId["paste"]).toMatchObject({ keys: "Ctrl-b ]" });
    expect(byId["zoom"]).toMatchObject({ keys: "Ctrl-b z" });
    expect(byId["rename"]).toMatchObject({ keys: "Ctrl-b $" });
    expect(byId["rename-window"]).toMatchObject({ keys: "Ctrl-b ," });
    expect(byId["new-or-attach"].command).toBe("tmux new -A -s NAME");
    expect(byId["take-over"].command).toBe("tmux attach -d -t NAME");
  });

  it("gives emacs and vi copy-mode keys as the manual does", () => {
    const text = TMUX_SECTIONS.find((section) => section.id === "copy-mode")!.rows.map((row) => `${row.keys ?? ""} ${row.does}`).join("\n");
    expect(text).toMatch(/Ctrl-Space, then Alt-w/);
    expect(text).toMatch(/Space, then Enter/);
    expect(TMUX_SECTIONS.find((section) => section.id === "copy-mode")!.intro).toMatch(/emacs keys by default, vi keys if your VISUAL or EDITOR contains vi/);
  });

  it("fully qualifies the target of every command that acts on a pane", () => {
    const paneCommands = allRows
      .map((row) => ("command" in row ? row.command : undefined))
      .filter((command): command is string => Boolean(command) && /^tmux (?:send-keys|pipe-pane|capture-pane)\b/.test(command as string));
    expect(paneCommands.length).toBeGreaterThanOrEqual(5);
    for (const command of paneCommands) expect(command).toMatch(/-t [A-Za-z]+:(?:\s|$)/);
  });

  it("explains logging honestly: from now on, raw output, secrets included, -o toggles, no command closes the pipe", () => {
    const logging = TMUX_SECTIONS.find((section) => section.id === "logging")!;
    expect(logging.intro).toMatch(/doesn't include earlier output/);
    expect(logging.intro).toMatch(/secrets included/);
    expect(logging.rows[0].does).toMatch(/running it again turns logging off/);
    expect(logging.rows[1].command).toBe("tmux pipe-pane -t NAME:");
    expect(logging.rows[1].does).toMatch(/With no command, pipe-pane closes the current pipe/);
  });

  it("says plainly that tmux survives disconnects and not a sleeping laptop", () => {
    expect(TMUX_SLEEP_NOTE).toMatch(/through disconnects/);
    expect(TMUX_SLEEP_NOTE).toMatch(/doesn't keep anything going through a sleeping laptop/);
  });

  it("makes no banned claim, never capitalises windows, and uses no em or en dash", () => {
    for (const text of allText) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      expect(text).not.toMatch(/\bWindows\b/);
    }
    expect(unqualifiedKeepRunningClaims(allText.join("\n"), /Hivra|managed|always-on/i)).toEqual([]);
    expect(unknownDashboardNames(allText.join("\n"))).toEqual([]);
  });

  it("carries the verified date and source the method section links", () => {
    expect(TMUX_FACTS.lastVerified).toBe("2026-09-30");
    const method = getToolEntry("tmux-cheat-sheet")!.method!;
    expect(method.lastVerified).toBe(TMUX_FACTS.lastVerified);
    const urls = method.paragraphs.flatMap((paragraph) => paragraph.sources ?? []).map((source) => source.url);
    expect(urls).toContain(TMUX_FACTS.sources.manual.url);
  });
});

describe("tmux diagram", () => {
  const file = path.join(__dirname, "..", "..", "..", "..", "public", TMUX_DIAGRAM.src);

  it("is a real SVG in public/ whose size matches the width and height the page sets", () => {
    const svg = fs.readFileSync(file, "utf8");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain(`viewBox="0 0 ${TMUX_DIAGRAM.width} ${TMUX_DIAGRAM.height}"`);
    expect(svg).toContain(`width="${TMUX_DIAGRAM.width}"`);
    expect(svg).toContain(`height="${TMUX_DIAGRAM.height}"`);
  });

  it("carries its own accessible title and description, and runs no script or external file", () => {
    const svg = fs.readFileSync(file, "utf8");
    expect(svg).toMatch(/<title id="t">[^<]+<\/title>/);
    expect(svg).toMatch(/<desc id="d">[^<]{60,}<\/desc>/);
    expect(svg).not.toMatch(/<script|href="http|xlink:href|url\(http|@import/);
    expect(svg).not.toMatch(/[–—]/);
  });

  it("has alt text that names the hierarchy and the client", () => {
    expect(TMUX_HIERARCHY_ALT).toMatch(/server holds sessions/);
    expect(TMUX_HIERARCHY_ALT).toMatch(/window is split into panes/);
    expect(TMUX_HIERARCHY_ALT).toMatch(/client that attaches to a session and can detach/);
    expect(TMUX_HIERARCHY_ALT.length).toBeGreaterThan(100);
  });
});

describe("tmux command builder", () => {
  it("prints the default commands for Claude Code, with the session named after the agent", () => {
    const result = buildTmuxCommands(builder());
    expect(result.sessionName).toBe("claude");
    expect(result.lines.filter((line) => !line.startsWith("#"))).toEqual([
      "tmux new -d -s claude",
      "tmux send-keys -t claude: 'claude' Enter",
      "tmux attach -t claude",
    ]);
  });

  it("starts logging before the agent, so the file holds the whole run", () => {
    const result = buildTmuxCommands(builder({ agent: "codex", logging: true }));
    const commands = result.lines.filter((line) => !line.startsWith("#"));
    expect(commands).toEqual([
      "tmux new -d -s codex",
      "tmux pipe-pane -o -t codex: 'cat >> ~/codex.log'",
      "tmux send-keys -t codex: 'codex' Enter",
      "tmux attach -t codex",
    ]);
    expect(result.later.map((item) => item.command)).toContain("tmux pipe-pane -t codex:");
  });

  it("only offers a stop-logging command when logging is on", () => {
    expect(buildTmuxCommands(builder()).later.map((item) => item.command)).not.toContain("tmux pipe-pane -t claude:");
  });

  it("lists how to come back, peek and stop", () => {
    const later = buildTmuxCommands(builder({ sessionName: "work_1" })).later.map((item) => item.command);
    expect(later).toEqual(["tmux attach -d -t work_1", "tmux capture-pane -p -S -40 -t work_1:", "tmux kill-session -t work_1"]);
  });

  it("keeps only letters, digits, dash and underscore in the session name, and caps its length", () => {
    expect(cleanSessionName("my project; rm -rf /", "claude")).toBe("myprojectrm-rf");
    expect(cleanSessionName("a.b:c", "claude")).toBe("abc");
    expect(cleanSessionName("", "claude")).toBe("claude");
    expect(cleanSessionName("$()`", "claude")).toBe("claude");
    expect(cleanSessionName("x".repeat(100), "claude")).toHaveLength(TMUX_SESSION_NAME_MAX);
    const hostile = buildTmuxCommands(builder({ sessionName: "a b;c$(d)" }));
    expect(hostile.script).not.toMatch(/[;$()]/);
  });

  it("quotes another agent's command for the shell, single quotes included", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
    const result = buildTmuxCommands(builder({ agent: "other", otherCommand: "my-agent --flag 'x'", sessionName: "mine" }));
    expect(result.command).toBe("my-agent --flag 'x'");
    expect(result.lines).toContain("tmux send-keys -t mine: 'my-agent --flag '\\''x'\\''' Enter");
    expect(buildTmuxCommands(builder({ agent: "other" })).command).toBe("your-agent");
    expect(buildTmuxCommands(builder({ agent: "other" })).sessionName).toBe("agent");
    expect(cleanOtherCommand("a\nb")).toBe("a b");
  });

  it("makes no banned claim in any generated text", () => {
    for (const agent of ["claude", "codex", "other"] as const) {
      for (const logging of [false, true]) {
        const result = buildTmuxCommands(builder({ agent, logging, otherCommand: "my-agent" }));
        const text = [result.script, ...result.later.flatMap((item) => [item.label, item.command])].join("\n");
        expect(findBannedClaims(text)).toEqual([]);
      }
    }
  });
});

describe("tmux catalog examples", () => {
  it("print exactly what the builder prints for the inputs they state", () => {
    const byTitle = Object.fromEntries(getToolEntry("tmux-cheat-sheet")!.examples!.map((example) => [example.title, example.command]));
    expect(byTitle["Claude Code in a named session"]).toBe(buildTmuxCommands(builder()).script);
    expect(byTitle["A logged Codex run"]).toBe(buildTmuxCommands(builder({ agent: "codex", logging: true })).script);
    expect(byTitle["Picking a session up from another device"]).toBe("tmux attach -d -t claude");
    expect(byTitle["Picking a session up from another device"]).toBe(buildTmuxCommands(builder()).later[0].command);
  });
});
