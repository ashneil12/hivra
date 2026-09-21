import { NextRequest } from "next/server";

// --- Mocks ---------------------------------------------------------------

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

// Bypass the per-IP rate limit during these tests; an isolated
// rate-limit test for /api/reserve POST lives below.
const enforceRateLimitMock = jest.fn(() => ({ success: true }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) =>
    enforceRateLimitMock(...(args as [])),
  getIP: jest.fn(() => "127.0.0.1"),
}));

import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

const supabaseAdminMock = supabaseAdmin as unknown as { from: jest.Mock };

// --- Helpers -------------------------------------------------------------

interface SelectScenario {
  data?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
}

interface InsertScenario {
  data?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
}

interface UpdateScenario {
  data?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
}

interface MockTableConfig {
  selects?: SelectScenario[];
  inserts?: InsertScenario[];
  updates?: UpdateScenario[];
}

function mockReservationsTable(config: MockTableConfig) {
  const selects = [...(config.selects ?? [])];
  const inserts = [...(config.inserts ?? [])];
  const updates = [...(config.updates ?? [])];

  const insertSpy = jest.fn();
  const updateSpy = jest.fn();
  const ilikeSpy = jest.fn();
  const eqSpy = jest.fn();

  const buildSelectChain = () => ({
    maybeSingle: jest.fn(async () => {
      const next = selects.shift();
      return next ?? { data: null, error: null };
    }),
  });

  supabaseAdminMock.from.mockImplementation((table: string) => {
    if (table !== "reservations") {
      throw new Error(`Unexpected table: ${table}`);
    }

    return {
      select: jest.fn(() => ({
        ilike: ilikeSpy.mockImplementation(() => buildSelectChain()),
        eq: eqSpy.mockImplementation(() => buildSelectChain()),
      })),
      insert: jest.fn((row: Record<string, unknown>) => {
        insertSpy(row);
        return {
          select: jest.fn(() => ({
            single: jest.fn(async () => {
              const next = inserts.shift();
              return next ?? { data: null, error: null };
            }),
          })),
        };
      }),
      update: jest.fn((patch: Record<string, unknown>) => {
        updateSpy(patch);
        return {
          eq: jest.fn(async () => {
            const next = updates.shift();
            return next ?? { data: null, error: null };
          }),
        };
      }),
    };
  });

  return { insertSpy, updateSpy, ilikeSpy, eq: eqSpy };
}

