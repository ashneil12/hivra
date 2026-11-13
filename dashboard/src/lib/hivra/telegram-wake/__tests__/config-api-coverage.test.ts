/** @jest-environment node */
import {
  isAgentUuid,
  parseTelegramWakeBaseUrl,
  resolveTelegramWakeConfig,
  telegramWakeCleanupEnabled,
  telegramWakeHostAllowed,
  telegramWakeSecretToken,
  telegramWakeWebhookUrl,
} from "../config";
import {
  TELEGRAM_API_BASE,
  callTelegram,
  telegramDeleteWebhook,
  telegramGetBot,
  telegramGetWebhook,
  telegramSetWakeWebhook,
  telegramTokenFingerprint,
} from "../bot-api";
import { telegramCoverageBlockers, telegramWakeCoverage, type TelegramCoverageInput } from "../coverage";
import { buildIdleProbeHostScript, buildSleepHostScript } from "../../agent-sleep-scripts";
import { IDLE_PROBE_TELEGRAM_PROGRAM } from "../../sleep/idle-probe-program";
import { shellQuote } from "../../proxmox-target";

const sample = [String(7_000_000_000 + 4321), "Ab_-".repeat(9)].join(":");
const AGENT = "11111111-1111-4111-8111-111111111111";
const ARM = "22222222-2222-4222-8222-222222222222";
const material = "x".repeat(40);
const base = "https://hooks.example.test/api/webhooks/telegram-wake";

