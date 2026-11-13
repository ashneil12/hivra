// The shape of an agent wake profile: everything the idle probe and the
// channel wake adapters need to know about one kind of agent, as data. Pure
// types, no imports with side effects, so the sleep scripts can read them.
//
// A profile never holds a secret. It names where an agent keeps things (a
// file and a key), never what is in them. Paths start with "~/" for the agent
// account's home, or "/" for an absolute guest path.

/** Matches a process. Any one listed test is enough. */
export interface ProcessMatch {
  /** Exact /proc/<pid>/comm names. */
  comm?: readonly string[];
  /** A Python regular expression searched in the command line (NULs read as spaces). */
  cmd?: string;
  /** Every one of these substrings is in the command line. */
  cmdAll?: readonly string[];
  /** A Python regular expression searched in /proc/<pid>/cgroup (a systemd unit, or "docker" for a container). */
  cgroup?: string;
}

/** A directory whose newest file time counts as the agent's last use. */
export interface ActivityDir {
  path: string;
  /** How deep below the directory to look. */
  depth: number;
  /** At most this many entries are looked at, so a huge tree cannot stall the probe. */
  budget: number;
}

/**
 * Where something scheduled to run by itself is kept, and how to read it.
 *
 *   hermes-jobs     Hermes cron jobs.json (also every profile under profilesDir)
 *   json-next-run   any JSON file: every number or time under `key`, anywhere in
 *                   it, skipping objects with "enabled": false
 *   json-nonempty   a JSON object whose `key` is non-empty: a job is due now
 *   crontab         a crontab file with any real entry: due now
 *   dir-nonempty    a spool directory with any entry: due now
 */
export type ScheduleSource =
  | { kind: "hermes-jobs"; path: string; profilesDir?: string; profilePath?: string }
  | { kind: "json-next-run"; path: string; key: string }
  | { kind: "json-nonempty"; path: string; key: string }
  | { kind: "crontab"; path: string }
  | { kind: "dir-nonempty"; path: string };

/**
 * Where an agent records the chat channels it runs. Each one reports tags
 * "<prefix>:<platform>", or ":down" added when `up` is declared and no such
 * process runs. `owner` (or else `up`) is the process that holds the
 * channel's connection: the chat safety net (see endpoints.ts) counts a
 * connection to a chat service as this channel only when that process (or
 * one of its parents) holds it.
 *
 *   gateway-state   Hermes gateway_state.json: every platform in "platforms"
 *                   except `ignore` and ones marked disabled; while `up` runs
 *                   the file must be readable (`requiredWhileUp`)
 *   env-keys        a .env file: each [key regex, platform] set to a value
 *   yaml-enabled    a YAML file: every two-space key with "enabled: true" under it
 *   json-channels   a JSON file: every key of the object at `at` not disabled
 *   systemd-env     a fixed `tag` while `key` is set in `path` and `unit` is active
 *   systemd-active  a fixed `tag` while `unit` is active
 */
export type ChannelSource =
  | {
      kind: "gateway-state"; prefix: string; path: string; profilesDir?: string; profilePath?: string;
      ignore: readonly string[]; requiredWhileUp: boolean; up?: ProcessMatch; owner?: ProcessMatch;
    }
  | { kind: "env-keys"; prefix: string; path: string; keys: readonly (readonly [string, string])[]; up?: ProcessMatch; owner?: ProcessMatch }
  | { kind: "yaml-enabled"; prefix: string; path: string; up?: ProcessMatch; owner?: ProcessMatch }
  | { kind: "json-channels"; prefix: string; path: string; at: readonly string[]; up?: ProcessMatch; owner?: ProcessMatch }
  | { kind: "systemd-env"; tag: string; platform: string; unit: string; path: string; key: string; owner?: ProcessMatch }
  | { kind: "systemd-active"; tag: string; platform: string; unit: string; owner?: ProcessMatch };

/**
 * Where one value lives in the guest. Only presence and a fingerprint of the
 * value ever leave the probe, never the value itself.
 *
 *   env     a .env file key, read the way python-dotenv reads plain files
 *   json    a string at a key path in a JSON file
 *   regex   presence only: a Python regex (multiline) matches the file's text
 */
export type ValueLocation =
  | { kind: "env"; path: string; key: string }
  | { kind: "json"; path: string; at: readonly string[] }
  | { kind: "regex"; path: string; pattern: string };

/**
 * How the agent gets the messages that arrived while it slept.
 *
 *   none              it does not: the channel can never be covered
 *   server-queued     the chat service holds them until the agent asks again
 *                     (a polling Telegram bot: getUpdates after deleteWebhook)
 *   backfill-setting  only with a setting turned on, kept at `setting`
 */
export type CatchUp =
  | { kind: "none" }
  | { kind: "server-queued" }
  | { kind: "backfill-setting"; setting: ValueLocation };

/** One chat channel a wake adapter may cover for this kind of agent. */
export interface ChannelWakeSource {
  /** The live channel tag the probe reports for it, e.g. "openclaw:telegram". */
  tag: string;
  /** The credential the adapter reads at opt-in and the probe fingerprints. Env keys are joined by a newline. */
  credential: readonly ValueLocation[];
  /** Set means the agent runs its own webhook for this channel, which a wake cannot share. */
  webhook?: ValueLocation;
  /** Other places the agent may take a credential from, which the fingerprint cannot vouch for. */
  shadow?: readonly ValueLocation[];
  catchUp: CatchUp;
}

/** Platforms a wake adapter exists for. Others may be declared in channel sources but are never covered. */
export type WakePlatform = "telegram" | "matrix" | "email" | "discord";

export interface AgentWakeProfile {
  /** hivra_agents.type. */
  type: string;
  /** Processes whose presence means work is running right now (a coding CLI, a job runner). */
  busy: readonly ProcessMatch[];
  /** The agent's own long-running processes, checked for CPU use by the safety net. */
  agentProcesses: readonly ProcessMatch[];
  activity: readonly ActivityDir[];
  schedules: readonly ScheduleSource[];
  channels: readonly ChannelSource[];
  /** Per platform: where the credential lives and how the agent catches up. Absent means no wake for it. */
  wake: Partial<Record<WakePlatform, ChannelWakeSource>>;
  /** Hermes-style per-channel facts (Discord backfill, Matrix login, ...). */
  hermesFacts?: { env: string; config: string; prefix: string };
  /** Loopback ports the agent's own app serves on; an established connection is use. */
  appPorts: readonly number[];
}
