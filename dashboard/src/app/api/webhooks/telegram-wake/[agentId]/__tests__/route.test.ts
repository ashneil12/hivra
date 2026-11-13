/** @jest-environment node */
import { NextRequest } from "next/server";

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ log: mockLog }));
const mockReadRow = jest.fn();
jest.mock("@/lib/hivra/telegram-wake/store", () => ({ readTelegramWakeRow: (...a: unknown[]) => mockReadRow(...a) }));
const mockHandle = jest.fn();
jest.mock("@/lib/hivra/telegram-wake/webhook", () => ({ handleTelegramWakeCall: (...a: unknown[]) => mockHandle(...a) }));
const afterTasks: Array<() => unknown> = [];
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (task: () => unknown) => { afterTasks.push(task); } }));

import { GET, POST } from "../route";
import { telegramWakeSecretToken } from "@/lib/hivra/telegram-wake/config";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ARM = "22222222-2222-4222-8222-222222222222";
const material = "x".repeat(40);
const header = () => telegramWakeSecretToken(material, AGENT, ARM);
const body = JSON.stringify({ update_id: 1, message: { text: "a private message to the bot" } });

function call(agentId: string, headers: Record<string, string> = {}, payload: string = body) {
  const req = new NextRequest(`https://hooks.example.test/api/webhooks/telegram-wake/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
  return POST(req, { params: Promise.resolve({ agentId }) });
}

describe("POST /api/webhooks/telegram-wake/[agentId]", () => {
  const saved = process.env.HIVRA_TELEGRAM_WAKE_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    afterTasks.length = 0;
    process.env.HIVRA_TELEGRAM_WAKE_SECRET = material;
    mockReadRow.mockResolvedValue({ agent_id: AGENT, state: "armed", arm_id: ARM });
    mockHandle.mockResolvedValue("woke");
  });
  afterAll(() => { process.env.HIVRA_TELEGRAM_WAKE_SECRET = saved; });

  it("answers 503, never 2xx, and starts the wake after the answer", async () => {
    const response = await call(AGENT, { "x-telegram-bot-api-secret-token": header() });
    expect(response.status).toBe(503);
    expect(mockHandle).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(mockHandle).toHaveBeenCalledWith(AGENT);
  });

  it.each([
    ["no secret header", {}],
    ["a wrong secret", { "x-telegram-bot-api-secret-token": "0".repeat(64) }],
    ["a secret one character short", { "x-telegram-bot-api-secret-token": "" }],
    ["a secret with extra text", { "x-telegram-bot-api-secret-token": "" }],
  ])("refuses %s with 401 and starts nothing", async (name, headers) => {
    const h = { ...headers } as Record<string, string>;
    if (name === "a secret one character short") h["x-telegram-bot-api-secret-token"] = header().slice(0, -1);
    if (name === "a secret with extra text") h["x-telegram-bot-api-secret-token"] = `${header()}0`;
    const response = await call(AGENT, h);
    expect(response.status).toBe(401);
    expect(afterTasks).toHaveLength(0);
  });

  it("answers an unknown agent, an agent never armed, and a bad id the same 401", async () => {
    mockReadRow.mockResolvedValueOnce(null);
    expect((await call(AGENT, { "x-telegram-bot-api-secret-token": header() })).status).toBe(401);
    mockReadRow.mockResolvedValueOnce({ agent_id: AGENT, state: "idle", arm_id: null });
    expect((await call(AGENT, { "x-telegram-bot-api-secret-token": header() })).status).toBe(401);
    expect((await call("not-an-id", { "x-telegram-bot-api-secret-token": header() })).status).toBe(401);
    expect(afterTasks).toHaveLength(0);
  });

  it("refuses everything when the server has no secret", async () => {
    delete process.env.HIVRA_TELEGRAM_WAKE_SECRET;
    expect((await call(AGENT, { "x-telegram-bot-api-secret-token": header() })).status).toBe(401);
    expect(mockReadRow).not.toHaveBeenCalled();
  });

  it("an old arm's secret stops working once the arm changes", async () => {
    mockReadRow.mockResolvedValue({ agent_id: AGENT, state: "armed", arm_id: "33333333-3333-4333-8333-333333333333" });
    expect((await call(AGENT, { "x-telegram-bot-api-secret-token": header() })).status).toBe(401);
  });

  it("answers 503 when the row cannot be read, so Telegram tries again", async () => {
    mockReadRow.mockRejectedValue(new Error("db"));
    expect((await call(AGENT, { "x-telegram-bot-api-secret-token": header() })).status).toBe(503);
    expect(afterTasks).toHaveLength(0);
  });

  it("takes a large body without keeping or logging it", async () => {
    const big = JSON.stringify({ text: "y".repeat(300 * 1024) });
    const response = await call(AGENT, { "x-telegram-bot-api-secret-token": header() }, big);
    expect(response.status).toBe(503);
    mockHandle.mockRejectedValueOnce(new Error("boom"));
    await afterTasks[0]();
    const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls]);
    expect(logged).not.toContain("private message");
    expect(logged).not.toContain("yyyy");
    expect(logged).not.toContain(header());
  });

  it("never answers 2xx, whatever arrives", async () => {
    const statuses = new Set<number>();
    const variants: Array<{ id: string; h: Record<string, string> }> = [
      { id: AGENT, h: { "x-telegram-bot-api-secret-token": header() } },
      { id: AGENT, h: {} },
      { id: AGENT.toUpperCase(), h: { "x-telegram-bot-api-secret-token": header() } },
      { id: "", h: {} },
      { id: "../../etc", h: { "x-telegram-bot-api-secret-token": header() } },
    ];
    for (const row of [null, { state: "armed", arm_id: ARM }, { state: "idle", arm_id: ARM }]) {
      for (const v of variants) {
        mockReadRow.mockResolvedValueOnce(row);
        statuses.add((await call(v.id, v.h, "not json")).status);
      }
    }
    statuses.add((await GET()).status);
    for (const status of statuses) expect(status < 200 || status >= 300).toBe(true);
    expect([...statuses].sort()).toEqual([401, 503]);
  });
});
