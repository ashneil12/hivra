/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import TmuxCheatSheetTool from "../TmuxCheatSheetTool";
import { TMUX_AGENT_SECTION, TMUX_DIAGRAM, TMUX_HIERARCHY_ALT, TMUX_SECTIONS, TMUX_SLEEP_NOTE } from "@/lib/tools/tmux-sheet";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("next/image", () => {
  const MockImage = ({ src, alt, width, height, className }: { src: string; alt: string; width: number; height: number; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image in jsdom
    <img src={src} alt={alt} width={width} height={height} className={className} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

const BASE = "/tools/tmux-cheat-sheet";
const setAddress = (search = "") => window.history.replaceState(null, "", `${BASE}${search}`);
const script = () => screen.getByTestId("tmux-script").textContent ?? "";
const commandsOnly = () => script().split("\n").filter((line) => !line.startsWith("#"));

let writeText: jest.Mock;

beforeEach(() => {
  setAddress();
  writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => setAddress());

describe("TmuxCheatSheetTool sheet", () => {
  it("renders every section with its rows, keys and commands, without any interaction", () => {
    const { container } = render(<TmuxCheatSheetTool />);
    for (const section of TMUX_SECTIONS) {
      const region = container.querySelector(`#${section.id}`) as HTMLElement;
      expect(region).not.toBeNull();
      expect(within(region).getByRole("heading", { level: 2, name: section.title })).toBeInTheDocument();
      expect(within(region).getAllByRole("listitem")).toHaveLength(section.rows.length);
    }
    expect(screen.getByRole("heading", { level: 2, name: "tmux for AI coding agents" })).toBeInTheDocument();
    expect(container).toHaveTextContent("Ctrl-b d");
    expect(container).toHaveTextContent("tmux new -A -s NAME");
    expect(container).toHaveTextContent("tmux pipe-pane -o -t NAME: 'cat >> ~/NAME.log'");
    expect(container.querySelectorAll("h1")).toHaveLength(0);
  });

  it("covers the agent pattern: one named session per agent, re-attach from another device, keep a log", () => {
    render(<TmuxCheatSheetTool />);
    const agents = document.getElementById("ai-agents") as HTMLElement;
    const text = agents.textContent ?? "";
    expect(text).toContain("One named session per agent");
    expect(text).toContain("tmux attach -d -t claude");
    expect(text).toContain("Pick it up from another device");
    expect(text).toContain("tmux pipe-pane -o -t claude: 'cat >> ~/claude.log'");
    expect(text).toContain("Keep a log of everything the agent prints");
    expect(within(agents).getAllByRole("listitem")).toHaveLength(TMUX_AGENT_SECTION.rows.length);
  });

  it("says plainly that tmux keeps a session alive through disconnects, not a sleeping laptop", () => {
    render(<TmuxCheatSheetTool />);
    expect(screen.getByText(TMUX_SLEEP_NOTE)).toHaveTextContent(
      "It doesn't keep anything going through a sleeping laptop, because the whole machine suspends, tmux included.",
    );
    expect(screen.getByRole("link", { name: "keep-awake command builder" })).toHaveAttribute("href", "/tools/keep-mac-awake");
    expect(screen.getByRole("link", { name: "agent survival check" })).toHaveAttribute("href", "/tools/agent-survival-check");
  });

  it("gives every command its own copy button, and copies that command", async () => {
    render(<TmuxCheatSheetTool />);
    const button = screen.getByRole("button", { name: "Copy: tmux new -A -s NAME" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenLastCalledWith("tmux new -A -s NAME");
    expect(button).toHaveTextContent("Copied");

    // Rows that are keys only have no copy button.
    const windows = document.getElementById("windows") as HTMLElement;
    const rows = within(windows).getAllByRole("listitem");
    const keyOnly = rows.find((row) => row.textContent?.includes("Ctrl-b n"))!;
    expect(within(keyOnly).queryByRole("button")).not.toBeInTheDocument();
    const withCommand = rows.find((row) => row.textContent?.includes("tmux new-window -n NAME"))!;
    expect(within(withCommand).getByRole("button")).toBeInTheDocument();
  });

  it("jumps to every section from the sheet's own navigation", () => {
    render(<TmuxCheatSheetTool />);
    const nav = screen.getByRole("navigation", { name: "Sections of the cheat sheet" });
    const hrefs = within(nav).getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["#parts", "#sessions", "#windows", "#panes", "#detach-attach", "#copy-mode", "#logging", "#ai-agents", "#builder"]);
    for (const href of hrefs) expect(document.querySelector(href!)).not.toBeNull();
  });

  it("shows the original diagram with real alt text and its width and height, and links the file to print", () => {
    render(<TmuxCheatSheetTool />);
    const image = screen.getByRole("img", { name: TMUX_HIERARCHY_ALT });
    expect(image).toHaveAttribute("src", "/images/tools/tmux-session-hierarchy.svg");
    expect(image).toHaveAttribute("width", String(TMUX_DIAGRAM.width));
    expect(image).toHaveAttribute("height", String(TMUX_DIAGRAM.height));
    expect(screen.getByRole("link", { name: "Open the diagram on its own" })).toHaveAttribute("href", TMUX_DIAGRAM.src);
    // The hierarchy is also in words, so it does not depend on the image.
    expect(screen.getByText(/The tmux server holds sessions\. A session holds windows\. A window holds panes\./)).toBeInTheDocument();
  });

  it("never capitalises windows and makes no banned claim", () => {
    const { container } = render(<TmuxCheatSheetTool />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\bWindows\b/);
    expect(findBannedClaims(text)).toEqual([]);
    const blocks = [...container.querySelectorAll("p, li, h2, h3, pre")].map((el) => el.textContent ?? "").join("\n");
    expect(unqualifiedKeepRunningClaims(blocks, /Hivra|managed|always-on/i)).toEqual([]);
    expect(unknownDashboardNames(blocks)).toEqual([]);
    expect(text).toContain("last verified 2026-09-30");
  });
});

describe("TmuxCheatSheetTool builder", () => {
  it("prints the default commands for Claude Code, with the agent's sign-up link", () => {
    render(<TmuxCheatSheetTool />);
    expect(commandsOnly()).toEqual(["tmux new -d -s claude", "tmux send-keys -t claude: 'claude' Enter", "tmux attach -t claude"]);
    const cta = screen.getByTestId("tmux-cta");
    expect(cta).toHaveAttribute("data-agent", "claude");
    expect(within(cta).getByRole("link", { name: "Run Claude Code on Hivra" })).toHaveAttribute("href", "/sign-up?agentType=claude-code");
    expect(cta).toHaveTextContent("tmux keeps a session alive through disconnects, not through sleep.");
    expect(cta).toHaveTextContent("Start it inside tmux in a Hivra computer's Terminal tab, or send it from Telegram");
    expect(cta).toHaveTextContent("Plans start at $9.99 a month for 2 vCPU and 4 GB of RAM");
  });

  it("switches the CTA per agent, with no Telegram promise for Codex", () => {
    render(<TmuxCheatSheetTool />);
    fireEvent.click(screen.getByLabelText("Codex"));
    expect(commandsOnly()[1]).toBe("tmux send-keys -t codex: 'codex' Enter");
    const cta = screen.getByTestId("tmux-cta");
    expect(cta).toHaveAttribute("data-agent", "codex");
    expect(within(cta).getByRole("link", { name: "Run Codex on Hivra" })).toHaveAttribute("href", "/sign-up?agentType=codex");
    expect(cta).not.toHaveTextContent(/Telegram/);

    fireEvent.click(screen.getByLabelText("Another command-line agent"));
    const command = screen.getByLabelText("Command to run");
    fireEvent.change(command, { target: { value: "my-agent --fast" } });
    expect(commandsOnly()[1]).toBe("tmux send-keys -t agent: 'my-agent --fast' Enter");
    expect(within(screen.getByTestId("tmux-cta")).getByRole("link", { name: "Get started on Hivra" })).toHaveAttribute("href", "/sign-up");
    // An "other" command that is really Claude Code gets the Claude Code button.
    fireEvent.change(command, { target: { value: "claude --resume" } });
    expect(within(screen.getByTestId("tmux-cta")).getByRole("link", { name: "Run Claude Code on Hivra" })).toBeInTheDocument();
  });

  it("names and sanitises the session, and logs before the agent starts when logging is on", () => {
    render(<TmuxCheatSheetTool />);
    const name = screen.getByLabelText("Session name");
    fireEvent.change(name, { target: { value: "refactor 2; rm -rf /" } });
    expect(commandsOnly()[0]).toBe("tmux new -d -s refactor2rm-rf");

    fireEvent.click(screen.getByLabelText(/Append everything the pane prints to ~\/refactor2rm-rf\.log/));
    expect(commandsOnly()).toEqual([
      "tmux new -d -s refactor2rm-rf",
      "tmux pipe-pane -o -t refactor2rm-rf: 'cat >> ~/refactor2rm-rf.log'",
      "tmux send-keys -t refactor2rm-rf: 'claude' Enter",
      "tmux attach -t refactor2rm-rf",
    ]);
    expect(
      screen.getByText((_, element) => element?.tagName === "CODE" && element.textContent === "tmux pipe-pane -t refactor2rm-rf:"),
    ).toBeInTheDocument();

    // An empty name falls back to the agent's.
    fireEvent.change(name, { target: { value: "" } });
    expect(commandsOnly()[0]).toBe("tmux new -d -s claude");
  });

  it("copies the whole script, and each later command", async () => {
    render(<TmuxCheatSheetTool />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy commands" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(script());
    // The peek command is in the agent section and in the builder's follow-ups.
    const peek = screen.getAllByRole("button", { name: "Copy: tmux capture-pane -p -S -40 -t claude:" });
    expect(peek).toHaveLength(2);
    await act(async () => {
      fireEvent.click(peek[1]);
    });
    expect(writeText).toHaveBeenLastCalledWith("tmux capture-pane -p -S -40 -t claude:");
  });
});

describe("TmuxCheatSheetTool builder URL parameters", () => {
  it("restores the agent and the logging choice from a link", () => {
    setAddress("?agent=codex&log=on");
    render(<TmuxCheatSheetTool />);
    expect(screen.getByLabelText("Codex")).toBeChecked();
    expect(commandsOnly()).toEqual([
      "tmux new -d -s codex",
      "tmux pipe-pane -o -t codex: 'cat >> ~/codex.log'",
      "tmux send-keys -t codex: 'codex' Enter",
      "tmux attach -t codex",
    ]);
    expect(window.location.search).toBe("?agent=codex&log=on");
  });

  it("writes the choices back, clears them at the defaults, and never writes a name or a typed command", () => {
    render(<TmuxCheatSheetTool />);
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByLabelText("Codex"));
    expect(window.location.search).toBe("?agent=codex");
    fireEvent.click(screen.getByLabelText(/Append everything the pane prints/));
    expect(window.location.search).toBe("?agent=codex&log=on");

    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "ashs-private-project" } });
    expect(window.location.search).toBe("?agent=codex&log=on");

    fireEvent.click(screen.getByLabelText("Another command-line agent"));
    fireEvent.change(screen.getByLabelText("Command to run"), { target: { value: "my-agent" } });
    expect(window.location.search).not.toMatch(/my-agent|ashs/);

    fireEvent.click(screen.getByLabelText("Claude Code"));
    fireEvent.click(screen.getByLabelText(/Append everything the pane prints/));
    expect(window.location.search).toBe("");
  });

  it("keeps the query keys it does not own, and ignores nonsense", () => {
    setAddress("?utm_source=x&agent=other&log=maybe");
    render(<TmuxCheatSheetTool />);
    expect(screen.getByLabelText("Claude Code")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Codex"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("utm_source")).toBe("x");
    expect(params.get("agent")).toBe("codex");
    expect(params.get("log")).toBeNull();
  });
});
