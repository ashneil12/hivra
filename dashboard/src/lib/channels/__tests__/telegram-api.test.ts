import {
  isValidBotTokenShape,
  isValidOwnerIdShape,
  telegramGetMe,
  telegramStartLink,
} from "../telegram-api";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("telegram-api shapes", () => {
  it("validates bot token shape", () => {
    expect(isValidBotTokenShape("123456789:AAH1234567890abcdefABCDEF-_ghijklmno")).toBe(true);
    expect(isValidBotTokenShape("not-a-token")).toBe(false);
    expect(isValidBotTokenShape("123:short")).toBe(false);
    expect(isValidBotTokenShape("  123456789:AAH1234567890abcdefABCDEF-_ghijklmno  ")).toBe(true);
  });

  it("validates owner id shape", () => {
    expect(isValidOwnerIdShape("987654321")).toBe(true);
    expect(isValidOwnerIdShape("12")).toBe(false);
    expect(isValidOwnerIdShape("abc")).toBe(false);
  });

  it("builds a start deep link", () => {
    expect(telegramStartLink("atlas_bot")).toBe("https://t.me/atlas_bot?start=connect");
    expect(telegramStartLink("atlas_bot", "hivra")).toBe("https://t.me/atlas_bot?start=hivra");
  });

  it("URL-encodes setup-token payloads (deeplink-safe)", () => {
    // bux's setup token alphabet is [A-Za-z0-9_-] (Bot API restriction), but we
    // still encode defensively so a future operator-pasted payload can't break
    // the URL.
    expect(telegramStartLink("atlas_bot", "abc 123")).toBe("https://t.me/atlas_bot?start=abc%20123");
  });
});

describe("telegramGetMe", () => {
  const validToken = "123456789:AAH1234567890abcdefABCDEF-_ghijklmno";

  it("rejects a malformed token without calling Telegram", async () => {
    const fetchImpl = jest.fn();
    const info = await telegramGetMe("nope", fetchImpl as unknown as typeof fetch);
    expect(info.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the bot username on success", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, result: { id: 7, username: "atlas_bot" } }));
    const info = await telegramGetMe(validToken, fetchImpl as unknown as typeof fetch);
    expect(info).toEqual({ ok: true, username: "atlas_bot", botId: 7, error: null });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/bot${validToken}/getMe`),
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("returns the friendly reachability error when the request times out / aborts", async () => {
    // AbortSignal.timeout rejects with a DOMException named "TimeoutError"; a
    // blackholed api.telegram.org surfaces here. The bare-fetch version used to
    // hang forever — this asserts it now fails closed with an actionable error.
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    const info = await telegramGetMe(validToken, fetchImpl as unknown as typeof fetch);
    expect(info.ok).toBe(false);
    expect(info.error).toMatch(/Couldn't reach Telegram/);
  });

  it("surfaces Telegram's rejection description", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, { ok: false, description: "Unauthorized" }));
    const info = await telegramGetMe(validToken, fetchImpl as unknown as typeof fetch);
    expect(info.ok).toBe(false);
    expect(info.error).toMatch(/Unauthorized/);
  });
});
