/** @jest-environment node */
import {
  CHANNEL_WAKE_CHANNEL_NAMES,
  channelWakeActsFor,
  channelWakeArmSecret,
  channelWakeCleanupEnabled,
  channelWakeHostAllowed,
  channelWakeSecret,
  parseChannelWakeChannels,
  parseChannelWakeMode,
  resolveChannelWakeConfig,
} from "../config";

const LONG = "s".repeat(40);
const SHORT = "s".repeat(31);
const AGENT = "11111111-2222-4333-8444-555555555555";
const ARM_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ARM_B = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const env = (mode: string | undefined, channels: string | undefined, seed: string | undefined) => ({
  HIVRA_CHANNEL_WAKE: mode,
  HIVRA_CHANNEL_WAKE_CHANNELS: channels,
  HIVRA_CHANNEL_WAKE_SECRET: seed,
});

describe("channel wake switches", () => {
  it("parses the mode and the channel list, dropping unknown names", () => {
    expect(parseChannelWakeMode(undefined)).toBe("off");
    expect(parseChannelWakeMode(" ON ")).toBe("on");
    expect(parseChannelWakeMode("true")).toBe("off");
    expect([...parseChannelWakeChannels(" Matrix , email,irc,,")].sort()).toEqual(["email", "matrix"]);
    expect(parseChannelWakeChannels(undefined).size).toBe(0);
    expect(parseChannelWakeChannels("all").size).toBe(0);
  });

  it("is off unless the mode, a long enough secret and a known channel are all set", () => {
    expect(resolveChannelWakeConfig({})).toBeNull();
    expect(resolveChannelWakeConfig(env("off", "email", LONG))).toBeNull();
    expect(resolveChannelWakeConfig(env("canary", "email", SHORT))).toBeNull();
    expect(resolveChannelWakeConfig(env("canary", "email", undefined))).toBeNull();
    expect(resolveChannelWakeConfig(env("canary", "", LONG))).toBeNull();
    expect(resolveChannelWakeConfig(env("canary", "irc", LONG))).toBeNull();
    const config = resolveChannelWakeConfig({ ...env("canary", "email", LONG), HIVRA_CHANNEL_WAKE_BASE_URL: "https://example.test/hooks/" });
    expect(config?.mode).toBe("canary");
    expect([...config!.channels]).toEqual(["email"]);
    expect(config?.baseUrl).toBe("https://example.test/hooks");
    expect(resolveChannelWakeConfig({ ...env("on", "email", LONG), HIVRA_CHANNEL_WAKE_BASE_URL: "http://example.test" })?.baseUrl).toBeNull();
  });

  it("cleans up whenever the secret is configured, even with the mode off", () => {
    expect(channelWakeCleanupEnabled({})).toBe(false);
    expect(channelWakeCleanupEnabled(env(undefined, undefined, SHORT))).toBe(false);
    expect(channelWakeCleanupEnabled(env("off", undefined, LONG))).toBe(true);
    expect(channelWakeSecret(env("off", undefined, LONG))).toBe(LONG);
    expect(channelWakeSecret(env("on", "email", SHORT))).toBeNull();
  });

  it("lets canary act only on hosts whose sleep_mode is canary or on", () => {
    for (const hostMode of [undefined, null, "off", "observe", "ON"]) {
      expect(channelWakeHostAllowed({ mode: "canary" }, hostMode)).toBe(false);
      expect(channelWakeHostAllowed({ mode: "on" }, hostMode)).toBe(true);
    }
    expect(channelWakeHostAllowed({ mode: "canary" }, "canary")).toBe(true);
    expect(channelWakeHostAllowed({ mode: "canary" }, "on")).toBe(true);
  });

  // Every combination of mode, secret, list, channel, opt-in and host.
  const MODES = [undefined, "off", "canary", "on"];
  const SEEDS = [undefined, SHORT, LONG];
  const LISTS = [undefined, "", "email", "email,matrix", "irc"];
  const CHANNELS = ["email", "matrix", "irc", 7];
  const ROWS = [null, {}, { enabled: false }, { enabled: "true" }, { enabled: true }];
  const HOSTS = [null, { sleep_mode: "off" }, { sleep_mode: "observe" }, { sleep_mode: "canary" }, { sleep_mode: "on" }];
  for (const mode of MODES) for (const seed of SEEDS) for (const list of LISTS) {
    it(`mode=${String(mode)} secret=${seed?.length ?? "unset"} channels=${String(list)}`, () => {
      const e = env(mode, list, seed);
      const configured = (mode === "canary" || mode === "on") && seed === LONG
        && String(list ?? "").split(",").some((name) => name === "email" || name === "matrix");
      for (const channel of CHANNELS) for (const row of ROWS) for (const host of HOSTS) {
        const listed = typeof channel === "string" && String(list ?? "").split(",").includes(channel) && channel !== "irc";
        const optedIn = row !== null && (row as { enabled?: unknown }).enabled === true;
        const hostOk = mode === "on" || host?.sleep_mode === "canary" || host?.sleep_mode === "on";
        const expected = configured && listed && optedIn && hostOk;
        expect(channelWakeActsFor(channel, row, host, e)).toBe(expected);
        const config = resolveChannelWakeConfig(e);
        if (config) expect(channelWakeActsFor(channel, row, host, config)).toBe(expected);
      }
    });
  }

  it("acts nowhere when given no config", () => {
    expect(channelWakeActsFor("email", { enabled: true }, { sleep_mode: "on" }, null)).toBe(false);
  });

  it("derives a per-arm secret that changes with the arm and the channel", () => {
    const a = channelWakeArmSecret(LONG, "matrix", AGENT, ARM_A);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(channelWakeArmSecret(LONG, "matrix", AGENT.toUpperCase(), ARM_A)).toBe(a);
    expect(channelWakeArmSecret(LONG, "matrix", AGENT, ARM_B)).not.toBe(a);
    expect(channelWakeArmSecret(LONG, "email", AGENT, ARM_A)).not.toBe(a);
    expect(channelWakeArmSecret("t".repeat(40), "matrix", AGENT, ARM_A)).not.toBe(a);
    expect(() => channelWakeArmSecret(LONG, "matrix", "nope", ARM_A)).toThrow();
    expect(() => channelWakeArmSecret(LONG, "irc" as never, AGENT, ARM_A)).toThrow();
  });

  it("knows telegram, email, matrix, whatsapp_cloud, discord and slack", () => {
    expect([...CHANNEL_WAKE_CHANNEL_NAMES]).toEqual(["telegram", "email", "matrix", "whatsapp_cloud", "discord", "slack"]);
  });
});
