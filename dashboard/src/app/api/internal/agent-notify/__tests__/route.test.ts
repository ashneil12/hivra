import { NextRequest } from "next/server";

import { POST } from "../route";
import { decryptApiKey } from "@/lib/crypto";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

// Only stub the writer — api-response.ts imports sanitizeOpsMetadata from this
// same module, and a wholesale mock breaks every apiError() call.
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue(undefined),
}));

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const KEY = "k".repeat(64);

const mockedFrom = supabaseAdmin!.from as unknown as jest.Mock;
const mockedDecrypt = decryptApiKey as jest.MockedFunction<typeof decryptApiKey>;
const mockedOps = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;

function req(body: unknown, bearer: string | null = KEY) {
  return new NextRequest("http://localhost/api/internal/agent-notify", {
    method: "POST",
    headers: bearer
      ? { authorization: `Bearer ${bearer}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** hermes_instances lookup → { data, error } */
function mockInstanceLookup(
  data: unknown,
  error: unknown = null
): { maybeSingle: jest.Mock } {
  const maybeSingle = jest.fn().mockResolvedValue({ data, error });
  const neq = jest.fn().mockReturnValue({ maybeSingle });
  const eq = jest.fn().mockReturnValue({ neq });
  const select = jest.fn().mockReturnValue({ eq });
  mockedFrom.mockImplementationOnce((table: string) => {
    expect(table).toBe("hermes_instances");
    return { select };
  });
  return { maybeSingle };
}

function mockPendingUpsert(error: unknown = null) {
  const upsert = jest.fn().mockResolvedValue({ error });
  mockedFrom.mockImplementationOnce((table: string) => {
    expect(table).toBe("instance_pending_prompts");
    return { upsert };
  });
  return upsert;
}

function mockPendingUpdate(error: unknown = null) {
  const is = jest.fn().mockResolvedValue({ error });
  const eqPrompt = jest.fn().mockReturnValue({ is });
  const eqInstance = jest.fn().mockReturnValue({ eq: eqPrompt });
  const update = jest.fn().mockReturnValue({ eq: eqInstance });
  mockedFrom.mockImplementationOnce((table: string) => {
    expect(table).toBe("instance_pending_prompts");
    return { update };
  });
  return { update, is };
}

const PENDING = {
  event: "prompt.pending",
  instance_id: INSTANCE_ID,
  prompt_id: "call-abc",
  kind: "approval",
  surface: "gateway",
  summary: "Recursive delete",
  command: "rm -rf /var/lib/thing",
  session_key: "sess-1",
  ttl_seconds: 3600,
};

const RESOLVED = {
  event: "prompt.resolved",
  instance_id: INSTANCE_ID,
  prompt_id: "call-abc",
  choice: "deny",
};

const AUTHED_ROW = {
  id: INSTANCE_ID,
  user_id: "user_123",
  api_server_key_encrypted: "cipher",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedDecrypt.mockReturnValue(KEY);
});

describe("auth", () => {
  it("401s without a bearer, before touching the DB", async () => {
    const res = await POST(req(PENDING, null));
    expect(res.status).toBe(401);
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("401s on an unknown instance without confirming it exists", async () => {
    mockInstanceLookup(null);
    const res = await POST(req(PENDING));
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("401s when the instance has no api_server_key", async () => {
    mockInstanceLookup({ ...AUTHED_ROW, api_server_key_encrypted: null });
    expect((await POST(req(PENDING))).status).toBe(401);
  });

  it("401s on a bearer mismatch (api_server_key drift window)", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockedDecrypt.mockReturnValue("a-different-key-entirely-of-other-length");
    expect((await POST(req(PENDING))).status).toBe(401);
  });

  it("401s when decryptApiKey throws", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockedDecrypt.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    expect((await POST(req(PENDING))).status).toBe(401);
  });

  it("does not write anything on a failed auth", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockedDecrypt.mockReturnValue("wrong");
    await POST(req(PENDING));
    expect(mockedFrom).toHaveBeenCalledTimes(1); // lookup only
    expect(mockedOps).not.toHaveBeenCalled();
  });

  it("500s when the instance lookup fails", async () => {
    mockInstanceLookup(null, { message: "db down" });
    expect((await POST(req(PENDING))).status).toBe(500);
  });
});

describe("validation", () => {
  it("400s on malformed JSON", async () => {
    expect((await POST(req("{not json"))).status).toBe(400);
  });

  it("400s on an unknown event type", async () => {
    const res = await POST(req({ ...PENDING, event: "prompt.exploded" }));
    expect(res.status).toBe(400);
  });

  it("400s on a non-uuid instance_id", async () => {
    expect((await POST(req({ ...PENDING, instance_id: "nope" }))).status).toBe(400);
  });

  it("400s on an out-of-range ttl", async () => {
    const res = await POST(req({ ...PENDING, ttl_seconds: 60 * 60 * 24 * 30 }));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid resolve choice", async () => {
    expect((await POST(req({ ...RESOLVED, choice: "maybe" }))).status).toBe(400);
  });

  it("validates before authenticating", async () => {
    await POST(req({ ...PENDING, instance_id: "nope" }));
    expect(mockedFrom).not.toHaveBeenCalled();
  });
});

describe("prompt.pending", () => {
  it("upserts the row scoped to the instance owner", async () => {
    mockInstanceLookup(AUTHED_ROW);
    const upsert = mockPendingUpsert();

    const res = await POST(req(PENDING));
    expect(res.status).toBe(200);

    const [row, opts] = upsert.mock.calls[0];
    expect(row).toMatchObject({
      instance_id: INSTANCE_ID,
      prompt_id: "call-abc",
      user_id: "user_123", // taken from the DB row, never the payload
      kind: "approval",
      summary: "Recursive delete",
      resolved_at: null,
      resolved_choice: null,
    });
    expect(opts).toEqual({ onConflict: "instance_id,prompt_id" });
  });

  it("derives expires_at from ttl_seconds", async () => {
    mockInstanceLookup(AUTHED_ROW);
    const upsert = mockPendingUpsert();
    await POST(req(PENDING));

    const row = upsert.mock.calls[0][0];
    const delta =
      new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    expect(delta).toBe(3600 * 1000);
  });

  it("falls back to a 300s ttl when the agent omits it", async () => {
    mockInstanceLookup(AUTHED_ROW);
    const upsert = mockPendingUpsert();
    const noTtl: Partial<typeof PENDING> = { ...PENDING };
    delete noTtl.ttl_seconds;
    await POST(req(noTtl));

    const row = upsert.mock.calls[0][0];
    const delta =
      new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    expect(delta).toBe(300 * 1000);
  });

  it("writes NO ops_event on pending (the table is the operator record)", async () => {
    // Regression guard: a per-prompt ops_event accumulated unbounded and could
    // evict a genuine failure badge from getLatestInstanceFailureAlerts's
    // no-source-filter fetch budget. Operators read instance_pending_prompts.
    mockInstanceLookup(AUTHED_ROW);
    mockPendingUpsert();
    await POST(req(PENDING));
    expect(mockedOps).not.toHaveBeenCalled();
  });

  it("500s when the pending write fails", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockPendingUpsert({ message: "constraint" });
    expect((await POST(req(PENDING))).status).toBe(500);
  });
});

describe("prompt.resolved", () => {
  it("marks only the matching unresolved row", async () => {
    mockInstanceLookup(AUTHED_ROW);
    const { update, is } = mockPendingUpdate();

    const res = await POST(req(RESOLVED));
    expect(res.status).toBe(200);

    expect(update.mock.calls[0][0]).toMatchObject({ resolved_choice: "deny" });
    expect(is).toHaveBeenCalledWith("resolved_at", null);
  });

  it("defaults an absent choice to timeout", async () => {
    mockInstanceLookup(AUTHED_ROW);
    const { update } = mockPendingUpdate();
    const noChoice: Partial<typeof RESOLVED> = { ...RESOLVED };
    delete noChoice.choice;
    await POST(req(noChoice));
    expect(update.mock.calls[0][0].resolved_choice).toBe("timeout");
  });

  it("is a no-op (not an error) for a prompt we never recorded", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockPendingUpdate(); // 0 rows matched → no error from supabase
    expect((await POST(req(RESOLVED))).status).toBe(200);
  });

  it("does not write an ops_event on resolve", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockPendingUpdate();
    await POST(req(RESOLVED));
    expect(mockedOps).not.toHaveBeenCalled();
  });

  it("500s when the resolve write fails", async () => {
    mockInstanceLookup(AUTHED_ROW);
    mockPendingUpdate({ message: "db down" });
    expect((await POST(req(RESOLVED))).status).toBe(500);
  });
});
