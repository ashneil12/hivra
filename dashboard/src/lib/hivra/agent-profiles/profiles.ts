// One wake profile per agent type Hivra launches (hivra_agents.type, see
// agent-catalog.ts). Adding an agent type means adding one entry here; see
// docs/release/AGENT-SLEEP-ROLLOUT.md, "Adding a new agent type".
//
// COMPUTER_PROFILE holds what every Hivra computer has, whatever agent runs
// on it: the terminal coding CLIs a user can start from any terminal, the
// crontab and at spool, the Hivra Telegram bridge, and every agent app port
// the probe has always watched. It is merged into every profile, so a type's
// own entry only adds to it.
//
// Pure data. Nothing here is a secret: a profile names where an agent keeps a
// value, never the value.

import type { AgentWakeProfile, ProcessMatch } from "./types";

const HERMES_GATEWAY: ProcessMatch = { cmdAll: ["hermes", " gateway"] };
const OPENCLAW_GATEWAY: ProcessMatch = { cmdAll: ["openclaw", " gateway"] };
/** Anything running in a Docker container (Agent Zero, OpenBot, Nuphos run there). */
const IN_CONTAINER: ProcessMatch = { cgroup: "docker" };

export const COMPUTER_PROFILE: AgentWakeProfile = {
  type: "computer",
  busy: [{ comm: ["claude", "codex"], cmd: "(^|/)(claude|codex)( |$)" }],
  agentProcesses: [],
  activity: [
    { path: "~/.claude/projects", depth: 5, budget: 4000 },
    { path: "~/.codex/sessions", depth: 5, budget: 4000 },
  ],
  schedules: [
    { kind: "crontab", path: "/var/spool/cron/crontabs/bux" },
    { kind: "dir-nonempty", path: "/var/spool/cron/atjobs" },
  ],
  channels: [
    { kind: "systemd-env", tag: "telegram:bux-tg", platform: "telegram", unit: "bux-tg", path: "/etc/bux/tg.env", key: "TG_BOT_TOKEN",
      owner: { cgroup: "bux-tg\\.service" } },
  ],
  wake: {},
  appPorts: [5555, 18789, 50080, 9119, 9120, 3101],
};

/** The .env keys Hermes reads per platform: [key regex prefix, platform]. */
const HERMES_ENV_CHANNELS: readonly (readonly [string, string])[] = [
  ["TELEGRAM_BOT_TOKEN", "telegram"], ["DISCORD_BOT_TOKEN", "discord"], ["SLACK_BOT_TOKEN", "slack"],
  ["WHATSAPP_(?!CLOUD_)", "whatsapp"], ["WHATSAPP_CLOUD_", "whatsapp_cloud"], ["SIGNAL_", "signal"],
  ["MATRIX_ACCESS_TOKEN", "matrix"], ["MATRIX_PASSWORD", "matrix"], ["MATTERMOST_TOKEN", "mattermost"],
  ["EMAIL_", "email"], ["TWILIO_ACCOUNT_SID", "sms"], ["BLUEBUBBLES_SERVER_URL", "bluebubbles"],
  ["DINGTALK_CLIENT_ID", "dingtalk"], ["FEISHU_APP_ID", "feishu"], ["QQ_APP_ID", "qqbot"],
  ["WECOM_BOT_ID", "wecom"], ["WECOM_CALLBACK_CORP_ID", "wecom_callback"], ["WEIXIN_TOKEN", "weixin"],
  ["GOOGLE_CHAT_SERVICE_ACCOUNT_JSON", "google_chat"], ["IRC_SERVER", "irc"], ["LINE_CHANNEL_ACCESS_TOKEN", "line"],
  ["TEAMS_CLIENT_ID", "teams"], ["SIMPLEX_WS_URL", "simplex"], ["NTFY_TOPIC", "ntfy"],
  ["PHOTON_PROJECT_ID", "photon"], ["RAFT_PROFILE", "raft"], ["BUZZ_RELAY_URL", "buzz"],
];

