import {
  AGENT_KEYS,
  AGENT_PLACEMENTS,
  BOT_CONNECT_FACTS,
  DEFAULT_LINK_STATE,
  LEAK_STEPS,
  MINIMAL_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_KEYS,
  PLATFORMS,
  STEPS,
  THREAD_PERMISSIONS,
  buildInviteUrl,
  checkDiscordToken,
  checkTelegramToken,
  checkToken,
  decodeBase64Url,
  isApplicationId,
  normalisePermissions,
  parseBotConnectParams,
  permissionBit,
  permissionsInteger,
  serializeBotConnectParams,
  startHrefFor,
  type PermissionKey,
} from "../bot-connect-wizard";
import { BOT_CONNECT_WIZARD_ENTRY, EXAMPLE_APPLICATION_ID, EXAMPLE_TELEGRAM_SHAPE } from "../bot-connect-wizard-entry";
import { findBannedClaims } from "../../copy-rules";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { agentDeployHref, getAgentSeoEntry, unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { splitFaqCode } from "../../faq-code";

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

// Built at run time so no token-shaped literal sits in the source.
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const discordToken = (id = "123456789012345678", second = "AbCdEf", third = "x".repeat(27)) => `${b64(id)}.${second}.${third}`;
const telegramToken = (secret = "A".repeat(35), id = "1234567890") => `${id}:${secret}`;

// Discord's documented permission table (docs.discord.com/developers/topics/permissions, 2026-11-12): name, hex value.
const DOCUMENTED: Record<string, string> = {
  CREATE_INSTANT_INVITE: "0x1",
  ADMINISTRATOR: "0x8",
  ADD_REACTIONS: "0x40",
  VIEW_CHANNEL: "0x400",
  SEND_MESSAGES: "0x800",
  MANAGE_MESSAGES: "0x2000",
  EMBED_LINKS: "0x4000",
  ATTACH_FILES: "0x8000",
  READ_MESSAGE_HISTORY: "0x10000",
  MENTION_EVERYONE: "0x20000",
  USE_EXTERNAL_EMOJIS: "0x40000",
  USE_APPLICATION_COMMANDS: "0x80000000",
  CREATE_PUBLIC_THREADS: "0x800000000",
  CREATE_PRIVATE_THREADS: "0x1000000000",
  SEND_MESSAGES_IN_THREADS: "0x4000000000",
};

describe("permission bit math", () => {
  it("matches Discord's documented table for every permission offered", () => {
    for (const p of PERMISSIONS) {
      const documented = DOCUMENTED[p.discordName];
      expect({ name: p.discordName, hex: documented }).toEqual({ name: p.discordName, hex: expect.any(String) });
      expect(permissionBit(p.key)).toBe(BigInt(documented));
      expect(BigInt(1) << BigInt(p.bit)).toBe(BigInt(documented));
    }
  });

  it("has unique keys and unique bits", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSIONS.length);
    expect(new Set(PERMISSIONS.map((p) => p.bit)).size).toBe(PERMISSIONS.length);
  });

  it("sums bits above 32 without overflow", () => {
    expect(permissionsInteger(["sendMessagesInThreads"])).toBe("274877906944");
    expect(permissionsInteger(["createPublicThreads"])).toBe("34359738368");
    expect(permissionsInteger(["useApplicationCommands"])).toBe("2147483648");
  });

  it("reproduces the integers the Hermes docs list for the same sets", () => {
    expect(permissionsInteger(MINIMAL_PERMISSIONS)).toBe("117760");
    expect(permissionsInteger(THREAD_PERMISSIONS)).toBe("309237763136");
  });

  it("counts a duplicate once and an empty set as zero", () => {
    expect(permissionsInteger(["sendMessages", "sendMessages"])).toBe("2048");
    expect(permissionsInteger([])).toBe("0");
  });

  it("normalises to canonical order and drops unknown values", () => {
    expect(normalisePermissions(["attachFiles", "nope", "viewChannel", "viewChannel"])).toEqual(["viewChannel", "attachFiles"]);
  });
});

