/**
 * POST /api/billing/churn-survey tests. The contract this locks in:
 *   - 401 without a Clerk session
 *   - 400 on invalid JSON / unknown reason / oversized detail
 *   - 200 inserts {user_id, plan (from the subscription row), reason, detail}
 *   - detail is optional and stored as null when omitted
 *   - 500 when the insert fails (the client treats this as non-fatal)
 */

import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/churn-survey", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/billing/churn-survey", () => {
  const userId = "user_123";
  let insertMock: jest.Mock;
  let subscriptionRow: { plan: string | null } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });

    subscriptionRow = { plan: "operator" };
    insertMock = jest.fn().mockResolvedValue({ error: null });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: subscriptionRow, error: null }),
            }),
          }),
        };
      }
      if (table === "churn_surveys") {
        return { insert: insertMock };
      }
      throw new Error(`unexpected table ${table}`);
    });
  });

  it("returns 401 without a session", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await POST(makeRequest({ reason: "too_expensive" }));
    expect(res.status).toBe(401);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 400 on an unknown reason", async () => {
    const res = await POST(makeRequest({ reason: "vibes" }));
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 400 when detail exceeds 2000 chars", async () => {
    const res = await POST(
      makeRequest({ reason: "other", detail: "x".repeat(2001) })
    );
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("records reason + detail with the plan read from the subscription row", async () => {
    const res = await POST(
      makeRequest({ reason: "other", detail: "  switching jobs  " })
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.data).toEqual({ recorded: true });
    expect(insertMock).toHaveBeenCalledWith({
      user_id: userId,
      plan: "operator",
      reason: "other",
      detail: "switching jobs",
    });
  });

  it("stores null detail when omitted, and null plan when no subscription row", async () => {
    subscriptionRow = null;
    const res = await POST(makeRequest({ reason: "not_using" }));
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith({
      user_id: userId,
      plan: null,
      reason: "not_using",
      detail: null,
    });
  });

  it("accepts every documented reason", async () => {
    for (const reason of [
      "too_expensive",
      "not_using",
      "missing_feature",
      "something_broke",
      "other",
    ]) {
      const res = await POST(makeRequest({ reason }));
      expect(res.status).toBe(200);
    }
  });

  it("returns 500 when the insert fails", async () => {
    insertMock.mockResolvedValue({ error: { code: "XX000", message: "boom" } });
    const res = await POST(makeRequest({ reason: "too_expensive" }));
    expect(res.status).toBe(500);
  });
});
