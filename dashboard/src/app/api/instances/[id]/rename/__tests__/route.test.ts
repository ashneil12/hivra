import { PATCH } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { makeJsonRequest } from "@/test-utils/request";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

const mockedAuth = auth as jest.MockedFunction<typeof auth>;
const mockedFrom = supabaseAdmin!.from as jest.Mock;

// Builder for the ownership SELECT: .select().eq().eq().neq().single()
function selectChain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.neq = jest.fn(() => builder);
  builder.single = jest.fn(() => Promise.resolve(result));
  return builder;
}

// Builder for the UPDATE: .update().eq().eq() — thenable so `await` resolves it.
function updateChain(result: { error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.update = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.then = (resolve: (v: unknown) => void) => resolve(result);
  return builder;
}

function makeReq(body: unknown) {
  return makeJsonRequest("http://localhost/api/instances/inst-1/rename", body, { method: "PATCH" });
}

const params = () => Promise.resolve({ id: "inst-1" });

describe("PATCH /api/instances/[id]/rename", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<
      ReturnType<typeof auth>
    >);
  });

  it("rejects unauthenticated callers", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<
      ReturnType<typeof auth>
    >);
    const res = await PATCH(makeReq({ name: "Harvey" }), { params: params() });
    expect(res.status).toBe(401);
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("rejects an empty / whitespace-only name with 400", async () => {
    const res = await PATCH(makeReq({ name: "   " }), { params: params() });
    expect(res.status).toBe(400);
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("rejects a name longer than the max with 400", async () => {
    const res = await PATCH(makeReq({ name: "x".repeat(61) }), {
      params: params(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the instance is not owned by the caller", async () => {
    mockedFrom.mockReturnValueOnce(
      selectChain({ data: null, error: { message: "no rows" } })
    );
    const res = await PATCH(makeReq({ name: "Harvey" }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("renames and persists a sanitized, trimmed name", async () => {
    const select = selectChain({
      data: { id: "inst-1", name: "AGGIE" },
      error: null,
    });
    const update = updateChain({ error: null });
    mockedFrom.mockReturnValueOnce(select).mockReturnValueOnce(update);

    // Leading/trailing spaces + an embedded newline should be normalized.
    const res = await PATCH(makeReq({ name: "  Harvey\nBot  " }), {
      params: params(),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.name).toBe("Harvey Bot");
    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Harvey Bot" })
    );
  });

  it("is a no-op (no UPDATE) when the name is unchanged", async () => {
    mockedFrom.mockReturnValueOnce(
      selectChain({ data: { id: "inst-1", name: "Harvey" }, error: null })
    );
    const res = await PATCH(makeReq({ name: "Harvey" }), { params: params() });
    expect(res.status).toBe(200);
    // Only the SELECT happened; no second from() for the UPDATE.
    expect(mockedFrom).toHaveBeenCalledTimes(1);
  });
});