describe("invite URL", () => {
  it("builds the documented authorize address with both scopes", () => {
    const r = buildInviteUrl("123456789012345678", MINIMAL_PERMISSIONS);
    expect(r.url).toBe("https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=117760");
    expect(r.problem).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("asks for the Application ID, and rejects what is not one", () => {
    expect(buildInviteUrl("", MINIMAL_PERMISSIONS).url).toBeNull();
    expect(buildInviteUrl("", MINIMAL_PERMISSIONS).problem).toMatch(/Paste your Application ID/);
    for (const bad of ["abc", "1234", "12345678901234567890123", "1234567890123456a8", "https://x.test/12345678901234567"]) {
      const r = buildInviteUrl(bad, MINIMAL_PERMISSIONS);
      expect(r.url).toBeNull();
      expect(r.problem).toMatch(/17 to 20 digits/);
    }
  });

  it("trims spaces around the id and cannot inject extra query parameters", () => {
    expect(buildInviteUrl("  123456789012345678 ", MINIMAL_PERMISSIONS).url).toContain("client_id=123456789012345678&scope=");
    expect(buildInviteUrl("123456789012345678&scope=admin", MINIMAL_PERMISSIONS).url).toBeNull();
  });

  it("warns about Administrator and about a bot that cannot send", () => {
    expect(buildInviteUrl(EXAMPLE_APPLICATION_ID, ["administrator", "viewChannel", "sendMessages"]).warnings.join(" ")).toMatch(/Administrator/);
    expect(buildInviteUrl(EXAMPLE_APPLICATION_ID, ["viewChannel"]).warnings.join(" ")).toMatch(/cannot see or answer/);
  });

  it("recognises application ids", () => {
    expect(isApplicationId("123456789012345678")).toBe(true);
    expect(isApplicationId("12345678901234567")).toBe(true);
    expect(isApplicationId("1234567890123456")).toBe(false);
  });
});

describe("base64url decoding", () => {
  it("agrees with Buffer for ids", () => {
    for (const id of ["123456789012345678", "98765432109876543", "12345678901234567890"]) expect(decodeBase64Url(b64(id))).toBe(id);
  });
  it("rejects invalid input", () => {
    expect(decodeBase64Url("ab$d")).toBeNull();
    expect(decodeBase64Url("a")).toBeNull();
  });
});

describe("Telegram token shape", () => {
  it("passes digits, a colon and 35 characters", () => {
    expect(checkTelegramToken(telegramToken()).level).toBe("looks-right");
    expect(checkTelegramToken(telegramToken("aB_-9".repeat(7))).level).toBe("looks-right");
    expect(checkTelegramToken(EXAMPLE_TELEGRAM_SHAPE).headline).toBe("The shape is right.");
  });

  it("calls other lengths unusual, not wrong, and mentions Telegram's own 34-character example", () => {
    for (const n of [34, 36, 20]) {
      const r = checkTelegramToken(telegramToken("A".repeat(n)));
      expect(r.level).toBe("unusual");
      expect(r.headline).toContain(`${n} characters`);
      expect(r.details.join(" ")).toMatch(/34/);
    }
  });

  it("marks malformed tokens wrong, each for its own reason", () => {
    expect(checkTelegramToken("1234567890A" + "B".repeat(35)).headline).toMatch(/no colon/i);
    expect(checkTelegramToken("abcdef:" + "A".repeat(35)).headline).toMatch(/not a number/);
    expect(checkTelegramToken("123:" + "A".repeat(35)).headline).toMatch(/not a number/);
    expect(checkTelegramToken("1234567890:A:B").headline).toMatch(/more than one colon/);
    expect(checkTelegramToken("1234567890:AAA$AAA").headline).toMatch(/characters a token never has/);
    expect(checkTelegramToken("1234567890:AAAA BBBB").headline).toMatch(/space or line break/);
  });

  it("recognises a Discord token and a Discord id pasted here", () => {
    expect(checkTelegramToken(discordToken()).headline).toMatch(/Discord token/);
    expect(checkTelegramToken("123456789012345678").headline).toMatch(/Discord ID/);
  });

  it("tidies quotes, spaces, a bot prefix and a whole API address, and says so", () => {
    const quoted = checkTelegramToken(`  "${telegramToken()}" `);
    expect(quoted.level).toBe("looks-right");
    expect(quoted.details.join(" ")).toMatch(/spaces/);
    expect(quoted.details.join(" ")).toMatch(/Quotes/);
    expect(checkTelegramToken(`bot${telegramToken()}`).level).toBe("looks-right");
    const url = checkTelegramToken(`https://api.telegram.org/bot${telegramToken()}/getMe`);
    expect(url.level).toBe("looks-right");
    expect(url.details.join(" ")).toMatch(/Bot API address/);
  });

  it("is empty for blank input", () => {
    expect(checkTelegramToken("").level).toBe("empty");
    expect(checkTelegramToken("   ").level).toBe("empty");
  });
});

describe("Discord token shape", () => {
  it("passes three base64url parts with a decodable id, 6 and 27 or more", () => {
    expect(checkDiscordToken(discordToken()).level).toBe("looks-right");
    expect(checkDiscordToken(discordToken("123456789012345678", "G1hJkL", "y".repeat(38))).level).toBe("looks-right");
  });

  it("calls odd sizes unusual", () => {
    expect(checkDiscordToken(discordToken("123456789012345678", "AbCdEfG")).level).toBe("unusual");
    expect(checkDiscordToken(discordToken("123456789012345678", "AbCdEf", "x".repeat(10))).level).toBe("unusual");
    expect(checkDiscordToken(`${b64("not-a-snowflake")}.AbCdEf.${"x".repeat(27)}`).level).toBe("unusual");
  });

  it("marks the wrong number of parts, odd characters and spaces wrong", () => {
    expect(checkDiscordToken("one.two").headline).toMatch(/2 dot-separated parts/);
    expect(checkDiscordToken("a.b.c.d").headline).toMatch(/4 dot-separated parts/);
    expect(checkDiscordToken("abc.d$f.ghi").headline).toMatch(/characters a token never has/);
    expect(checkDiscordToken("a.b .c").headline).toMatch(/space or line break/);
    expect(checkDiscordToken("a..c").headline).toMatch(/characters a token never has/);
  });

  it("recognises an application id, a public key and a Telegram token", () => {
    expect(checkDiscordToken("123456789012345678").headline).toMatch(/ID, not a token/);
    expect(checkDiscordToken("a".repeat(64)).headline).toMatch(/public key/);
    expect(checkDiscordToken(telegramToken()).headline).toMatch(/Telegram token/);
  });

  it("drops a Bot prefix and quotes, and says so", () => {
    const r = checkDiscordToken(`Bot "${discordToken()}"`);
    expect(r.level).toBe("looks-right");
    expect(r.details.join(" ")).toMatch(/word Bot/);
  });

  it("is empty for blank input", () => {
    expect(checkDiscordToken("").level).toBe("empty");
  });
});

describe("the checker never repeats what it was given", () => {
  it("keeps the input out of every returned string", () => {
    const inputs: [string, string][] = [
      ["telegram", telegramToken("Zq9".repeat(11).slice(0, 35))],
      ["telegram", telegramToken("Zq9".repeat(5))],
      ["telegram", "1234567890:Zq9Zq9$"],
      ["discord", discordToken("123456789012345678", "ZqZqZq", "Mn".repeat(15))],
      ["discord", "Zq9Zq9.Mn8Mn8"],
    ];
    for (const [platform, input] of inputs) {
      const r = checkToken(platform as "telegram" | "discord", input);
      const out = JSON.stringify(r);
      for (const piece of input.split(/[.:]/)) if (piece.length >= 6) expect(out).not.toContain(piece);
    }
  });
});

describe("agent placements", () => {
  it("covers both agents on both platforms with at least one source link", () => {
    for (const agent of AGENT_KEYS) {
      for (const platform of PLATFORMS) {
        const p = AGENT_PLACEMENTS[agent][platform];
        expect(p.steps.length).toBeGreaterThan(0);
        expect(p.commands.length).toBeGreaterThan(0);
        expect(p.docs.url).toMatch(/^https:\/\//);
        expect(BOT_CONNECT_FACTS.sources.map((s) => s.url)).toContain(p.docs.url);
      }
    }
  });

  it("never puts a real-looking token in a command, only a placeholder", () => {
    for (const agent of AGENT_KEYS) {
      for (const platform of PLATFORMS) {
        for (const c of AGENT_PLACEMENTS[agent][platform].commands) {
          expect(checkTelegramToken(c).level).not.toBe("looks-right");
          expect(c).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{30,}/);
        }
      }
    }
  });

  it("uses the names the vendors' docs gave", () => {
    const flat = (a: (typeof AGENT_KEYS)[number], p: (typeof PLATFORMS)[number]) => AGENT_PLACEMENTS[a][p].commands.join("\n");
    expect(flat("hermes", "telegram")).toContain("TELEGRAM_BOT_TOKEN");
    expect(flat("hermes", "telegram")).toContain("TELEGRAM_ALLOWED_USERS");
    expect(flat("hermes", "discord")).toContain("DISCORD_BOT_TOKEN");
    expect(flat("hermes", "discord")).toContain("DISCORD_ALLOWED_USERS");
    expect(flat("openclaw", "telegram")).toContain("openclaw channels add --channel telegram --token");
    expect(flat("openclaw", "telegram")).toContain("openclaw pairing approve telegram");
    expect(flat("openclaw", "discord")).toContain("DISCORD_BOT_TOKEN");
  });

  it("says to see the agent's own docs where OpenClaw Discord details could not be read", () => {
    expect(AGENT_PLACEMENTS.openclaw.discord.steps.join(" ")).toMatch(/see the agent's own docs/i);
  });

  it("starts each agent with its sign-up agentType", () => {
    expect(startHrefFor("hermes")).toBe(`${PUBLIC_START_HREF}?agentType=general`);
    expect(startHrefFor("openclaw")).toBe(`${PUBLIC_START_HREF}?agentType=openclaw`);
    for (const key of AGENT_KEYS) {
      expect(getAgent(key)?.available).toBe(true);
      expect(startHrefFor(key)).toBe(agentDeployHref(getAgentSeoEntry(key)!));
    }
  });
});

describe("steps and leak guidance", () => {
  it("ends both flows at the paste step and has the check step", () => {
    for (const platform of PLATFORMS) {
      const ids = STEPS[platform].map((s) => s.id);
      expect(ids[ids.length - 1]).toBe("paste");
      expect(ids.some((i) => i.endsWith("-check"))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("names the revoke route for each platform", () => {
    expect(LEAK_STEPS.telegram.join(" ")).toMatch(/\/revoke/);
    expect(LEAK_STEPS.telegram.join(" ")).toMatch(/\/token/);
    expect(LEAK_STEPS.discord.join(" ")).toMatch(/reset the token/i);
  });
});

describe("share links", () => {
  it("leaves defaults out", () => {
    expect(serializeBotConnectParams(DEFAULT_LINK_STATE)).toBe("");
    expect(parseBotConnectParams("")).toEqual(DEFAULT_LINK_STATE);
  });

  it("round-trips the platform and the ticked permissions", () => {
    const state = { platform: "discord" as const, permissions: normalisePermissions(["viewChannel", "sendMessages", "addReactions"]) };
    const qs = serializeBotConnectParams(state);
    expect(qs).toBe("platform=discord&perms=viewChannel,sendMessages,addReactions");
    expect(parseBotConnectParams(qs)).toEqual(state);
  });

  it("round-trips an empty permission set", () => {
    const qs = serializeBotConnectParams({ platform: "telegram", permissions: [] });
    expect(parseBotConnectParams(qs).permissions).toEqual([]);
  });

  it("ignores anything outside the allow-list, so free text cannot come in through the address", () => {
    const state = parseBotConnectParams("platform=slack&perms=viewChannel,%3Cscript%3E,token123&token=abc&appId=123456789012345678");
    expect(state.platform).toBe("telegram");
    expect(state.permissions).toEqual(["viewChannel"]);
    expect(serializeBotConnectParams(state)).not.toMatch(/abc|123456789012345678|script/);
  });

  it("has no parameter that could carry a token or an application id", () => {
    const all: PermissionKey[] = [...PERMISSION_KEYS];
    const qs = serializeBotConnectParams({ platform: "discord", permissions: all });
    expect(qs).toMatch(/^platform=discord&perms=[A-Za-z,]+$/);
  });
});

describe("facts table", () => {
  it("is dated and every source is an https page", () => {
    expect(BOT_CONNECT_FACTS.lastVerified).toBe("2026-11-12");
    expect(BOT_CONNECT_FACTS.sources.length).toBeGreaterThanOrEqual(10);
    for (const s of BOT_CONNECT_FACTS.sources) expect(s.url).toMatch(/^https:\/\/[a-z.-]+\//);
  });
});

describe("catalog entry", () => {
  const entry = BOT_CONNECT_WIZARD_ENTRY;

  it("carries the names the task fixed", () => {
    expect(entry.slug).toBe("telegram-discord-bot-setup");
    expect(entry.componentKey).toBe("bot-connect-wizard");
    expect(entry.primaryKeyword).toBe("how to create telegram bot");
  });

  it("keeps titles and the description within limits", () => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/Hivra/);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("has the blocks the page renders", () => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    expect(entry.method!.lastVerified).toBe(BOT_CONNECT_FACTS.lastVerified);
    expect(entry.method!.paragraphs.flatMap((p) => p.sources ?? []).length).toBeGreaterThanOrEqual(6);
    for (const s of entry.method!.paragraphs.flatMap((p) => p.sources ?? [])) expect(s.url).toMatch(/^https:\/\//);
    expect(entry.examples!.length).toBeGreaterThanOrEqual(1);
    expect(entry.vendors.length).toBeGreaterThan(0);
  });

  it("links only to routes the existing catalog tests allow", () => {
    const allowed = new Set([
      "/pricing",
      "/agents/hermes",
      "/agents/openclaw",
      "/compare/openclaw-to-hermes",
      "/compare/vs-self-hosted",
      "/agents/claude-code",
      "/agents/codex",
      "/blog/claude-max-vs-pro-for-claude-code",
      "/blog/codex-resume-session",
      "/tools/hermes-vs-openclaw",
    ]);
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) expect(allowed.has(link.href)).toBe(true);
  });

  it("holds every example output equal to what the builders print", () => {
    expect(entry.examples![0].command).toBe(buildInviteUrl(EXAMPLE_APPLICATION_ID, MINIMAL_PERMISSIONS).url);
    expect(entry.examples![0].command).toContain("permissions=117760");
    expect(entry.examples![1].command).toBe(buildInviteUrl(EXAMPLE_APPLICATION_ID, THREAD_PERMISSIONS).url);
    expect(entry.examples![1].command).toContain("permissions=309237763136");
    expect(entry.examples![2].command).toBe(checkTelegramToken(EXAMPLE_TELEGRAM_SHAPE).headline);
  });

  it("lists every faqCode phrase in an answer", () => {
    const found = new Set<string>();
    for (const faq of entry.faqs) for (const part of splitFaqCode(faq.a, entry.faqCode!)) if (part.code) found.add(part.text);
    expect([...entry.faqCode!].filter((p) => !found.has(p))).toEqual([]);
  });

  it("makes no banned claim in any string of the entry", () => {
    const text = strings(entry).join("\n");
    for (const s of strings(entry)) expect({ s, hits: findBannedClaims(s) }).toEqual({ s, hits: [] });
    expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/free (?:plan|tier|trial)|\$0/i);
  });

  it("makes no banned claim in the placements, steps and leak guidance", () => {
    for (const s of strings([AGENT_PLACEMENTS, STEPS, LEAK_STEPS, BOT_CONNECT_FACTS])) {
      expect({ s, hits: findBannedClaims(s) }).toEqual({ s, hits: [] });
      expect(s).not.toMatch(/[–—]/);
    }
  });
});
