import { createHash } from "node:crypto";
import { authorizeWorkspaceSession, exchangeWorkspaceSession } from "../workspace-session-broker";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
const binding = { sessionId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  surface: "files", audience: "https://box.example.test" };
const exchangeCode = `hwe1_${"x".repeat(43)}`, verifier = "v".repeat(64), sessionToken = `hws1_${"t".repeat(43)}`;
const now = 1_000_000;
const data = (status = "exchanged") => ({ ...binding, status, userId: "owner", expiresAt: new Date(now + 60_000).toISOString() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("workspace session broker", () => {
  const rpc = jest.fn();
  const deps = { rpc, now: () => now, token: () => sessionToken };
  beforeEach(() => { rpc.mockReset().mockResolvedValue({ data: data(), error: null }); });
  it("exchanges with only hashes and a derived PKCE challenge in the ledger", async () => {
    const result = await exchangeWorkspaceSession({ ...binding, exchangeCode, verifier }, deps);
    expect(result).toEqual({ ok: true, grant: { ...binding, userId: "owner", expiresAt: now + 60_000, sessionToken } });
    expect(rpc).toHaveBeenCalledWith("exchange_hivra_workspace_session", {
      p_id: binding.sessionId, p_computer: binding.computerId, p_surface: "files", p_audience: binding.audience,
      p_exchange_hash: hash(exchangeCode), p_challenge: createHash("sha256").update(verifier).digest("base64url"), p_token_hash: hash(sessionToken),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(sessionToken);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(verifier);
  });
  it("reauthorizes the exact binding without returning the bearer", async () => {
    rpc.mockResolvedValue({ data: data("authorized"), error: null });
    const result = await authorizeWorkspaceSession({ ...binding, sessionToken }, deps);
    expect(result).toEqual({ ok: true, grant: { ...binding, userId: "owner", expiresAt: now + 60_000 } });
    expect(rpc).toHaveBeenCalledWith("authorize_hivra_workspace_session", {
      p_id: binding.sessionId, p_computer: binding.computerId, p_surface: "files", p_audience: binding.audience, p_token_hash: hash(sessionToken),
    });
  });
  it.each([{ sessionId: binding.computerId }, { computerId: binding.sessionId }, { surface: "box-terminal" },
    { audience: "https://other.test" }, { userId: "" }, { status: "denied" }, { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 240_001).toISOString() }, { unexpected: "secret" }])("rejects mismatched or stale grant %j", async change => {
    rpc.mockResolvedValue({ data: { ...data(), ...change }, error: null });
    expect(await exchangeWorkspaceSession({ ...binding, exchangeCode, verifier }, deps)).toEqual({ ok: false });
  });
  it.each([{ exchangeCode: "bad" }, { verifier: "short" }, { audience: "http://box.example.test" },
    { audience: "https://box.example.test/path" }, { surface: "desktop" }, { userId: "injected" }])("rejects malformed exchange before storage %j", async change => {
    expect(await exchangeWorkspaceSession({ ...binding, exchangeCode, verifier, ...change }, deps)).toEqual({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not expose database errors or private exceptions", async () => {
    rpc.mockRejectedValueOnce(new Error("private database detail"));
    expect(await authorizeWorkspaceSession({ ...binding, sessionToken }, deps)).toEqual({ ok: false });
    rpc.mockResolvedValueOnce({ data: data(), error: { message: "private detail" } });
    expect(await exchangeWorkspaceSession({ ...binding, exchangeCode, verifier }, deps)).toEqual({ ok: false });
  });
  it("denies missing storage and malformed bearer tokens", async () => {
    expect(await authorizeWorkspaceSession({ ...binding, sessionToken })).toEqual({ ok: false });
    expect(await authorizeWorkspaceSession({ ...binding, sessionToken: "wrong" }, deps)).toEqual({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects unparseable expiry offsets in both RPC receipts", async () => {
    rpc.mockResolvedValueOnce({ data: { ...data(), expiresAt: "2026-09-06T01:00:00+99:99" }, error: null });
    expect(await exchangeWorkspaceSession({ ...binding, exchangeCode, verifier }, deps)).toEqual({ ok: false });
    rpc.mockResolvedValueOnce({ data: { ...data("authorized"), expiresAt: "2026-09-06T01:00:00+99:99" }, error: null });
    expect(await authorizeWorkspaceSession({ ...binding, sessionToken }, deps)).toEqual({ ok: false });
  });
});
