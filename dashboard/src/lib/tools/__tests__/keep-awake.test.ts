import {
  KEEP_AWAKE_COMMAND_MAX,
  KEEP_AWAKE_DEFAULTS,
  KEEP_AWAKE_DURATIONS,
  KEEP_AWAKE_FACTS,
  KEEP_AWAKE_LID,
  KEEP_AWAKE_OS,
  KEEP_AWAKE_POWER,
  buildKeepAwake,
  cleanCommand,
  clampHours,
  hoursToSeconds,
  type KeepAwakeInput,
} from "../keep-awake";
import { findBannedClaims } from "../copy-rules";
import { keepAwakeCta } from "../keep-awake-cta";
import { getToolEntry } from "../tool-catalog";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";

const input = (overrides: Partial<KeepAwakeInput> = {}): KeepAwakeInput => ({ ...KEEP_AWAKE_DEFAULTS, ...overrides });

describe("keep-awake builder: macOS", () => {
  it("wraps the command with -is when plugged in (idle sleep and system sleep)", () => {
    const result = buildKeepAwake(input());
    expect(result.headline).toBe("caffeinate -is claude");
    expect(result.script).toBe("caffeinate -is claude");
    expect(result.verdict.level).toBe("works");
  });

  it("leaves -s out on battery, because the manual says it is valid only on AC power", () => {
    const result = buildKeepAwake(input({ power: "battery" }));
    expect(result.headline).toBe("caffeinate -i claude");
    expect(result.explain.join(" ")).toMatch(/-s is left out because it only applies on AC power/);
    expect(result.verdict.level).toBe("works");
    expect(result.verdict.title).toMatch(/drains the battery/);
  });

  it("uses a separate timed caffeinate for N hours, because -t is not used when caffeinate wraps a command", () => {
    const result = buildKeepAwake(input({ duration: "hours", hours: 8 }));
    expect(result.headline).toBe("caffeinate -is -t 28800");
    const commandLines = result.lines.filter((line) => !line.startsWith("#"));
    expect(commandLines).toEqual(["caffeinate -is -t 28800", "claude"]);
    // The command is never given -t together with a wrapped utility.
    expect(result.script).not.toMatch(/caffeinate[^\n]*-t \d+ claude/);
    expect(result.explain.join(" ")).toMatch(/ignores -t when it wraps a command/);
    expect(result.notCovered.join("\n")).toMatch(/Anything after 8 hours/);
  });

  it("converts hours to whole seconds and clamps the range", () => {
    expect(hoursToSeconds(1)).toBe(3600);
    expect(hoursToSeconds(72)).toBe(259200);
    expect(clampHours(0)).toBe(1);
    expect(clampHours(500)).toBe(72);
    expect(clampHours(Number.NaN)).toBe(KEEP_AWAKE_DEFAULTS.hours);
    expect(clampHours(2.6)).toBe(3);
    expect(buildKeepAwake(input({ duration: "hours", hours: 9999 })).headline).toBe("caffeinate -is -t 259200");
  });

  it("does not promise a closed lid: plugged in is a caveat, on battery is not a documented setup", () => {
    const plugged = buildKeepAwake(input({ lid: "closed" }));
    expect(plugged.verdict.level).toBe("caveat");
    expect(plugged.verdict.title).toMatch(/won't cover a closed lid/);
    expect(plugged.verdict.detail).toMatch(/external display, power connected and an external keyboard and mouse or trackpad/);

    const battery = buildKeepAwake(input({ lid: "closed", power: "battery" }));
    expect(battery.verdict.level).toBe("wont");
    expect(battery.verdict.detail).toMatch(/needs power connected/);
  });

  it("checks with pmset -g assertions and only offers pmset as a persistent, non-lid option", () => {
    const plugged = buildKeepAwake(input());
    expect(plugged.verify.command).toBe("pmset -g assertions");
    expect(plugged.verify.hint).toMatch(/caffeinate command-line tool/);
    expect(plugged.pmset?.lines).toEqual(["pmset -g custom", "sudo pmset -c sleep 0"]);
    expect(plugged.pmset?.note).toMatch(/sleep timer of 0 doesn't stop a closed lid from sleeping the Mac/);

    const battery = buildKeepAwake(input({ power: "battery" }));
    expect(battery.pmset?.lines).toEqual(["pmset -g custom", "sudo pmset -b sleep 0"]);
  });

  it("always lists what it will not cover: the lid, power, reboots, network, closing the terminal, crashes", () => {
    const list = buildKeepAwake(input()).notCovered.join("\n");
    for (const item of [/A closed lid/, /Unplugging/, /reboot or an OS update/, /network change or drop/, /Closing the terminal window/, /crashing or hitting a usage limit/]) {
      expect(list).toMatch(item);
    }
    expect(buildKeepAwake(input({ power: "battery" })).notCovered.join("\n")).toMatch(/A flat battery/);
  });
});

describe("keep-awake builder: Linux", () => {
  it("wraps the command in systemd-inhibit --what=sleep when the lid stays open", () => {
    const result = buildKeepAwake(input({ os: "linux" }));
    expect(result.headline).toBe('systemd-inhibit --what=sleep --why="agent run" claude');
    expect(result.verify.command).toBe("systemd-inhibit --list");
    expect(result.pmset).toBeNull();
    expect(result.verdict.level).toBe("works");
  });

  it("adds handle-lid-switch only when the lid will be closed", () => {
    const closed = buildKeepAwake(input({ os: "linux", lid: "closed" }));
    expect(closed.headline).toBe('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" claude');
    expect(closed.verdict.title).toMatch(/lid-close action/);
    expect(closed.notCovered.join("\n")).toMatch(/desktop that handles the lid itself/);
  });

  it("holds the lock for N hours with sleep <seconds> in its own tab", () => {
    const result = buildKeepAwake(input({ os: "linux", duration: "hours", hours: 12, lid: "closed" }));
    expect(result.headline).toBe('systemd-inhibit --what=sleep:handle-lid-switch --why="agent run" sleep 43200');
    expect(result.lines.filter((line) => !line.startsWith("#"))).toEqual([result.headline, "claude"]);
  });

  it("does not claim to check the power source, and says systemd is required", () => {
    const battery = buildKeepAwake(input({ os: "linux", power: "battery" })).notCovered.join("\n");
    expect(battery).toMatch(/Nothing here checks the power source/);
    expect(battery).toMatch(/Machines without systemd/);
    expect(buildKeepAwake(input({ os: "linux" })).notCovered.join("\n")).toMatch(/doesn't look at the power source/);
  });
});

describe("keep-awake builder: the command", () => {
  it("keeps a typed command, strips control characters and caps the length", () => {
    expect(cleanCommand("  codex   --resume  ")).toBe("codex --resume");
    expect(cleanCommand("claude\nrm -rf /")).toBe("claude rm -rf /");
    expect(cleanCommand("")).toBe("claude");
    expect(cleanCommand("   ")).toBe("claude");
    expect(cleanCommand("x".repeat(500))).toHaveLength(KEEP_AWAKE_COMMAND_MAX);
    expect(buildKeepAwake(input({ command: "npm test" })).headline).toBe("caffeinate -is npm test");
    expect(buildKeepAwake(input({ command: "" })).headline).toBe("caffeinate -is claude");
  });

  it("puts the same command, check and limits into the prompt for an agent", () => {
    const wrapped = buildKeepAwake(input({ command: "codex" }));
    expect(wrapped.agentPrompt).toContain("caffeinate -is codex");
    expect(wrapped.agentPrompt).toContain("don't change any other power or sleep setting");
    expect(wrapped.agentPrompt).toContain("pmset -g assertions");
    expect(wrapped.agentPrompt).toContain("- A closed lid.");
    expect(wrapped.agentPrompt).toContain("Tell me what this doesn't cover");

    const timed = buildKeepAwake(input({ duration: "hours", hours: 6 }));
    expect(timed.agentPrompt).toContain("caffeinate -is -t 21600");
    // Comment lines are for people; the agent gets the commands and the instruction.
    expect(timed.agentPrompt).not.toContain("# In one terminal tab");
    expect(timed.agentPrompt).toMatch(/Run the first command in the background/);
  });
});

describe("keep-awake builder: every input combination", () => {
  const combos: KeepAwakeInput[] = [];
  for (const os of KEEP_AWAKE_OS)
    for (const duration of KEEP_AWAKE_DURATIONS)
      for (const power of KEEP_AWAKE_POWER)
        for (const lid of KEEP_AWAKE_LID) combos.push(input({ os, duration, power, lid, hours: 5 }));

  it.each(combos)("os=$os duration=$duration power=$power lid=$lid: text is honest and within the copy rules", (combo) => {
    const result = buildKeepAwake(combo);
    const everything = [
      result.script,
      result.headline,
      ...result.explain,
      result.verdict.title,
      result.verdict.detail,
      result.verify.command,
      result.verify.hint,
      ...(result.pmset ? [...result.pmset.lines, result.pmset.note] : []),
      ...result.notCovered,
      result.agentPrompt,
    ].join("\n");
    expect(findBannedClaims(everything)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(everything, /Hivra|managed|always-on/i)).toEqual([]);
    expect(unknownDashboardNames(everything)).toEqual([]);
    expect(everything).not.toMatch(/\bWindows\b/);
    // Only the OS's own tool appears.
    if (combo.os === "macos") expect(everything).not.toMatch(/systemd-inhibit/);
    else expect(everything).not.toMatch(/caffeinate|pmset/);
    // Never the closed-lid promise.
    expect(everything).not.toMatch(/keeps? (?:the Mac|it) awake with the lid closed/i);
  });

  it.each(combos)("os=$os duration=$duration power=$power lid=$lid: CTA follows the result", (combo) => {
    const result = buildKeepAwake(combo);
    const cta = keepAwakeCta(result);
    const enough = combo.power === "plugged" && result.verdict.level === "works";
    expect(cta.state).toBe(enough ? "enough" : "stays-on");
    expect(cta.button === null).toBe(enough);
    expect(cta.survivalCheck.href).toBe("/tools/agent-survival-check");
    expect(findBannedClaims(cta.text)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(cta.text, /Hivra/i)).toEqual([]);
  });
});

describe("keep-awake CTA", () => {
  it("says so when a plugged-in laptop with the command is enough, with no product push", () => {
    const cta = keepAwakeCta(buildKeepAwake(input()));
    expect(cta.state).toBe("enough");
    expect(cta.text).toMatch(/is enough/);
    expect(cta.text).not.toMatch(/Hivra|\$9\.99/);
    expect(cta.button).toBeNull();
  });

  it("offers a computer that stays on when the laptop would have to stay open and plugged in", () => {
    const cta = keepAwakeCta(buildKeepAwake(input({ lid: "closed" })));
    expect(cta.state).toBe("stays-on");
    expect(cta.text).toMatch(/If the laptop has to stay open and plugged in, run the agent on a computer that stays on instead\./);
    expect(cta.text).toMatch(/inside tmux in a Hivra computer's Terminal tab, or send it from Telegram/);
    expect(cta.text).toMatch(/\$9\.99 a month for 2 vCPU and 4 GB of RAM/);
    expect(cta.text).toMatch(/not paused for inactivity/);
    expect(cta.button).toEqual({ label: "Run Claude Code on Hivra", href: "/sign-up?agentType=claude-code" });
  });

  it("names the right agent and never promises Telegram for Codex", () => {
    const codex = keepAwakeCta(buildKeepAwake(input({ lid: "closed", command: "codex" })));
    expect(codex.button).toEqual({ label: "Run Codex on Hivra", href: "/sign-up?agentType=codex" });
    expect(codex.text).toMatch(/inside tmux in a Hivra computer's Terminal tab, and it keeps going/);
    expect(codex.text).not.toMatch(/Telegram/);

    const other = keepAwakeCta(buildKeepAwake(input({ lid: "closed", command: "npm test" })));
    expect(other.button).toEqual({ label: "Get started on Hivra", href: "/sign-up" });
    expect(other.text).toMatch(/Claude Code and Codex on a computer of their own/);
    expect(other.text).not.toMatch(/Telegram/);
  });

  it("uses the agent named by the first word, path and case ignored", () => {
    expect(keepAwakeCta(buildKeepAwake(input({ lid: "closed", command: "/usr/local/bin/Claude --resume" }))).agent).toBe("claude");
    expect(keepAwakeCta(buildKeepAwake(input({ lid: "closed", command: "codex exec 'fix it'" }))).agent).toBe("codex");
    expect(keepAwakeCta(buildKeepAwake(input({ lid: "closed", command: "claudette" }))).agent).toBe("other");
  });
});

describe("keep-awake catalog examples", () => {
  it("print exactly what the builder prints for the inputs they state", () => {
    const examples = getToolEntry("keep-mac-awake")!.examples!;
    const byTitle = Object.fromEntries(examples.map((example) => [example.title, example.command]));
    expect(byTitle["Claude Code on a plugged-in MacBook, lid open"]).toBe(buildKeepAwake(input()).headline);
    expect(byTitle["An 8 hour Codex run on battery"]).toBe(
      buildKeepAwake(input({ duration: "hours", hours: 8, power: "battery", command: "codex" })).headline,
    );
    expect(byTitle["A Linux laptop with the lid closed"]).toBe(buildKeepAwake(input({ os: "linux", lid: "closed" })).headline);
    expect(Object.keys(byTitle)).toHaveLength(3);
  });

  it("carries the verified date and the sources the method section links", () => {
    const entry = getToolEntry("keep-mac-awake")!;
    expect(entry.method!.lastVerified).toBe(KEEP_AWAKE_FACTS.lastVerified);
    expect(KEEP_AWAKE_FACTS.lastVerified).toBe("2026-09-30");
    const urls = entry.method!.paragraphs.flatMap((paragraph) => paragraph.sources ?? []).map((source) => source.url);
    for (const source of Object.values(KEEP_AWAKE_FACTS.sources)) expect(urls).toContain(source.url);
  });
});
