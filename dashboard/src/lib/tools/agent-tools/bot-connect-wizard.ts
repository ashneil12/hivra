// Connect-your-agent wizard logic (/tools/telegram-discord-bot-setup). Pure data and functions: no React,
// no browser APIs.
//
// Three jobs live here: the Discord permission bit math and invite URL, a SHAPE-only token checker, and
// the facts table behind every step. Nothing here ever stores or sends a token, and no function returns
// the text it was given, so a token cannot be echoed into a result, a link or a summary.
//
// Every external fact sits in BOT_CONNECT_FACTS (read from the vendors' own pages on 2026-11-12). The
// permission values are Discord's documented table; the tests hold them to it.

import { agentDeployHref, getAgentSeoEntry } from "@/lib/hivra/agent-seo-catalog";

export type Platform = "telegram" | "discord";
export const PLATFORMS: readonly Platform[] = ["telegram", "discord"] as const;
export const DEFAULT_PLATFORM: Platform = "telegram";

export const PLATFORM_LABEL: Record<Platform, string> = { telegram: "Telegram", discord: "Discord" };

export const BOT_CONNECT_FACTS = {
  lastVerified: "2026-11-12",
  sources: [
    { label: "Telegram: bot features (BotFather, privacy mode, token)", url: "https://core.telegram.org/bots/features" },
    { label: "Telegram: bots tutorial (tokens)", url: "https://core.telegram.org/bots/tutorial" },
    { label: "Telegram: bots FAQ (privacy mode)", url: "https://core.telegram.org/bots/faq" },
    { label: "Telegram: Bot API (token in requests, User id)", url: "https://core.telegram.org/bots/api" },
    { label: "Discord: getting started (create app, reset token)", url: "https://docs.discord.com/developers/quick-start/getting-started" },
    { label: "Discord: gateway and privileged intents", url: "https://docs.discord.com/developers/events/gateway" },
    { label: "Discord: OAuth2 and bot authorization", url: "https://docs.discord.com/developers/topics/oauth2" },
    { label: "Discord: permissions table", url: "https://docs.discord.com/developers/topics/permissions" },
    { label: "Hermes: Telegram setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram" },
    { label: "Hermes: Discord setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord" },
    { label: "OpenClaw: Telegram setup", url: "https://docs.openclaw.ai/channels/telegram/setup" },
    { label: "OpenClaw: Discord setup", url: "https://docs.openclaw.ai/channels/discord/setup" },
    { label: "OpenClaw: pairing CLI", url: "https://docs.openclaw.ai/cli/pairing" },
  ],
  /** Telegram's own documentation example has 34 characters after the colon. */
  telegramDocExampleSecretLength: 34,
  /** Where the Telegram docs say to go for a compromised token. */
  telegramRevokeDocs: "Telegram's docs name /token to generate a new token when one is compromised or lost.",
  discordAuthorizeUrl: "https://discord.com/oauth2/authorize",
  discordScope: "bot%20applications.commands",
  verifiedThreshold: 100,
} as const;

// ---- Discord permissions ----------------------------------------------------------------------

export type PermissionKey =
  | "viewChannel"
  | "sendMessages"
  | "embedLinks"
  | "attachFiles"
  | "readMessageHistory"
  | "addReactions"
  | "useExternalEmojis"
  | "useApplicationCommands"
  | "createPublicThreads"
  | "createPrivateThreads"
  | "sendMessagesInThreads"
  | "mentionEveryone"
  | "manageMessages"
  | "administrator";

export interface PermissionDef {
  key: PermissionKey;
  /** The name Discord's permissions table uses. */
  discordName: string;
  /** What the checkbox says. */
  label: string;
  /** The bit position: the permission is 1 << bit. */
  bit: number;
  /** A permission an agent that answers messages rarely needs and that widens what a leaked token can do. */
  risky?: boolean;
}