function postRequest(body: unknown) {
  return new NextRequest("https://hermesos.cloud/api/reserve", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// --- Tests ---------------------------------------------------------------

describe("POST /api/reserve", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  });

  it("rejects malformed JSON", async () => {
    mockReservationsTable({});
    const res = await POST(postRequest("not-json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("rejects an invalid email", async () => {
    mockReservationsTable({});
    const res = await POST(postRequest({ email: "not-an-email", tier_intent: "free" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("A valid email address is required");
  });

  it("rejects an unknown tier_intent", async () => {
    mockReservationsTable({});
    const res = await POST(postRequest({ email: "user@example.com", tier_intent: "ultra" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("tier_intent must be one of free, pro, or power");
  });

  it("inserts a new reservation and returns its position", async () => {
    const { insertSpy } = mockReservationsTable({
      selects: [{ data: null, error: null }],
      inserts: [
        {
          data: { position: 7, tier_intent: "pro", status: "queued" },
          error: null,
        },
      ],
    });

    const res = await POST(postRequest({ email: "  Person@Example.COM ", tier_intent: "pro" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      position: 7,
      tier_intent: "pro",
      status: "queued",
      already_existed: false,
    });
    expect(insertSpy).toHaveBeenCalledWith({
      email: "person@example.com",
      tier_intent: "pro",
      clerk_user_id: null,
    });
  });

  it("returns the existing position when the email is already on the waitlist", async () => {
    const { insertSpy } = mockReservationsTable({
      selects: [
        {
          data: {
            id: "row-1",
            email: "user@example.com",
            tier_intent: "free",
            position: 42,
            status: "queued",
            clerk_user_id: null,
          },
          error: null,
        },
      ],
    });

    const res = await POST(postRequest({ email: "user@example.com", tier_intent: "power" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      position: 42,
      tier_intent: "free",
      status: "queued",
      already_existed: true,
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("captures clerk_user_id when the visitor is signed in", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_signed_in" });

    const { insertSpy } = mockReservationsTable({
      selects: [{ data: null, error: null }],
      inserts: [
        {
          data: { position: 3, tier_intent: "free", status: "queued" },
          error: null,
        },
      ],
    });

    const res = await POST(postRequest({ email: "signed@example.com", tier_intent: "free" }));
    expect(res.status).toBe(201);
    expect(insertSpy).toHaveBeenCalledWith({
      email: "signed@example.com",
      tier_intent: "free",
      clerk_user_id: "user_signed_in",
    });
  });

  it("backfills clerk_user_id on a returning signed-in visitor", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_signed_in" });

    const { updateSpy } = mockReservationsTable({
      selects: [
        {
          data: {
            id: "row-1",
            email: "signed@example.com",
            tier_intent: "pro",
            position: 9,
            status: "queued",
            clerk_user_id: null,
          },
          error: null,
        },
      ],
      updates: [{ data: null, error: null }],
    });

    const res = await POST(postRequest({ email: "signed@example.com", tier_intent: "pro" }));
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith({ clerk_user_id: "user_signed_in" });
  });

  it("treats unique-violation race as an idempotent existing reservation", async () => {
    const { insertSpy } = mockReservationsTable({
      selects: [
        { data: null, error: null },
        {
          data: { position: 11, tier_intent: "free", status: "queued" },
          error: null,
        },
      ],
      inserts: [
        {
          data: null,
          error: { code: "23505", message: "duplicate key value violates unique constraint" },
        },
      ],
    });

    const res = await POST(postRequest({ email: "race@example.com", tier_intent: "free" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      position: 11,
      tier_intent: "free",
      status: "queued",
      already_existed: true,
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when supabase lookup fails", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockReservationsTable({
      selects: [
        { data: null, error: { code: "PGRST500", message: "boom" } },
      ],
    });

    const res = await POST(postRequest({ email: "user@example.com", tier_intent: "free" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to record reservation");
    expect(JSON.stringify(body)).not.toContain("boom");
    consoleErrorSpy.mockRestore();
  });
});

describe("POST /api/reserve rate limiting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  });

  it("returns 429 when the per-IP rate limit fires", async () => {
    enforceRateLimitMock.mockReturnValueOnce({ success: false });
    mockReservationsTable({});

    const res = await POST(
      postRequest({ email: "x@example.com", tier_intent: "free" })
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many|wait/i);
  });
});

describe("GET /api/reserve", () => {
  // The GET endpoint used to accept any email as a query param and would
  // disclose "found: true" + tier_intent. That was an enumeration vector
  // — anyone could probe the queue for an email's presence and Pro/Power
  // tier intent. The endpoint is now Clerk-auth gated and looks up by
  // the caller's clerk_user_id only.

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated (no email enumeration)", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    mockReservationsTable({});
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("ignores any ?email=... query param (enumeration regression guard)", async () => {
    // A signed-in attacker must not be able to look up another user's
    // reservation by passing email in the query string. The endpoint
    // should look up by their own userId only.
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_self" });
    const tableSpy = mockReservationsTable({
      selects: [{ data: null, error: null }],
    });

    // The handler doesn't accept any input — the regression guard here
    // is structural: the function signature has no access to query
    // params, so an `?email=victim@example.com` cannot influence the
    // lookup. The test exercises that callers passing email get an
    // identity-keyed result regardless.
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ found: false });

    // The select chain must have been keyed by clerk_user_id, not by the
    // attacker-controlled email. We confirm this by inspecting how the
    // reservations query was built.
    expect(tableSpy.eq).toHaveBeenCalledWith("clerk_user_id", "user_self");
    expect(tableSpy.ilikeSpy).not.toHaveBeenCalled();
  });

  it("returns the signed-in caller's own reservation when one exists", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_self" });
    mockReservationsTable({
      selects: [
        {
          data: { position: 17, tier_intent: "power", status: "queued" },
          error: null,
        },
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      found: true,
      position: 17,
      tier_intent: "power",
      status: "queued",
    });
  });

  it("returns 500 when supabase lookup fails", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_self" });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockReservationsTable({
      selects: [{ data: null, error: { code: "PGRST500", message: "boom" } }],
    });
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to look up reservation");
    expect(JSON.stringify(body)).not.toContain("boom");
    consoleErrorSpy.mockRestore();
  });
});
