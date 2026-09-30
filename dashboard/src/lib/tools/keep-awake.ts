// Keep-awake command builder logic (/tools/keep-mac-awake). Pure, so the
// component, the URL parameters and the tests all read the same rules.
//
// Facts in here were checked on 2026-09-30 against:
// - the macOS caffeinate(8) manual: -i stops idle sleep, -s stops system sleep
//   and is valid only on AC power, -t is a timeout in seconds and is not used
//   when caffeinate wraps a utility, -w waits for a pid. The manual makes no
//   promise about a closed lid, so the page does not either.
// - the macOS pmset(1) manual: -g assertions lists the assertions caffeinate
//   takes, -g custom lists per-power-source settings, and `sleep 0` turns the
//   system sleep timer off. It is a persistent setting, not a closed-lid fix.
// - Apple Support: using a MacBook with the lid closed needs an external
//   display, power connected and an external keyboard and mouse or trackpad.
// - the systemd-inhibit(1) manual: --what takes colon-separated values, among
//   them sleep and handle-lid-switch; --why is a free-text reason; --list shows
//   the locks; the lock is held while the command runs.
// Update lastVerified only when those pages are re-read.

export const KEEP_AWAKE_FACTS = {
  lastVerified: "2026-09-30",
  sources: {
    caffeinate: {
      label: "caffeinate(8) manual",
      url: "https://keith.github.io/xcode-man-pages/caffeinate.8.html",
    },
    pmset: {
      label: "pmset(1) manual",
      url: "https://keith.github.io/xcode-man-pages/pmset.1.html",
    },
    appleLidClosed: {
      label: "Apple Support: using a MacBook with the lid closed and external displays",
      url: "https://support.apple.com/en-in/117373",
    },
    appleDisplayGuide: {
      label: "MacBook Pro User Guide: connect an external display",
      url: "https://support.apple.com/guide/macbook-pro/connect-an-external-display-apd8cdd74f57/mac",
    },
    systemdInhibit: {
      label: "systemd-inhibit(1) manual",
      url: "https://man7.org/linux/man-pages/man1/systemd-inhibit.1.html",
    },
    logindConf: {
      label: "logind.conf(5) manual",
      url: "https://man7.org/linux/man-pages/man5/logind.conf.5.html",
    },
  },
} as const;

export type KeepAwakeOs = "macos" | "linux";
export type KeepAwakeDuration = "until-exit" | "hours";
export type KeepAwakePower = "plugged" | "battery";
export type KeepAwakeLid = "open" | "closed";

export interface KeepAwakeInput {
  os: KeepAwakeOs;
  duration: KeepAwakeDuration;
  /** Whole hours, used when duration is "hours". */
  hours: number;
  power: KeepAwakePower;
  lid: KeepAwakeLid;
  /** The command to keep awake, as typed. Sanitised by cleanCommand. */
  command: string;
}

export const KEEP_AWAKE_OS = ["macos", "linux"] as const;
export const KEEP_AWAKE_DURATIONS = ["until-exit", "hours"] as const;
export const KEEP_AWAKE_POWER = ["plugged", "battery"] as const;
export const KEEP_AWAKE_LID = ["open", "closed"] as const;

/** Commands a shared link may carry. Anything else stays in the visitor's own browser. */
export const KEEP_AWAKE_PRESET_COMMANDS = ["claude", "codex"] as const;

export const KEEP_AWAKE_HOURS = { min: 1, max: 72 } as const;
export const KEEP_AWAKE_COMMAND_MAX = 120;

export const KEEP_AWAKE_DEFAULTS: KeepAwakeInput = {
  os: "macos",
  duration: "until-exit",
  hours: 8,
  power: "plugged",
  lid: "open",
  command: "claude",
};

/** One line, no control characters, at most KEEP_AWAKE_COMMAND_MAX characters; empty falls back to the default. */
export function cleanCommand(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEEP_AWAKE_COMMAND_MAX)
    .trim();
  return cleaned === "" ? KEEP_AWAKE_DEFAULTS.command : cleaned;
}

export function clampHours(value: number): number {
  if (!Number.isFinite(value)) return KEEP_AWAKE_DEFAULTS.hours;
  return Math.min(KEEP_AWAKE_HOURS.max, Math.max(KEEP_AWAKE_HOURS.min, Math.round(value)));
}

export function hoursToSeconds(hours: number): number {
  return clampHours(hours) * 3600;
}

export function normalizeKeepAwake(input: KeepAwakeInput): KeepAwakeInput {
  return { ...input, hours: clampHours(input.hours), command: cleanCommand(input.command) };
}

export type KeepAwakeVerdictLevel = "works" | "caveat" | "wont";