/** Bit positions are Discord's documented ones (permissions table, read 2026-11-12). Display order is by need. */
export const PERMISSIONS: readonly PermissionDef[] = [
  { key: "viewChannel", discordName: "VIEW_CHANNEL", label: "View channels", bit: 10 },
  { key: "sendMessages", discordName: "SEND_MESSAGES", label: "Send messages", bit: 11 },
  { key: "readMessageHistory", discordName: "READ_MESSAGE_HISTORY", label: "Read message history", bit: 16 },
  { key: "embedLinks", discordName: "EMBED_LINKS", label: "Embed links", bit: 14 },
  { key: "attachFiles", discordName: "ATTACH_FILES", label: "Attach files", bit: 15 },
  { key: "addReactions", discordName: "ADD_REACTIONS", label: "Add reactions", bit: 6 },
  { key: "sendMessagesInThreads", discordName: "SEND_MESSAGES_IN_THREADS", label: "Send messages in threads", bit: 38 },
  { key: "createPublicThreads", discordName: "CREATE_PUBLIC_THREADS", label: "Create public threads", bit: 35 },
  { key: "createPrivateThreads", discordName: "CREATE_PRIVATE_THREADS", label: "Create private threads", bit: 36 },
  { key: "useExternalEmojis", discordName: "USE_EXTERNAL_EMOJIS", label: "Use external emojis", bit: 18 },
  { key: "useApplicationCommands", discordName: "USE_APPLICATION_COMMANDS", label: "Use slash commands", bit: 31 },
  { key: "mentionEveryone", discordName: "MENTION_EVERYONE", label: "Mention @everyone, @here and all roles", bit: 17, risky: true },
  { key: "manageMessages", discordName: "MANAGE_MESSAGES", label: "Manage messages (delete and pin others' messages)", bit: 13, risky: true },
  { key: "administrator", discordName: "ADMINISTRATOR", label: "Administrator (every permission, in every channel)", bit: 3, risky: true },
] as const;

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_BY_KEY: Record<PermissionKey, PermissionDef> = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p])) as Record<
  PermissionKey,
  PermissionDef
>;

export function permissionBit(key: PermissionKey): bigint {
  return BigInt(1) << BigInt(PERMISSION_BY_KEY[key].bit);
}

/** The permissions integer for a set of keys, as Discord reads it: the sum of 1 << bit. Duplicates count once. */
export function permissionsInteger(keys: readonly PermissionKey[]): string {
  let total = BigInt(0);
  for (const key of new Set(keys)) total |= permissionBit(key);
  return total.toString();
}

/** Both agents' docs list this set as the baseline: view, send, history, embed links, attach files. */
export const MINIMAL_PERMISSIONS: readonly PermissionKey[] = ["viewChannel", "sendMessages", "readMessageHistory", "embedLinks", "attachFiles"];
/** Hermes' recommended set adds reactions and the two thread permissions its docs name. */
export const THREAD_PERMISSIONS: readonly PermissionKey[] = [
  ...MINIMAL_PERMISSIONS,
  "addReactions",
  "createPublicThreads",
  "sendMessagesInThreads",
];

export const PERMISSION_PRESETS = [
  { id: "minimal", label: "Minimal chat", keys: MINIMAL_PERMISSIONS },
  { id: "threads", label: "Chat, reactions and threads", keys: THREAD_PERMISSIONS },
] as const;

/** Canonical order, no duplicates, unknown values dropped. */
export function normalisePermissions(keys: readonly string[]): PermissionKey[] {
  const wanted = new Set(keys);
  return PERMISSION_KEYS.filter((k) => wanted.has(k));
}

/** A Discord application id is a snowflake: 17 to 20 digits today. */
export function isApplicationId(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}

export interface InviteResult {
  url: string | null;
  /** Plain reason when there is no URL yet. */
  problem: string | null;
  integer: string;
  warnings: string[];
}

