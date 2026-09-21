import { getOpenPendingPrompts } from "../instance-pending-prompts";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

// Chain: from().select().in().is().gt().order().limit()
function mockQuery(options: { data?: unknown[] | null; error?: unknown; reject?: Error }) {
  const limitMock = options.reject
    ? jest.fn().mockRejectedValue(options.reject)
    : jest.fn().mockResolvedValue({ data: options.data ?? null, error: options.error ?? null });
  const orderMock = jest.fn().mockReturnValue({ limit: limitMock });
  const gtMock = jest.fn().mockReturnValue({ order: orderMock });
  const isMock = jest.fn().mockReturnValue({ gt: gtMock });
  const inMock = jest.fn().mockReturnValue({ is: isMock });
  const selectMock = jest.fn().mockReturnValue({ in: inMock });
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select: selectMock });
  return { selectMock, inMock, isMock, gtMock, orderMock, limitMock };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: "inst-1",
    prompt_id: "call-a",
    kind: "approval",
    summary: "Recursive delete",
    surface: "gateway",
    created_at: "2026-07-09T10:00:00.000Z",
    expires_at: "2026-07-09T11:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("getOpenPendingPrompts", () => {
  it("returns {} for an empty id list without touching the DB", async () => {
    const res = await getOpenPendingPrompts([]);
    expect(res).toEqual({});
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("filters to open rows: resolved_at null AND expires_at > now", async () => {
    const { isMock, gtMock } = mockQuery({ data: [row()] });
    await getOpenPendingPrompts(["inst-1"]);
    expect(isMock).toHaveBeenCalledWith("resolved_at", null);
    expect(gtMock.mock.calls[0][0]).toBe("expires_at");
  });

  it("maps a row into the chip shape keyed by instance id", async () => {
    mockQuery({ data: [row()] });
    const res = await getOpenPendingPrompts(["inst-1"]);
    expect(res["inst-1"]).toEqual({
      promptId: "call-a",
      kind: "approval",
      summary: "Recursive delete",
      surface: "gateway",
      createdAt: "2026-07-09T10:00:00.000Z",
      expiresAt: "2026-07-09T11:00:00.000Z",
    });
  });

  it("keeps only the newest row per instance (first wins, desc order)", async () => {
    mockQuery({
      data: [
        row({ prompt_id: "newest", created_at: "2026-07-09T10:05:00.000Z" }),
        row({ prompt_id: "older", created_at: "2026-07-09T10:00:00.000Z" }),
      ],
    });
    const res = await getOpenPendingPrompts(["inst-1"]);
    expect(res["inst-1"].promptId).toBe("newest");
  });

  it("normalizes an unknown kind to approval", async () => {
    mockQuery({ data: [row({ kind: "weird" })] });
    const res = await getOpenPendingPrompts(["inst-1"]);
    expect(res["inst-1"].kind).toBe("approval");
  });

  it("dedupes and trims the input ids", async () => {
    const { inMock } = mockQuery({ data: [] });
    await getOpenPendingPrompts([" inst-1 ", "inst-1", "inst-2", ""]);
    expect(inMock).toHaveBeenCalledWith("instance_id", ["inst-1", "inst-2"]);
  });

  it("degrades to {} on a query error (never throws)", async () => {
    mockQuery({ error: { message: "boom" } });
    expect(await getOpenPendingPrompts(["inst-1"])).toEqual({});
  });

  it("degrades to {} on an unexpected rejection", async () => {
    mockQuery({ reject: new Error("network") });
    expect(await getOpenPendingPrompts(["inst-1"])).toEqual({});
  });
});