export interface KeepAwakeResult {
  input: KeepAwakeInput;
  /** The shell lines to paste, comments included. */
  lines: string[];
  /** The lines joined with newlines. */
  script: string;
  /** The one command a person types, without comments. */
  headline: string;
  /** What each part of the command does, in plain words. */
  explain: string[];
  verdict: { level: KeepAwakeVerdictLevel; title: string; detail: string };
  /** How to check the keep-awake is active. */
  verify: { command: string; hint: string };
  /** macOS only: what pmset can and cannot do here. */
  pmset: { lines: string[]; note: string } | null;
  /** What this command will not cover, for this exact setup. */
  notCovered: string[];
  /** The result as a prompt for Claude Code or Codex. */
  agentPrompt: string;
}

const WHY = "agent run";

function macosFlags(power: KeepAwakePower): string {
  // -s is valid only on AC power (caffeinate(8)), so it is left out on battery.
  return power === "plugged" ? "-is" : "-i";
}

function linuxWhat(lid: KeepAwakeLid): string {
  return lid === "closed" ? "sleep:handle-lid-switch" : "sleep";
}

function buildLines(input: KeepAwakeInput): { lines: string[]; headline: string } {
  const seconds = hoursToSeconds(input.hours);
  if (input.os === "macos") {
    const flags = macosFlags(input.power);
    if (input.duration === "until-exit") {
      const headline = `caffeinate ${flags} ${input.command}`;
      return { lines: [headline], headline };
    }
    const timed = `caffeinate ${flags} -t ${seconds}`;
    return {
      lines: [
        `# In one terminal tab: hold the Mac awake for ${input.hours}h. Leave it running.`,
        timed,
        "# In another tab: start the agent as usual.",
        input.command,
      ],
      headline: timed,
    };
  }
  const base = `systemd-inhibit --what=${linuxWhat(input.lid)} --why="${WHY}"`;
  if (input.duration === "until-exit") {
    const headline = `${base} ${input.command}`;
    return { lines: [headline], headline };
  }
  const timed = `${base} sleep ${seconds}`;
  return {
    lines: [
      `# In one terminal tab: hold the laptop awake for ${input.hours}h. Leave it running.`,
      timed,
      "# In another tab: start the agent as usual.",
      input.command,
    ],
    headline: timed,
  };
}

function buildExplain(input: KeepAwakeInput): string[] {
  const out: string[] = [];
  if (input.os === "macos") {
    if (input.power === "plugged") {
      out.push("-i stops idle sleep. -s stops system sleep, and only applies while the Mac is on AC power.");
    } else {
      out.push("-i stops idle sleep. -s is left out because it only applies on AC power.");
    }
    if (input.duration === "until-exit") {
      out.push("Wrapping the command ties the keep-awake to it: caffeinate releases it when the command exits.");
    } else {
      out.push(
        `-t ${hoursToSeconds(input.hours)} is ${input.hours} hours in seconds. caffeinate ignores -t when it wraps a command, so the timed form runs on its own in a second tab.`
      );
    }
    return out;
  }
  out.push(
    input.lid === "closed"
      ? "--what=sleep blocks suspend and hibernate requests. handle-lid-switch also blocks the action a closed lid would take."
      : "--what=sleep blocks suspend and hibernate requests while the command runs."
  );
  out.push(
    input.duration === "until-exit"
      ? "systemd-inhibit holds the lock while the command runs and drops it when the command exits."
      : `The lock lasts as long as the command it runs. sleep ${hoursToSeconds(input.hours)} is ${input.hours} hours in seconds.`
  );
  return out;
}

function buildVerdict(input: KeepAwakeInput): KeepAwakeResult["verdict"] {
  if (input.os === "macos") {
    if (input.lid === "open") {
      return input.power === "plugged"
        ? {
            level: "works",
            title: "Keeps this Mac awake while the lid stays open",
            detail: "Idle sleep and system sleep are both held off while the Mac is plugged in.",
          }
        : {
            level: "works",
            title: "Keeps this Mac awake while the lid stays open, and drains the battery",
            detail: "On battery only idle sleep is held off, because -s needs AC power. The battery keeps draining.",
          };
    }
    return input.power === "plugged"
      ? {
          level: "caveat",
          title: "caffeinate alone will not cover a closed lid",
          detail:
            "Apple documents lid-closed use only with an external display, power connected and an external keyboard and mouse or trackpad. Without those, plan on the lid sleeping the Mac.",
        }
      : {
          level: "wont",
          title: "A closed lid on battery is not a setup Apple documents",
          detail:
            "Closed-lid use needs power connected, so expect the Mac to sleep. Open the lid or plug in, then use this command.",
        };
  }
  if (input.lid === "open") {
    return {
      level: "works",
      title: "Blocks suspend while the command runs",
      detail:
        input.power === "plugged"
          ? "systemd-inhibit holds a sleep lock until the command exits."
          : "systemd-inhibit holds a sleep lock until the command exits. It does not look at the power source, so a flat battery still ends the run.",
    };
  }
  return {
    level: "works",
    title: "Blocks suspend and the lid-close action while the command runs",
    detail:
      "If your desktop handles the lid itself, it may still sleep. Test by closing the lid for a minute with the command running.",
  };
}