const HERMES_ENV = "~/.hermes/.env";
const HERMES_CONFIG = "~/.hermes/config.yaml";
const henv = (key: string) => ({ kind: "env", path: HERMES_ENV, key }) as const;

const HERMES: AgentWakeProfile = {
  type: "hermes",
  busy: [],
  agentProcesses: [HERMES_GATEWAY],
  activity: [],
  schedules: [
    { kind: "hermes-jobs", path: "~/.hermes/cron/jobs.json", profilesDir: "~/.hermes/profiles", profilePath: "/cron/jobs.json" },
  ],
  // The .env first, then Hermes's own record, then config.yaml: the order the probe has always read them in.
  channels: [
    { kind: "env-keys", prefix: "hermes", path: HERMES_ENV, keys: HERMES_ENV_CHANNELS, up: HERMES_GATEWAY },
    { kind: "gateway-state", prefix: "hermes", path: "~/.hermes/gateway_state.json", profilesDir: "~/.hermes/profiles",
      profilePath: "/gateway_state.json", ignore: ["api_server", "local"], requiredWhileUp: true, up: HERMES_GATEWAY },
    { kind: "yaml-enabled", prefix: "hermes", path: HERMES_CONFIG, up: HERMES_GATEWAY },
  ],
  wake: {
    telegram: {
      tag: "hermes:telegram",
      credential: [henv("TELEGRAM_BOT_TOKEN")],
      webhook: henv("TELEGRAM_WEBHOOK_URL"),
      shadow: [{ kind: "regex", path: HERMES_CONFIG, pattern: String.raw`^  telegram:\s*\n(?:    .*\n)*?    (?:bot_)?token:\s*\S` }],
      catchUp: { kind: "server-queued" },
    },
    matrix: { tag: "hermes:matrix", credential: [henv("MATRIX_HOMESERVER"), henv("MATRIX_ACCESS_TOKEN")], catchUp: { kind: "server-queued" } },
    email: {
      tag: "hermes:email",
      credential: [henv("EMAIL_ADDRESS"), henv("EMAIL_PASSWORD"), henv("EMAIL_IMAP_HOST")],
      catchUp: { kind: "server-queued" },
    },
    discord: {
      tag: "hermes:discord",
      credential: [henv("DISCORD_BOT_TOKEN")],
      catchUp: { kind: "backfill-setting", setting: henv("DISCORD_MISSED_MESSAGE_BACKFILL") },
    },
  },
  hermesFacts: { env: HERMES_ENV, config: HERMES_CONFIG, prefix: "hermes" },
  appPorts: [9119, 9120],
};

const OPENCLAW_JSON = "~/.openclaw/openclaw.json";

const OPENCLAW: AgentWakeProfile = {
  type: "openclaw",
  busy: [],
  agentProcesses: [OPENCLAW_GATEWAY],
  activity: [{ path: "~/.openclaw/agents", depth: 4, budget: 4000 }],
  schedules: [
    { kind: "json-next-run", path: "~/.openclaw/cron/jobs-state.json", key: "nextRunAtMs" },
    { kind: "json-next-run", path: "~/.openclaw/cron/jobs.json", key: "nextRunAtMs" },
  ],
  channels: [{ kind: "json-channels", prefix: "openclaw", path: OPENCLAW_JSON, at: ["channels"], owner: OPENCLAW_GATEWAY }],
  wake: {
    // A polling bot: Telegram keeps the updates while the wake webhook is set
    // and hands them over once it is deleted. A webhook of OpenClaw's own, a
    // token file, more than one account or a token in .env is anything the
    // fingerprint cannot vouch for, so it stays awake.
    telegram: {
      tag: "openclaw:telegram",
      credential: [{ kind: "json", path: OPENCLAW_JSON, at: ["channels", "telegram", "botToken"] }],
      webhook: { kind: "json", path: OPENCLAW_JSON, at: ["channels", "telegram", "webhookUrl"] },
      shadow: [
        { kind: "json", path: OPENCLAW_JSON, at: ["channels", "telegram", "tokenFile"] },
        { kind: "json", path: OPENCLAW_JSON, at: ["channels", "telegram", "accounts"] },
        { kind: "env", path: "~/.openclaw/.env", key: "TELEGRAM_BOT_TOKEN" },
      ],
      catchUp: { kind: "server-queued" },
    },
  },
  appPorts: [18789],
};