export function buildInviteUrl(applicationId: string, keys: readonly PermissionKey[]): InviteResult {
  const permissions = normalisePermissions(keys);
  const integer = permissionsInteger(permissions);
  const warnings: string[] = [];
  if (permissions.includes("administrator")) {
    warnings.push("Administrator gives the bot every permission in every channel. If its token leaks, so does all of that. Untick it unless you have a reason.");
  }
  if (!permissions.includes("viewChannel") || !permissions.includes("sendMessages")) {
    warnings.push("Without View channels and Send messages the bot cannot see or answer anything in a channel.");
  }
  const id = applicationId.trim();
  if (id === "") return { url: null, problem: "Paste your Application ID to build the link.", integer, warnings };
  if (!isApplicationId(id)) {
    return { url: null, problem: "An Application ID is a number of 17 to 20 digits. Copy it from the General Information page, not the Bot page.", integer, warnings };
  }
  const url = `${BOT_CONNECT_FACTS.discordAuthorizeUrl}?client_id=${id}&scope=${BOT_CONNECT_FACTS.discordScope}&permissions=${integer}`;
  return { url, problem: null, integer, warnings };
}

// ---- Token shape checker ----------------------------------------------------------------------

export type CheckLevel = "empty" | "looks-right" | "unusual" | "wrong";

