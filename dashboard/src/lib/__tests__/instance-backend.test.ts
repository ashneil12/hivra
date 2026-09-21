import {
  deriveWebUIBaseUrl,
  getInstanceBackend,
  getInstanceBackendUnchecked,
} from "@/lib/instance-backend";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("server-only", () => ({}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const mockedFrom = supabaseAdmin!.from as jest.Mock;

function mockBackendRow(backend: string | null, error: unknown = null) {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: backend === null ? null : { backend },
    error,
  });
  // Two .eq calls in the user-scoped variant (id + user_id), one in the
  // unchecked variant. Have eq return the same chain object either way
  // and end the chain at maybeSingle.
  const eqChain: { eq: jest.Mock; maybeSingle: jest.Mock } = {
    eq: jest.fn(() => eqChain),
    maybeSingle,
  };
  const select = jest.fn(() => eqChain);
  mockedFrom.mockReturnValue({ select });
  return { select, eq: eqChain.eq, maybeSingle };
}

describe("instance-backend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("scopes the lookup to id AND user_id", async () => {
    const query = mockBackendRow("webui");

    await expect(getInstanceBackend("inst-123", "user_owner")).resolves.toBe("webui");

    expect(mockedFrom).toHaveBeenCalledWith("hermes_instances");
    expect(query.select).toHaveBeenCalledWith("backend");
    // The user-scoped variant must filter both columns, not just id.
    expect(query.eq).toHaveBeenCalledWith("id", "inst-123");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user_owner");
  });

  it("falls back to gateway for missing, unknown, or errored rows", async () => {
    mockBackendRow(null);
    await expect(getInstanceBackend("missing", "user_owner")).resolves.toBe("gateway");

    mockBackendRow("surprise");
    await expect(getInstanceBackend("legacy", "user_owner")).resolves.toBe("gateway");

    mockBackendRow("webui", new Error("db unavailable"));
    await expect(getInstanceBackend("errored", "user_owner")).resolves.toBe("gateway");
  });

  it("getInstanceBackendUnchecked skips the user_id filter for server-to-server callers", async () => {
    const query = mockBackendRow("webui");

    await expect(getInstanceBackendUnchecked("inst-123")).resolves.toBe("webui");

    expect(query.eq).toHaveBeenCalledWith("id", "inst-123");
    // Single eq call only — no user_id filter.
    expect(query.eq).toHaveBeenCalledTimes(1);
  });

  it("normalizes the WebUI base URL without changing the host", () => {
    expect(deriveWebUIBaseUrl("https://agent.example.com/")).toBe("https://agent.example.com");
    expect(deriveWebUIBaseUrl("http://203.0.113.11:8787")).toBe("http://203.0.113.11:8787");
    expect(deriveWebUIBaseUrl("http://203-0-113-194.sslip.io/")).toBe("https://203-0-113-194.sslip.io");
  });
});
