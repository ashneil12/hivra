import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { GET } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe("GET /api/instances/[id]/usage-summary", () => {
  it("reads the newest `days` snapshots in a defined order, not an arbitrary subset", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });

    const ownershipChain: Record<string, jest.Mock> = {};
    ownershipChain.select = jest.fn(() => ownershipChain);
    ownershipChain.eq = jest.fn(() => ownershipChain);
    ownershipChain.is = jest.fn(() => ownershipChain);
    ownershipChain.maybeSingle = jest.fn(async () => ({ data: { id: "inst-1" }, error: null }));

    const snapshotChain: Record<string, jest.Mock> = {};
    snapshotChain.select = jest.fn(() => snapshotChain);
    snapshotChain.eq = jest.fn(() => snapshotChain);
    snapshotChain.gte = jest.fn(() => snapshotChain);
    snapshotChain.order = jest.fn(() => snapshotChain);
    snapshotChain.limit = jest.fn(async () => ({ data: [], error: null }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) =>
      table === "hermes_instances" ? ownershipChain : snapshotChain,
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-1/usage-summary?days=7"),
      { params: Promise.resolve({ id: "inst-1" }) },
    );

    expect(response.status).toBe(200);
    expect(snapshotChain.order).toHaveBeenCalledWith("stat_date", { ascending: false });
    expect(snapshotChain.limit).toHaveBeenCalledWith(7);
    // The order must be applied before the limit, or the limit keeps an arbitrary subset.
    const orderCall = (snapshotChain.order as jest.Mock).mock.invocationCallOrder[0];
    const limitCall = (snapshotChain.limit as jest.Mock).mock.invocationCallOrder[0];
    expect(orderCall).toBeLessThan(limitCall);
  });
});