export interface TokenCheck {
  level: CheckLevel;
  /** One sentence for the headline. */
  headline: string;
  /** What was found, or what to fix. Never contains the token. */
  details: string[];
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Decode base64url to a binary string, or null if it is not valid. No browser API needed. */
export function decodeBase64Url(value: string): string | null {
  if (!B64URL.test(value) || value.length % 4 === 1) return null;
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const ch of value) {
    acc = (acc << 6) | B64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

/** Strip what people copy along with a token: spaces, quotes, an "Authorization: Bot" or "Bot " prefix. Reports what it removed. */
function tidy(raw: string): { value: string; notes: string[] } {
  const notes: string[] = [];
  let value = raw.trim();
  if (value !== raw) notes.push("Leading or trailing spaces were ignored. Make sure they are not in the config you paste into.");
  const unquoted = value.replace(/^["'`]+|["'`]+$/g, "");
  if (unquoted !== value) {
    notes.push("Quotes around the token were ignored. Quotes are right inside a config file and wrong in a chat setup prompt.");
    value = unquoted;
  }
  return { value, notes };
}

function digitsOnly(value: string): boolean {
  return /^\d+$/.test(value);
}

export function checkTelegramToken(raw: string): TokenCheck {
  const { value: tidied, notes } = tidy(raw);
  if (tidied === "") return { level: "empty", headline: "Nothing to check yet.", details: [] };
  let value = tidied;
  const fromUrl = /^https?:\/\/api\.telegram\.org\/bot(.+?)(?:\/.*)?$/i.exec(value);
  if (fromUrl) {
    notes.push("That is a Bot API address. Only the part after /bot and before the next slash is the token.");
    value = fromUrl[1];
  } else if (/^bot\d/i.test(value)) {
    notes.push("Telegram's API addresses put the word bot in front of the token. The token itself starts with the digits.");
    value = value.slice(3);
  }
  const wrong = (headline: string, ...details: string[]): TokenCheck => ({ level: "wrong", headline, details: [...notes, ...details] });

  if (/\s/.test(value)) return wrong("The token has a space or line break inside it.", "A Telegram token is one unbroken string. Re-copy it from BotFather.");
  if (value.split(".").length === 3) {
    return wrong("This looks like a Discord token, not a Telegram one.", "Telegram tokens are digits, a colon, then letters and digits. Switch the platform above if you meant Discord.");
  }
  if (digitsOnly(value) && /^\d{17,20}$/.test(value)) {
    return wrong("This looks like a Discord ID, not a Telegram token.", "A Telegram token has a colon in the middle.");
  }
  if (!value.includes(":")) return wrong("There is no colon in it.", "A Telegram token looks like digits, a colon, then 35 letters, digits, underscores or hyphens.");
  const idx = value.indexOf(":");
  const left = value.slice(0, idx);
  const right = value.slice(idx + 1);
  if (value.indexOf(":", idx + 1) !== -1) return wrong("There is more than one colon.", "A token has exactly one, between the bot's number and the secret part.");
  if (!digitsOnly(left) || left.length < 5) {
    return wrong("The part before the colon is not a number.", "It should be digits only. That number is the bot's own id.");
  }
  if (!B64URL.test(right)) {
    return wrong("The part after the colon has characters a token never has.", "Only letters, digits, underscores and hyphens appear there.");
  }
  if (right.length === 35) {
    return {
      level: "looks-right",
      headline: "The shape is right.",
      details: [...notes, "That says nothing about whether the token is live. Only the agent connecting, or BotFather, can tell you that."],
    };
  }
  return {
    level: "unusual",
    headline: `The part after the colon is ${right.length} characters, not the usual 35.`,
    details: [
      ...notes,
      right.length < 35 ? "It may have been cut off when you copied it." : "It may have extra characters stuck on the end.",
      `Telegram does not document a fixed length. Its own example has ${BOT_CONNECT_FACTS.telegramDocExampleSecretLength}. If BotFather gave you exactly this, it may still be valid.`,
    ],
  };
}

export function checkDiscordToken(raw: string): TokenCheck {
  const { value: tidied, notes } = tidy(raw);
  if (tidied === "") return { level: "empty", headline: "Nothing to check yet.", details: [] };
  let value = tidied;
  if (/^bot\s+/i.test(value)) {
    notes.push("The word Bot in front is how an HTTP request names the token. It is not part of the token.");
    value = value.replace(/^bot\s+/i, "").replace(/^["'`]+|["'`]+$/g, "");
  }
  const wrong = (headline: string, ...details: string[]): TokenCheck => ({ level: "wrong", headline, details: [...notes, ...details] });

  if (/\s/.test(value)) return wrong("The token has a space or line break inside it.", "A Discord token is one unbroken string. Reset it on the Bot page and copy it again.");
  if (/^\d{17,20}$/.test(value)) {
    return wrong("That is an ID, not a token.", "It looks like your Application ID. The token is on the Bot page, under Reset Token, and has two dots in it.");
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return wrong("That looks like a public key, not a token.", "The General Information page shows one. It is not the bot token, which has two dots in it.");
  }
  if (/^\d{5,}:[A-Za-z0-9_-]+$/.test(value)) {
    return wrong("This looks like a Telegram token, not a Discord one.", "Switch the platform above if you meant Telegram.");
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return wrong(`It has ${parts.length} dot-separated parts, not 3.`, "A Discord bot token is three parts joined by two dots.");
  }
  if (!parts.every((p) => p.length > 0 && B64URL.test(p))) {
    return wrong("One of the three parts has characters a token never has.", "Each part uses only letters, digits, underscores and hyphens.");
  }
  const [first, second, third] = parts;
  const decoded = decodeBase64Url(first);
  const firstIsId = decoded !== null && /^\d{17,20}$/.test(decoded);
  const problems: string[] = [];
  if (!firstIsId) problems.push("The first part does not decode to a bot id (17 to 20 digits). It usually does.");
  if (second.length !== 6) problems.push(`The second part is ${second.length} characters. It is usually 6.`);
  if (third.length < 27) problems.push(`The third part is ${third.length} characters. It is usually 27 or more.`);
  if (problems.length === 0) {
    return {
      level: "looks-right",
      headline: "The shape is right.",
      details: [...notes, "That says nothing about whether the token is live. Only the agent connecting can tell you that."],
    };
  }
  return {
    level: "unusual",
    headline: "Three parts, but the sizes are unusual.",
    details: [
      ...notes,
      ...problems,
      "Discord does not publish a token format, so this is a rule of thumb. If you copied it straight from the Bot page, it may still be valid.",
    ],
  };
}

export function checkToken(platform: Platform, raw: string): TokenCheck {
  return platform === "telegram" ? checkTelegramToken(raw) : checkDiscordToken(raw);
}

// ---- Where the token goes in each agent -------------------------------------------------------

export type AgentKey = "hermes" | "openclaw";
export const AGENT_KEYS: readonly AgentKey[] = ["hermes", "openclaw"] as const;
export const AGENT_LABEL: Record<AgentKey, string> = { hermes: "Hermes", openclaw: "OpenClaw" };

export interface AgentPlacement {
  /** Plain sentences, in order. */
  steps: string[];
  /** Exact commands or lines, each shown with a copy button. They never contain a real token. */
  commands: string[];
  /** What to do next, and what is not verified. */
  after: string[];
  docs: { label: string; url: string };
}

export const AGENT_PLACEMENTS: Record<AgentKey, Record<Platform, AgentPlacement>> = {
  hermes: {
    telegram: {
      steps: [
        "The easy way: run the gateway setup, choose Telegram and paste the token when it asks. It writes the token for you.",
        "Or set it yourself in the .env file in Hermes' home folder, then start the gateway.",
        "Add your own numeric Telegram user id to the allowed users, or the bot will not answer you.",
      ],
      commands: ["hermes gateway setup", "TELEGRAM_BOT_TOKEN=<your-bot-token>", "TELEGRAM_ALLOWED_USERS=<your-numeric-user-id>", "hermes gateway"],
      after: ["Several allowed ids are separated by commas. The .env file is ~/.hermes/.env."],
      docs: { label: "Hermes: Telegram setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram" },
    },
    discord: {
      steps: [
        "The easy way: run the gateway setup, choose Discord and paste the token when it asks.",
        "Or set it yourself in the .env file in Hermes' home folder. The token is a credential, so it does not go in config.yaml.",
        "Add your own Discord user id to the allowed users. With no allowlist set, the gateway denies everyone.",
      ],
      commands: ["hermes gateway setup", "DISCORD_BOT_TOKEN=<your-bot-token>", "DISCORD_ALLOWED_USERS=<your-discord-user-id>", "hermes gateway"],
      after: [
        "The .env file is ~/.hermes/.env. Hermes' docs say the Message Content intent is required, and that the Server Members intent is needed if you allow by username or by role.",
      ],
      docs: { label: "Hermes: Discord setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord" },
    },
  },
  openclaw: {
    telegram: {
      steps: [
        "The easy way: one command writes the token into OpenClaw's config for you.",
        "Or put it in the config file under channels.telegram.botToken. The TELEGRAM_BOT_TOKEN environment variable works for the default account only.",
        "Check that Telegram is ready. Telegram does not use the channels login command.",
        "OpenClaw pairs unknown senders by default: message the bot, then approve the code it shows.",
      ],
      commands: [
        "openclaw channels add --channel telegram --token <your-bot-token>",
        "openclaw channels status --probe",
        "openclaw pairing list telegram",
        "openclaw pairing approve telegram <code>",
      ],
      after: ["The config file is ~/.openclaw/openclaw.json."],
      docs: { label: "OpenClaw: Telegram setup", url: "https://docs.openclaw.ai/channels/telegram/setup" },
    },
    discord: {
      steps: [
        "OpenClaw's Discord guide sets the token as an environment variable on the machine that runs OpenClaw, not in a chat.",
        "Use the exact config keys and the pairing steps from its Discord guide, because we could not read them in full. See the agent's own docs.",
      ],
      commands: ['export DISCORD_BOT_TOKEN="<your-bot-token>"'],
      after: [
        "OpenClaw's guide asks for the Message Content intent, recommends the Server Members intent, and lists View Channels, Send Messages, Read Message History, Embed Links and Attach Files as baseline permissions.",
        "Discord DMs default to pairing mode. For the pairing command and the config block, see the agent's own docs.",
      ],
      docs: { label: "OpenClaw: Discord setup", url: "https://docs.openclaw.ai/channels/discord/setup" },
    },
  },
};

/** The sign-up link for an agent, from the same catalog the /agents pages use. */
export function startHrefFor(agent: AgentKey): string {
  const entry = getAgentSeoEntry(agent);
  if (!entry) throw new Error(`No public page for ${agent}`);
  return agentDeployHref(entry);
}

// ---- Steps ------------------------------------------------------------------------------------

export type StepId =
  | "tg-create"
  | "tg-check"
  | "tg-userid"
  | "tg-groups"
  | "dc-create"
  | "dc-intents"
  | "dc-invite"
  | "dc-check"
  | "dc-userid"
  | "paste";

export interface StepDef {
  id: StepId;
  title: string;
}

export const STEPS: Record<Platform, readonly StepDef[]> = {
  telegram: [
    { id: "tg-create", title: "Create the bot" },
    { id: "tg-check", title: "Check the token" },
    { id: "tg-userid", title: "Find your user id" },
    { id: "tg-groups", title: "Groups and privacy mode" },
    { id: "paste", title: "Paste it into your agent" },
  ],
  discord: [
    { id: "dc-create", title: "Create the application" },
    { id: "dc-intents", title: "Turn on intents" },
    { id: "dc-invite", title: "Build the invite link" },
    { id: "dc-check", title: "Copy and check the token" },
    { id: "dc-userid", title: "Find your user id" },
    { id: "paste", title: "Paste it into your agent" },
  ],
};

export const LEAK_STEPS: Record<Platform, string[]> = {
  telegram: [
    "Open BotFather in Telegram, send /revoke and pick the bot. That is the command for cancelling a token. If your BotFather does not offer it, send /token instead.",
    "Telegram's own docs name /token for a compromised or lost token: it generates a new one, and its tutorial says a token can be revoked at any time through BotFather. We could not find /revoke on Telegram's documentation pages, so check that the old token no longer works.",
    "Put the new token in your agent's config, restart it, and delete the old one from every file, chat and note it was in.",
    "If the token was ever in a public repository, treat it as leaked even if you deleted it later. Git history keeps it.",
  ],
  discord: [
    "Open the Developer Portal, pick the application, go to the Bot page and reset the token. The old one stops working.",
    "Discord shows the new token once. Copy it straight into your agent's config and restart the agent.",
    "Delete the old token from every file, chat and note it was in.",
    "If the token was ever in a public repository, treat it as leaked even if you deleted it later. Git history keeps it.",
  ],
};

// ---- Share links ------------------------------------------------------------------------------
// Only two allow-listed answers go in the address: the platform and the ticked permissions. The
// Application ID and any token are free text and never leave the page.

export const BOT_CONNECT_PARAM_KEYS: readonly string[] = ["platform", "perms"] as const;

export interface WizardLinkState {
  platform: Platform;
  permissions: PermissionKey[];
}

export const DEFAULT_LINK_STATE: WizardLinkState = { platform: DEFAULT_PLATFORM, permissions: [...MINIMAL_PERMISSIONS].sort(byCanon) };

function byCanon(a: PermissionKey, b: PermissionKey): number {
  return PERMISSION_KEYS.indexOf(a) - PERMISSION_KEYS.indexOf(b);
}

export function parseBotConnectParams(search: string): WizardLinkState {
  const params = new URLSearchParams(search);
  const platformRaw = params.get("platform");
  const platform = PLATFORMS.find((p) => p === platformRaw) ?? DEFAULT_PLATFORM;
  const permsRaw = params.get("perms");
  const permissions = permsRaw === null ? DEFAULT_LINK_STATE.permissions : normalisePermissions(permsRaw.split(","));
  return { platform, permissions };
}

/** Defaults are left out, so the plain page keeps a plain address. Permissions are written in canonical order. */
export function serializeBotConnectParams(state: WizardLinkState): string {
  const out = new URLSearchParams();
  if (state.platform !== DEFAULT_PLATFORM) out.set("platform", state.platform);
  const perms = normalisePermissions(state.permissions);
  const isDefault = perms.length === DEFAULT_LINK_STATE.permissions.length && perms.every((k, i) => k === DEFAULT_LINK_STATE.permissions[i]);
  if (!isDefault) out.set("perms", perms.join(","));
  return out.toString().replace(/%2C/g, ",");
}
