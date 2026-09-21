import {
  buildWorkspaceCloudConnectionBundle,
  exchangeWorkspaceCloudHandoffCode,
} from "@/lib/services/workspace-cloud-handoff";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

// A syntactically valid PKCE verifier (43 chars, within RFC 7636 bounds).
const VALID_VERIFIER = "0123456789012345678901234567890123456789012";

function mockSelectRow(row: unknown) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: row });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select });
}

describe("workspace-cloud-handoff exchange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("rejects a verifier outside the RFC 7636 length bounds before touching the DB", async () => {
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789", verifier: "tooshort" });
    expect(res).toEqual({ ok: false, status: 400, error: "Invalid verifier" });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("does not require a verifier for paste-a-code pairing (no PKCE upfront)", async () => {
    // Paste flow omits the verifier entirely. The exchange must NOT reject it as
    // a verifier error — it proceeds to the code lookup (unknown here).
    mockSelectRow(null);
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789" });
    expect(res).toMatchObject({ ok: false, error: "Invalid or expired code" });
    expect(supabaseAdmin!.from).toHaveBeenCalled();
  });

  it("rejects an unknown code", async () => {
    mockSelectRow(null);
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789", verifier: VALID_VERIFIER });
    expect(res).toMatchObject({ ok: false, status: 400, error: "Invalid or expired code" });
  });

  it("rejects an already-consumed code (single-use)", async () => {
    mockSelectRow({
      id: "row1",
      user_id: "u",
      instance_id: "i",
      challenge: "anything",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: new Date().toISOString(),
    });
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789", verifier: VALID_VERIFIER });
    expect(res).toMatchObject({ ok: false, error: "Code already used" });
  });

  it("rejects an expired code", async () => {
    mockSelectRow({
      id: "row1",
      user_id: "u",
      instance_id: "i",
      challenge: "anything",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      consumed_at: null,
    });
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789", verifier: VALID_VERIFIER });
    expect(res).toMatchObject({ ok: false, error: "Code expired" });
  });

  it("rejects a verifier whose challenge does not match (PKCE)", async () => {
    mockSelectRow({
      id: "row1",
      user_id: "u",
      instance_id: "i",
      challenge: "this-is-not-the-sha256-of-the-verifier",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const res = await exchangeWorkspaceCloudHandoffCode({ code: "abcdef0123456789", verifier: VALID_VERIFIER });
    expect(res).toMatchObject({ ok: false, error: "PKCE verification failed" });
  });
});

describe("buildWorkspaceCloudConnectionBundle backend URL derivation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  // Post gateway≡webfree collapse a "gateway" box runs the IDENTICAL webfree stack
  // as a "webui" box, so its workspace base URL MUST be resolved through
  // deriveWebUIBaseUrl (the http→https sslip upgrade) exactly like a webui box.
  // Before the collapse fix a gateway box kept its raw http gateway_url, so the
  // workspace handoff pointed the chat surface at the wrong (non-TLS) origin and
  // typed messages went nowhere.
  it.each([
    { backend: "gateway" as const },
    { backend: "webui" as const },
  ])(
    "resolves an http sslip gateway_url to https for a $backend (webfree) box",
    async ({ backend }) => {
      (getSecureUserInstance as jest.Mock).mockResolvedValue({
        instance: {
          id: "inst-123",
          gateway_url: "http://203.0.113.4.sslip.io",
          backend,
        },
        apiServerKey: "secret",
        instanceIpv4: undefined,
        error: null,
      });

      const result = await buildWorkspaceCloudConnectionBundle({
        userId: "user-1",
        instanceId: "inst-123",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both webfree backends land on the same TLS origin — a gateway box is no
      // longer left on its raw http URL.
      expect(result.bundle.gatewayUrl).toBe("https://203.0.113.4.sslip.io");
    },
  );
});