function buildVerify(input: KeepAwakeInput): KeepAwakeResult["verify"] {
  if (input.os === "macos") {
    return {
      command: "pmset -g assertions",
      hint: 'Look for "caffeinate command-line tool" under PreventUserIdleSystemSleep, and under PreventSystemSleep when you are on power.',
    };
  }
  return {
    command: "systemd-inhibit --list",
    hint: `Look for a lock with the reason "${WHY}" that lists sleep.`,
  };
}

function buildPmset(input: KeepAwakeInput): KeepAwakeResult["pmset"] {
  if (input.os !== "macos") return null;
  const source = input.power === "plugged" ? "-c" : "-b";
  return {
    lines: ["pmset -g custom", `sudo pmset ${source} sleep 0`],
    note: `Only if you want it to last. The first line shows your current settings, so note the sleep value. The second turns the ${input.power === "plugged" ? "plugged-in" : "battery"} sleep timer off until you set it back. pmset does not stop a closed lid from sleeping the Mac, and a forgotten setting drains the battery, so caffeinate is usually cleaner.`,
  };
}

function buildNotCovered(input: KeepAwakeInput): string[] {
  const out: string[] = [];
  if (input.os === "macos") {
    out.push(
      input.lid === "closed"
        ? "A closed lid. caffeinate is not closed-display mode, and Apple documents closed-lid use only with an external display, power connected and an external keyboard and mouse or trackpad."
        : "A closed lid. If you shut it, expect the Mac to sleep: Apple documents closed-lid use only with an external display, power connected and an external keyboard and mouse or trackpad."
    );
    out.push(
      input.power === "plugged"
        ? "Unplugging. -s stops applying when the Mac runs on battery, and -i still holds off idle sleep."
        : "A flat battery. The Mac runs until the battery is empty."
    );
  } else {
    out.push(
      input.lid === "closed"
        ? "A desktop that handles the lid itself. If the laptop still sleeps with the lid shut, check the desktop's power settings."
        : "A closed lid. This lock blocks suspend only. Choose lid closed to block the lid-close action as well."
    );
    out.push(
      input.power === "plugged"
        ? "Switching to battery. systemd-inhibit does not look at the power source."
        : "A flat battery. Nothing here checks the power source, and the laptop runs until the battery is empty."
    );
    out.push("Machines without systemd. systemd-inhibit comes with systemd.");
  }
  if (input.duration === "hours") {
    out.push(`Anything after ${input.hours} hours. The keep-awake ends on its own and the machine can sleep, even if the agent is still running.`);
  }
  out.push("A reboot or an OS update that restarts the machine. Every run ends when it restarts.");
  out.push("A network change or drop, such as a new wifi network, a VPN reconnecting or tethering. A call in flight can fail.");
  out.push("Closing the terminal window. The agent and the keep-awake command stop with it, unless they run inside tmux.");
  out.push("The agent crashing or hitting a usage limit. This keeps the machine awake. It does not restart anything.");
  return out;
}

function buildAgentPrompt(input: KeepAwakeInput, lines: string[], verify: KeepAwakeResult["verify"], notCovered: string[]): string {
  const machine = input.os === "macos" ? "Mac" : "laptop";
  const parts: string[] = [];
  if (input.duration === "until-exit") {
    parts.push(
      `Keep this ${machine} awake while \`${input.command}\` runs. Start it with exactly this command, and do not change any other power or sleep setting:`
    );
    parts.push("", ...lines);
  } else {
    parts.push(
      `Keep this ${machine} awake for ${input.hours} hours while my agent works. Run the first command in the background and leave it running, since it ends on its own after ${input.hours} hours. Then start the agent. Do not change any other power or sleep setting:`
    );
    parts.push("", ...lines.filter((line) => !line.startsWith("#")));
  }
  parts.push("", `After it starts, check it with \`${verify.command}\`. ${verify.hint}`);
  parts.push("", "Tell me plainly what this does not cover:", ...notCovered.map((item) => `- ${item}`));
  return parts.join("\n");
}

/** Everything the page shows for one set of answers. */
export function buildKeepAwake(rawInput: KeepAwakeInput): KeepAwakeResult {
  const input = normalizeKeepAwake(rawInput);
  const { lines, headline } = buildLines(input);
  const verify = buildVerify(input);
  const notCovered = buildNotCovered(input);
  return {
    input,
    lines,
    script: lines.join("\n"),
    headline,
    explain: buildExplain(input),
    verdict: buildVerdict(input),
    verify,
    pmset: buildPmset(input),
    notCovered,
    agentPrompt: buildAgentPrompt(input, lines, verify, notCovered),
  };
}
