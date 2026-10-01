import { NextRequest } from "next/server";

import { GET } from "../route";

const maybeSingle = jest.fn();
const neq = jest.fn(() => ({ maybeSingle }));
const eq = jest.fn(() => ({ neq }));
const select = jest.fn(() => ({ eq }));
const from = jest.fn(() => ({ select }));

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from };
  },
}));

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

async function call(id: string) {
  const response = await GET(new NextRequest(`https://hivra.cloud/api/instances/${encodeURIComponent(id)}/aeon-gate`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: await response.json() };
}

describe("GET /api/instances/[id]/aeon-gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("says active for a running instance", async () => {
    maybeSingle.mockResolvedValue({ data: { status: "running" }, error: null });

    await expect(call(INSTANCE_ID)).resolves.toEqual({ status: 200, body: { active: true, status: "running" } });
    expect(eq).toHaveBeenCalledWith("id", INSTANCE_ID);
    expect(neq).toHaveBeenCalledWith("status", "deleted");
  });

  it("says inactive for a stopped instance and for one that does not exist", async () => {
    maybeSingle.mockResolvedValue({ data: { status: "stopped" }, error: null });
    await expect(call(INSTANCE_ID)).resolves.toEqual({ status: 200, body: { active: false, status: "stopped" } });

    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(call(INSTANCE_ID)).resolves.toEqual({ status: 200, body: { active: false, status: "not_found" } });
  });

  it("fails closed when the database errors", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(call(INSTANCE_ID)).resolves.toEqual({ status: 200, body: { active: false, status: "not_found" } });

    maybeSingle.mockRejectedValue(new Error("network"));
    await expect(call(INSTANCE_ID)).resolves.toEqual({ status: 200, body: { active: false, status: "error" } });
  });

  // The route has no credential, so anyone can send it any text for an id. An
  // id that is not a UUID cannot match a row (the column is a uuid), so the
  // route answers not_found without sending the text to the database at all.
  it.each([
    ["words", "not-a-uuid"],
    ["a filter fragment", "x,status.eq.running"],
    ["an or() expression", "1);select 1;--"],
    ["a UUID with a suffix", `${INSTANCE_ID}-extra`],
    ["a UUID with a prefix", `x${INSTANCE_ID}`],
    ["an empty string", ""],
  ])("does not query the database for %s", async (_label, id) => {
    await expect(call(id)).resolves.toEqual({ status: 200, body: { active: false, status: "not_found" } });
    expect(from).not.toHaveBeenCalled();
  });

  it("accepts a UUID in upper case", async () => {
    maybeSingle.mockResolvedValue({ data: { status: "running" }, error: null });

    await expect(call(INSTANCE_ID.toUpperCase())).resolves.toEqual({ status: 200, body: { active: true, status: "running" } });
    expect(eq).toHaveBeenCalledTimes(1);
  });
});