describe("config", () => {
  const full = { HIVRA_TELEGRAM_WAKE: "canary", HIVRA_TELEGRAM_WAKE_SECRET: material, HIVRA_TELEGRAM_WAKE_BASE_URL: `${base}/` };

  it("is off unless every setting is there", () => {
    expect(resolveTelegramWakeConfig({})).toBeNull();
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE: "off" })).toBeNull();
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE: "yes" })).toBeNull();
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE_SECRET: undefined })).toBeNull();
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE_SECRET: "short" })).toBeNull();
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE_BASE_URL: undefined })).toBeNull();
    expect(resolveTelegramWakeConfig(full)).toEqual({ mode: "canary", secret: material, baseUrl: base });
    expect(resolveTelegramWakeConfig({ ...full, HIVRA_TELEGRAM_WAKE: " ON " })?.mode).toBe("on");
  });

  it("accepts only a plain https base URL", () => {
    expect(parseTelegramWakeBaseUrl("http://hooks.example.test/x")).toBeNull();
    expect(parseTelegramWakeBaseUrl("https://u:p@hooks.example.test/x")).toBeNull();
    expect(parseTelegramWakeBaseUrl("https://hooks.example.test/x?a=1")).toBeNull();
    expect(parseTelegramWakeBaseUrl("https://hooks.example.test:8443/x")).toBeNull();
    expect(parseTelegramWakeBaseUrl("not a url")).toBeNull();
  });

  it("cleans up whenever the secret is set, even with the mode off", () => {
    expect(telegramWakeCleanupEnabled({})).toBe(false);
    expect(telegramWakeCleanupEnabled({ HIVRA_TELEGRAM_WAKE_SECRET: material })).toBe(true);
  });

  it("canary acts only on canary or on hosts", () => {
    const config = resolveTelegramWakeConfig(full)!;
    expect(telegramWakeHostAllowed(config, "canary")).toBe(true);
    expect(telegramWakeHostAllowed(config, "on")).toBe(true);
    expect(telegramWakeHostAllowed(config, "off")).toBe(false);
    expect(telegramWakeHostAllowed(config, null)).toBe(false);
    expect(telegramWakeHostAllowed({ ...config, mode: "on" }, "off")).toBe(true);
  });

  it("derives a per-arm secret that changes with the arm and fits Telegram's rule", () => {
    const one = telegramWakeSecretToken(material, AGENT, ARM);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(telegramWakeSecretToken(material, AGENT, ARM)).toBe(one);
    expect(telegramWakeSecretToken(material, AGENT, "33333333-3333-4333-8333-333333333333")).not.toBe(one);
    expect(telegramWakeSecretToken("y".repeat(40), AGENT, ARM)).not.toBe(one);
  });

  it("builds the webhook URL from the base and the agent id only", () => {
    expect(telegramWakeWebhookUrl({ baseUrl: base }, AGENT)).toBe(`${base}/${AGENT}`);
    expect(() => telegramWakeWebhookUrl({ baseUrl: base }, "../x")).toThrow();
    expect(isAgentUuid(AGENT)).toBe(true);
    expect(isAgentUuid("x")).toBe(false);
  });
});

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("bot api", () => {
  it("posts to the public API with the method and JSON parameters", async () => {
    const fetchImpl = jest.fn(() => reply(200, { ok: true, result: true }));
    await telegramDeleteWebhook(sample, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${sample}/deleteWebhook`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ drop_pending_updates: false });
  });

  it("sets the wake webhook with one connection and no update filter or drop", async () => {
    const fetchImpl = jest.fn(() => reply(200, { ok: true, result: true }));
    const result = await telegramSetWakeWebhook(sample, { url: `${base}/${AGENT}`, secretToken: "s".repeat(64) }, { fetchImpl });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ url: `${base}/${AGENT}`, secret_token: "s".repeat(64), max_connections: 1 });
  });

  it("reads the webhook address and the bot id", async () => {
    await expect(telegramGetWebhook(sample, { fetchImpl: () => reply(200, { ok: true, result: { url: "", pending_update_count: 2 } }) }))
      .resolves.toMatchObject({ ok: true, result: { url: "", pendingUpdates: 2 } });
    await expect(telegramGetBot(sample, { fetchImpl: () => reply(200, { ok: true, result: { id: 42 } }) }))
      .resolves.toMatchObject({ ok: true, result: { id: 42 } });
    await expect(telegramGetBot(sample, { fetchImpl: () => reply(200, { ok: true, result: {} }) }))
      .resolves.toMatchObject({ ok: false, reason: "bad_response" });
  });

  it("reduces every failure to a code, with retry_after from a 429", async () => {
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => reply(429, { ok: false, parameters: { retry_after: 17 } }) }))
      .resolves.toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfterS: 17 });
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => reply(401, { ok: false }) }))
      .resolves.toMatchObject({ reason: "unauthorized" });
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => reply(400, { ok: false, description: `bad ${sample}` }) }))
      .resolves.toEqual({ ok: false, reason: "rejected", status: 400 });
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => reply(200, "<html>") }))
      .resolves.toMatchObject({ reason: "bad_response" });
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => Promise.reject(new Error(`boom ${sample}`)) }))
      .resolves.toEqual({ ok: false, reason: "network", status: 0 });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(callTelegram(sample, "getMe", {}, { fetchImpl: () => Promise.reject(timeout) }))
      .resolves.toMatchObject({ reason: "timeout" });
  });

  it("never calls out with a malformed token", async () => {
    const fetchImpl = jest.fn();
    await expect(callTelegram("nope", "getMe", {}, { fetchImpl })).resolves.toMatchObject({ reason: "bad_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fingerprints without revealing the token", () => {
    const fp = telegramTokenFingerprint(sample);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(sample).not.toContain(fp);
  });
});

describe("coverage table", () => {
  const FP = "0123456789abcdef";
  const good = (): TelegramCoverageInput => ({
    configured: true,
    hostAllowed: true,
    row: { enabled: true, tokenFp: FP, hasToken: true, blockedUntil: null },
    probe: {
      liveChannels: ["hermes:telegram"],
      telegram: { hermesFp: FP, hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false },
    },
    nowMs: Date.parse("2026-11-13T10:00:00Z"),
  });

  it("covers Hermes Telegram when every condition holds", () => {
    expect(telegramWakeCoverage(good())).toEqual(["hermes:telegram"]);
    expect(telegramCoverageBlockers(good())).toEqual([]);
  });

  const cases: Array<[string, (i: TelegramCoverageInput) => void, string]> = [
    ["switch not configured", (i) => { i.configured = false; }, "not_configured"],
    ["host not allowed", (i) => { i.hostAllowed = false; }, "host_not_allowed"],
    ["no row", (i) => { i.row = null; }, "not_opted_in"],
    ["owner opted out", (i) => { i.row!.enabled = false; }, "not_opted_in"],
    ["no stored token", (i) => { i.row!.hasToken = false; }, "no_token"],
    ["blocked", (i) => { i.row!.blockedUntil = "2026-11-14T10:00:00Z"; }, "blocked"],
    ["unreadable block", (i) => { i.row!.blockedUntil = "soon"; }, "blocked"],
    ["no probe", (i) => { i.probe = null; }, "no_probe"],
    ["another channel", (i) => { i.probe!.liveChannels = ["hermes:telegram", "openclaw:telegram"]; }, "other_channel"],
    ["gateway down", (i) => { i.probe!.liveChannels = ["hermes:telegram:down"]; }, "other_channel"],
    ["no Telegram facts", (i) => { i.probe!.telegram = null; }, "no_telegram_facts"],
    ["token not in .env", (i) => { i.probe!.telegram!.hermesTokenInEnv = false; }, "token_not_in_env"],
    ["token changed", (i) => { i.probe!.telegram!.hermesFp = "fedcba9876543210"; }, "token_changed"],
    ["webhook mode", (i) => { i.probe!.telegram!.hermesWebhookMode = true; }, "hermes_webhook_mode"],
    ["token in config.yaml", (i) => { i.probe!.telegram!.hermesConfigToken = true; }, "token_in_config"],
  ];
  it.each(cases)("covers nothing when %s", (_name, change, reason) => {
    const input = good();
    change(input);
    expect(telegramWakeCoverage(input)).toEqual([]);
    expect(telegramCoverageBlockers(input)).toContain(reason);
  });

  it("an expired block no longer counts", () => {
    const input = good();
    input.row!.blockedUntil = "2026-11-12T10:00:00Z";
    expect(telegramWakeCoverage(input)).toEqual(["hermes:telegram"]);
  });
});

describe("sleep scripts with coverage", () => {
  const target = { vmid: 1234, bindingTag: "tag-1" };
  it("runs the Telegram probe and passes the checked facts to the host gate", () => {
    const script = buildSleepHostScript({
      ...target, tier: "nap", manual: false,
      telegramCoverage: { channels: ["hermes:telegram"], fingerprint: "0123456789abcdef" },
    });
    expect(script).toContain(`PROBE_PROGRAM=${shellQuote(IDLE_PROBE_TELEGRAM_PROGRAM)}`);
    expect(script).toContain("HIVRA_COVERED_CHANNELS='hermes:telegram'");
    expect(script).toContain("HIVRA_TG_FP='0123456789abcdef'");
    expect(script).toContain('HIVRA_COVERED_CHANNELS="$HIVRA_COVERED_CHANNELS" HIVRA_TG_FP="$HIVRA_TG_FP"');
    expect(buildIdleProbeHostScript(target, { telegram: true })).toContain(shellQuote(IDLE_PROBE_TELEGRAM_PROGRAM));
  });

  it("refuses coverage outside the allowlist or without a fingerprint", () => {
    for (const telegramCoverage of [
      { channels: ["hermes:discord"], fingerprint: "0123456789abcdef" },
      { channels: [], fingerprint: "0123456789abcdef" },
      { channels: ["hermes:telegram"], fingerprint: "nope" },
      { channels: ["hermes:telegram", "hermes:telegram"], fingerprint: "0123456789abcdef" },
    ]) {
      expect(() => buildSleepHostScript({ ...target, tier: "nap", manual: false, telegramCoverage })).toThrow();
    }
  });
});