const AGENT_ZERO: AgentWakeProfile = {
  type: "agent-zero",
  busy: [],
  agentProcesses: [IN_CONTAINER],
  activity: [{ path: "/opt/a0/usr/chats", depth: 3, budget: 4000 }],
  schedules: [{ kind: "json-nonempty", path: "/opt/a0/usr/scheduler/tasks.json", key: "tasks" }],
  channels: [],
  wake: {},
  appPorts: [50080],
};

const CLAUDE_CODE: AgentWakeProfile = {
  type: "claude-code",
  busy: [{ comm: ["claude"], cmd: "(^|/)claude( |$)" }],
  agentProcesses: [],
  activity: [{ path: "~/.claude/projects", depth: 5, budget: 4000 }],
  schedules: [],
  channels: [],
  wake: {},
  appPorts: [],
};

const CODEX: AgentWakeProfile = {
  type: "codex",
  busy: [{ comm: ["codex"], cmd: "(^|/)codex( |$)" }],
  agentProcesses: [],
  activity: [{ path: "~/.codex/sessions", depth: 5, budget: 4000 }],
  schedules: [],
  channels: [],
  wake: {},
  appPorts: [],
};

const AEON: AgentWakeProfile = {
  type: "aeon",
  busy: [],
  agentProcesses: [],
  activity: [],
  schedules: [],
  channels: [],
  wake: {},
  appPorts: [5555],
};

const OPENBOT: AgentWakeProfile = {
  type: "openbot",
  busy: [],
  agentProcesses: [IN_CONTAINER],
  activity: [],
  schedules: [],
  channels: [],
  wake: {},
  appPorts: [3101],
};

// Nuphos is reached from the Nuphos app through its own service, which holds
// the line open. Nothing says the app keeps messages for a sleeping runtime,
// so while the runtime runs it is a live channel that is never covered.
const NUPHOS: AgentWakeProfile = {
  type: "nuphos",
  busy: [],
  agentProcesses: [IN_CONTAINER],
  activity: [],
  schedules: [],
  channels: [{ kind: "systemd-active", tag: "nuphos:app", platform: "app", unit: "hivra-nuphos", owner: IN_CONTAINER }],
  wake: {},
  appPorts: [3102],
};

const DEEPSEEK_HARNESS: AgentWakeProfile = {
  type: "deepseek-harness",
  busy: [],
  agentProcesses: [{ cmd: "deepseek|runtime-process" }],
  activity: [],
  schedules: [],
  channels: [],
  wake: {},
  appPorts: [3080],
};

const LINUX_DESKTOP: AgentWakeProfile = {
  type: "linux-desktop", busy: [], agentProcesses: [], activity: [], schedules: [], channels: [], wake: {}, appPorts: [],
};

const LINUX_TERMINAL: AgentWakeProfile = {
  type: "linux-terminal", busy: [], agentProcesses: [], activity: [], schedules: [], channels: [], wake: {}, appPorts: [],
};

/** Every profile, keyed by hivra_agents.type. Order matters only for the no-profile union (the probe's old reading order). */
export const AGENT_WAKE_PROFILES: readonly AgentWakeProfile[] = [
  HERMES, OPENCLAW, AGENT_ZERO, CLAUDE_CODE, CODEX, AEON, OPENBOT, NUPHOS, DEEPSEEK_HARNESS, LINUX_DESKTOP, LINUX_TERMINAL,
];
