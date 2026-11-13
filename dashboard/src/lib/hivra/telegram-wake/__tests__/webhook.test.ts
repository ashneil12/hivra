/** @jest-environment node */
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockAgent = jest.fn();
const mockEnsure = jest.fn();
jest.mock("../../agent-wake", () => ({
  readHivraAgentRow: (...a: unknown[]) => mockAgent(...a),
  ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a),
}));
type Row = Record<string, unknown> & { state: string };
let stored: Row | null = null;
jest.mock("../store", () => ({
  readTelegramWakeRow: async () => stored,
  tryReadTelegramWakeRow: async () => stored,
  updateTelegramWakeRow: async (_id: string, from: string[], patch: Record<string, unknown>) => {
    if (!stored || !from.includes(stored.state)) return false;
    Object.assign(stored, patch);
    return true;
  },
}));

import { encryptSecret } from "@/lib/crypto";
import { handleTelegramWakeCall } from "../webhook";

const AGENT = "11111111-1111-4111-8111-111111111111";
const sample = [String(7_000_000_000 + 4321), "Ab_-".repeat(9)].join(":");

beforeAll(() => { process.env.ENCRYPTION_KEY = "ef".repeat(32); });
beforeEach(() => {
  jest.clearAllMocks();
  stored = { agent_id: AGENT, state: "armed", token_enc: encryptSecret(sample), arm_id: "a" };
  mockEnsure.mockResolvedValue({ state: "awake" });
});

describe("handleTelegramWakeCall", () => {
  it("wakes an asleep agent whose bot is armed, with the telegram trigger", async () => {
    mockAgent.mockResolvedValue({ status: "running", sleep_state: "napping", operation_id: null });
    await expect(handleTelegramWakeCall(AGENT)).resolves.toBe("woke");
    expect(mockEnsure).toHaveBeenCalledWith(AGENT, expect.objectContaining({ trigger: "telegram" }));
  });

  it("takes a stray webhook down when the agent is already awake", async () => {
    mockAgent.mockResolvedValue({ status: "running", sleep_state: "awake", operation_id: null });
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    await expect(handleTelegramWakeCall(AGENT, { fetchImpl })).resolves.toBe("disarmed");
    expect(stored!.state).toBe("idle");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("leaves things alone while a wake holds the agent, or when the row is idle", async () => {
    mockAgent.mockResolvedValue({ status: "running", sleep_state: "waking", operation_id: "op" });
    await expect(handleTelegramWakeCall(AGENT)).resolves.toBe("nothing");
    stored!.state = "idle";
    mockAgent.mockResolvedValue({ status: "running", sleep_state: "napping", operation_id: null });
    await expect(handleTelegramWakeCall(AGENT)).resolves.toBe("nothing");
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
