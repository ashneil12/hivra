import { NextRequest } from "next/server";

import { GET } from "../route";
import { supabaseAdmin } from "@/lib/supabase";

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

  it("answers 404 for an unknown instance", async () => {
    lookupReturns({ data: null, error: null });
    expect((await GET(req())).status).toBe(404);
  });
});
