import { buildHtml, buildText, RESOURCE_WATCHDOG_FREE_RAM_SUBJECT, sendFreeRamPressureEmail } from "@/lib/email/resource-watchdog-free-ram";

const mockSend = jest.fn();
jest.mock("resend", () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const params = { email: "fixture@example.com", agentName: "<script>example</script>", avgRamPct: 0.97, ramLimitMb: 2048, windowMinutes: 60, idempotencyKey: "test-owned" };

describe("RAM pause notification", () => {
  const originalKey = process.env.RESEND_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
    jest.clearAllMocks();
  });

  it("explains the actual allocation and monitoring decision without false promises", () => {
    for (const text of [buildText(params), buildHtml(params)]) {
      expect(text).toContain("2 GB");
      expect(text).toContain("Recent monitoring");
      expect(text).toContain("not a usage-time limit");
      expect(text).toContain("unsaved work may be interrupted");
      expect(text).not.toMatch(/held.*last|nothing was lost|ran out of memory|Pro gets|won't hit/);
    }
    expect(RESOURCE_WATCHDOG_FREE_RAM_SUBJECT).toBe("Paused for high memory use");
    expect(buildHtml(params)).not.toContain("<script>");
    expect(buildHtml(params)).toContain("&lt;script&gt;");
  });

  it("does not send without configuration", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await sendFreeRamPressureEmail(params)).toEqual({ sent: false, reason: "not_configured" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("keeps the caller's idempotency key", async () => {
    process.env.RESEND_API_KEY = "test-only";
    mockSend.mockResolvedValue({ error: null });
    expect(await sendFreeRamPressureEmail(params)).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: params.email, subject: RESOURCE_WATCHDOG_FREE_RAM_SUBJECT }), { idempotencyKey: "test-owned" });
  });

  it("contains provider failures", async () => {
    process.env.RESEND_API_KEY = "test-only";
    mockSend.mockRejectedValue(new Error("provider unavailable"));
    expect(await sendFreeRamPressureEmail(params)).toEqual({ sent: false, reason: "send_failed", errorMessage: "provider unavailable" });
  });
});
