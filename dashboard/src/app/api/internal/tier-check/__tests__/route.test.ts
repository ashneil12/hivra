import { NextRequest } from "next/server";

import { GET } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { isProTierUser } from "@/lib/billing/pro-tier";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(() => "k".repeat(64)),
}));

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(async () => true),
}));

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const mockedFrom = supabaseAdmin!.from as unknown as jest.Mock;

function lookupReturns(result: { data: unknown; error: unknown }) {
  const chain: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => result),
  };
  mockedFrom.mockReturnValue(chain);
}

function req() {
  return new NextRequest(`http://localhost/api/internal/tier-check?instance_id=${INSTANCE_ID}`, {
    headers: { authorization: `Bearer ${"k".repeat(64)}` },
  });
}

describe("GET /api/internal/tier-check", () => {
  beforeEach(() => mockedFrom.mockReset());

  // The sidecar fails closed on 4xx and open on 5xx, so a database outage must
  // not look like a refusal or every box's sidecar would stay down.
  it("answers 503 when the instance lookup errors", async () => {
    lookupReturns({ data: null, error: { message: "connection reset" } });
    expect((await GET(req())).status).toBe(503);
  });

  it("answers 503 when the entitlement read fails, so a paying user's sidecar stays up", async () => {
    lookupReturns({ data: { user_id: "user_1", api_server_key_encrypted: "enc" }, error: null });
    (isProTierUser as jest.Mock).mockResolvedValueOnce({ ok: false, tier: null, reason: "lookup_failed:subscription read failed" });
    expect((await GET(req())).status).toBe(503);
  });

  it("still refuses with tier_ok:false when the user has no entitlement", async () => {
    lookupReturns({ data: { user_id: "user_1", api_server_key_encrypted: "enc" }, error: null });
    (isProTierUser as jest.Mock).mockResolvedValueOnce({ ok: false, tier: null, reason: "no_entitlement" });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).tier_ok).toBe(false);
  });

  // An unknown instance, a keyless one and a wrong bearer must look identical
  // from outside, so the response cannot be used to find live instance ids.
  it("answers the same 401 for an unknown instance, a keyless one and a wrong bearer", async () => {
    const wrongBearer = new NextRequest(`http://localhost/api/internal/tier-check?instance_id=${INSTANCE_ID}`, {
      headers: { authorization: `Bearer ${"w".repeat(64)}` },
    });

    lookupReturns({ data: { user_id: "user_1", api_server_key_encrypted: "enc" }, error: null });
    const live = await GET(wrongBearer);

    lookupReturns({ data: null, error: null });
    const unknown = await GET(req());

    lookupReturns({ data: { user_id: "user_1", api_server_key_encrypted: null }, error: null });
    const keyless = await GET(req());

    for (const res of [live, unknown, keyless]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
  });

  // An unexpected throw must not echo the error text to the caller. The reason is
  // a fixed code; the detail belongs in the server log.
  it("returns a fixed reason, not the raw error message, when the check throws", async () => {
    lookupReturns({ data: { user_id: "user_1", api_server_key_encrypted: "enc" }, error: null });
    (isProTierUser as jest.Mock).mockRejectedValueOnce(new Error("internal detail: db host 10.250.0.9"));

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ tier_ok: false, tier: null, reason: "tier_check_error" });
    expect(JSON.stringify(body)).not.toContain("10.250.0.9");
  });
});
