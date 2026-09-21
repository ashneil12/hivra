import crypto from "node:crypto";

import {
  authorizeRemoteDesktopSession,
  claimOmarchyNativeActivation,
  claimOmarchyNativeRenewal,
  confirmRemoteDesktopInputTransition,
  exchangeRemoteDesktopSession,
  issueRemoteDesktopSession,
  loadOmarchyNativeActivationGrant,
  recordOmarchyNativeActivationGrant,
  recordOmarchyNativeRenewal,
  recordRemoteDesktopCapability,
  refreshOmarchyNativeCapability,
  renewRemoteDesktopSessionByToken,
  revokeRemoteDesktopCapability,
  revokeRemoteDesktopSession,
} from "../session-broker";
import { REMOTE_DESKTOP_BUNDLE_REVISION, REMOTE_DESKTOP_SESSION_REVISIONS } from "../capability-inspection";
import { OMARCHY_DESKTOP_SESSION_REVISION, OMARCHY_NATIVE_SESSION_REVISION } from "../omarchy-native-capability";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

const COMPUTER_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
const GENERATION = "018f6d3c-1d91-7c65-9d86-37fc915b8378";
const SESSION_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8379";
const VERIFIER = "v".repeat(64);
const PKCE = crypto.createHash("sha256").update(VERIFIER).digest("base64url");
const PREDECESSOR_REVISION = "d".repeat(64);
const NATIVE_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIC2zCCAcOgAwIBAgIJAOLaB9FCFXa8MA0GCSqGSIb3DQEBCwUAMBwxGjAYBgNV
BAMMEUhpdnJhIFRlc3QgQ2xpZW50MB4XDTI2MDkwODA1MzkwOVoXDTM2MDkwNTA1
MzkwOVowHDEaMBgGA1UEAwwRSGl2cmEgVGVzdCBDbGllbnQwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC2ZNXa3jQT9rKYuqCS/iuvQdxYoMG2t+6DKY34
ngRBSbxytclQrh0lH0KHdvfrwdGEHcLK3LRW8vROIq7Tqqz4YDHWaQ7HT8Ci0MqK
IkpFkHbv7MHPqciIojISKFJ+FqpPFB9TdQIJRVO/Km+sslGOpevZTHv7j7AvoO/S
HI8KP79DEfRaHdpsD7i8oJGIkMiqzzgcfYReo1uqGUh+izMnXjS+P0OORBjniaSl
j2Mg6GOmU2drADjLR/FaPDKrHsp3LPVIXEZdR28VQMr+VILhrPey5q1Zzatn5rn6
rpAGfCfZZ5caczJbCAD9EuwcquiJwHPNyn6TA8Ss8sYN9mQrAgMBAAGjIDAeMAwG
A1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgeAMA0GCSqGSIb3DQEBCwUAA4IBAQCS
8Y4NbwXwLebivJfXGqQBQyEx4nQB7aUZRxx8TVColF3LmGG+WyZY2bIG+W6MJECJ
iBdMyx2osseMefDkIY1K2rZqLgZLA23aCCoIQMI/G1UhSbm0peUSPmHPj3eR5Ac4
WO4Xy2bNnewZTbo3DRi8H4fUHfKAHaGZMo7FPp0ILxn/WWt9wdl3swUCbTcMGxzv
l2z99zGTBAvT70e3dvnzYc3kesmw7N6U2963rWV0rpypwcnLyUTZLdsINoF7wSyO
Mxp4QNB0jUIUqvbe3JbEnM5wc5JZh1ow3nW8CWFUjX6PdrhC+9dCROdp86W3Q5JS
TXWq66V/SDgo/Eb8rvro
-----END CERTIFICATE-----`;
const NATIVE_PROFILE = {
  clientId: "018f6d3c-1d91-7c65-9d86-37fc915b8380",
  clientCertificatePem: NATIVE_CERTIFICATE_PEM,
  clientCertificateSha256: "3053a65a1dd2eab25be45798dbb4895f0aece1946d119c7cdac44bb6f2b15737",
};

const capability = (overrides: Record<string, unknown> = {}) => ({
  computer_kind: "hermes-instance",
  computer_id: COMPUTER_ID,
  user_id: "user-1",
  generation: GENERATION,
  compositor: "x11",
  installed_transports: ["selkies-websocket", "recovery-console"],
  private_network_reachable: false,
  supports_input_takeover: true,
  broker_origin: "https://desktop.example.com",
  observed_revision: REMOTE_DESKTOP_BUNDLE_REVISION,
  observed_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  revoked_at: null,
  ...overrides,
});

function capabilityLookup(row: unknown = capability(), error: unknown = null) {
  const builder: Record<string, jest.Mock> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.is = jest.fn(() => builder);
  builder.maybeSingle = jest.fn().mockResolvedValue({ data: row, error });
  (supabaseAdmin!.from as jest.Mock).mockReturnValue(builder);
  return builder;
}

function controllerConflictLookup(rows: unknown[], error: unknown = null) {
  const capabilityBuilder = capabilityLookup();
  const sessionBuilder: Record<string, jest.Mock> = {};
  sessionBuilder.select = jest.fn(() => sessionBuilder);
  sessionBuilder.eq = jest.fn(() => sessionBuilder);
  sessionBuilder.in = jest.fn(() => sessionBuilder);
  sessionBuilder.returns = jest.fn().mockResolvedValue({ data: rows, error });
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) =>
    table === "hivra_remote_desktop_sessions" ? sessionBuilder : capabilityBuilder
  );
  return sessionBuilder;
}

const sessionEvidence = (overrides: Record<string, unknown> = {}) => ({
  computer_kind: "hermes-instance",
  computer_id: COMPUTER_ID,
  capability_generation: GENERATION,
  transport: "selkies-websocket",
  pkce_challenge: PKCE,
  ...overrides,
});

function protocolEvidenceLookup(params: {
  session?: unknown;
  capability?: unknown;
  sessionError?: unknown;
  capabilityError?: unknown;
} = {}) {
  const sessionBuilder: Record<string, jest.Mock> = {};
  sessionBuilder.select = jest.fn(() => sessionBuilder);
  sessionBuilder.eq = jest.fn(() => sessionBuilder);
  sessionBuilder.maybeSingle = jest.fn().mockResolvedValue({
    data: params.session === undefined ? sessionEvidence() : params.session,
    error: params.sessionError ?? null,
  });
  const capabilityBuilder: Record<string, jest.Mock> = {};
  capabilityBuilder.select = jest.fn(() => capabilityBuilder);
  capabilityBuilder.eq = jest.fn(() => capabilityBuilder);
  capabilityBuilder.maybeSingle = jest.fn().mockResolvedValue({
    data: params.capability === undefined
      ? { observed_revision: REMOTE_DESKTOP_BUNDLE_REVISION }
      : params.capability,
    error: params.capabilityError ?? null,
  });
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) =>
    table === "hivra_remote_desktop_sessions" ? sessionBuilder : capabilityBuilder
  );
  return { sessionBuilder, capabilityBuilder };
}

function issueParams(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    computerKind: "hermes-instance" as const,
    computerId: COMPUTER_ID,
    purpose: "daily-driver" as const,
    inputRole: "controller" as const,
    streamingMode: "hq" as const,
    client: { kind: "browser" as const, moonlight: false, webCodecs: true, udp: "direct" as const },
    pkceChallenge: PKCE,
    ...overrides,
  };
}

describe("remote desktop session broker", () => {
  const handoffParams = () => issueParams({ computerKind: "hivra-agent", requestedTransport: "selkies-websocket", ownerHandoff: true });
  const handoffController = (overrides: Record<string, unknown> = {}) => ({
    id: SESSION_ID, user_id: "user-1", computer_kind: "hivra-agent", computer_id: COMPUTER_ID,
    transport: "selkies-websocket", capability_generation: GENERATION, input_state: "active",
    revoked_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides,
  });
  it("requests real guest release of an explicit same-owner controller without issuing or acknowledging input", async () => {
    controllerConflictLookup([handoffController()]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: { status: "controller_conflict" }, error: null })
      .mockResolvedValueOnce({ data: { status: "revoked", inputState: "release-pending" }, error: null });
    expect(await issueRemoteDesktopSession(handoffParams())).toMatchObject({ ok: false, code: "controller_releasing" });
    expect(supabaseAdmin!.rpc).toHaveBeenNthCalledWith(2, "revoke_hivra_remote_desktop_session", {
      p_user_id: "user-1", p_session_id: SESSION_ID, p_reason: "user_revoked",
    });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(2);
    controllerConflictLookup([handoffController({ input_state: "release-pending", revoked_at: new Date().toISOString() })]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ data: { status: "controller_conflict" }, error: null });
    expect(await issueRemoteDesktopSession({ ...handoffParams(), ownerHandoff: false })).toMatchObject({ code: "controller_releasing" });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(3);
    // Only a later successful serialized issue receipt admits the new grant.
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ data: { status: "issued", capabilityGeneration: GENERATION,
      streamingMode: "hq", brokerOrigin: "https://desktop.example.com" }, error: null });
    expect(await issueRemoteDesktopSession({ ...handoffParams(), ownerHandoff: false })).toMatchObject({ ok: true });
  });
  it.each([{ user_id: "other-owner" }, { user_id: undefined }, { id: "invalid" },
    { capability_generation: crypto.randomUUID() }, { computer_id: crypto.randomUUID() },
    { transport: "sunshine-moonlight" }, { expires_at: "invalid" }, { expires_at: 2099 }, { input_state: "unknown" },
    { input_state: "release-pending", user_id: "other-owner" }])("fails closed before any revocation for snapshot mismatch %j", async overrides => {
    controllerConflictLookup([handoffController(), handoffController(overrides)]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ data: { status: "controller_conflict" }, error: null });
    expect(await issueRemoteDesktopSession(handoffParams())).toMatchObject({ code: "controller_conflict" });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the owned controller cannot be revoked", async () => {
    controllerConflictLookup([handoffController()]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: { status: "controller_conflict" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "revoke failed" } });
    expect(await issueRemoteDesktopSession(handoffParams())).toMatchObject({ ok: false, code: "session_revoke_failed" });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([{ computerKind: "hermes-instance" }, { inputRole: "viewer" }, { purpose: "recovery" },
    { client: { kind: "native", moonlight: true, webCodecs: true, udp: "direct" } },
    { requestedTransport: "sunshine-moonlight" }] as const)("rejects owner handoff outside browser Hivra daily-driver %j", async overrides => {
    expect(await issueRemoteDesktopSession({ ...handoffParams(), ...overrides })).toMatchObject({ code: "invalid_request" });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(REMOTE_DESKTOP_SESSION_REVISIONS)("issues against compatible observed revision %s and stores only a handoff hash", async (revision) => {
    capabilityLookup(capability({ observed_revision: revision }));
    (supabaseAdmin!.rpc as jest.Mock).mockImplementation(async (name, args) => {
      expect(name).toBe("issue_hivra_remote_desktop_session_v3");
      expect(args.p_handoff).toBe("message");
      expect(args.p_streaming_mode).toBe("hq");
      expect(args.p_exchange_code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(args.p_exchange_code_hash).not.toContain("hrs1_");
      expect(args.p_native_client_id).toBeNull();
      return {
        data: {
          status: "issued",
          capabilityGeneration: GENERATION,
          brokerOrigin: "https://desktop.example.com",
          streamingMode: "hq",
        },
        error: null,
      };
    });

    const result = await issueRemoteDesktopSession(issueParams());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.transport).toBe("selkies-websocket");
    expect(result.session.handoff).toBe("message");
    expect(result.session.streamingMode).toBe("hq");
    expect(result.session.exchangeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session.audience).toBe(`hivra-computer:hermes-instance:${COMPUTER_ID}:desktop`);
  });

  it.each(["hermes-instance", "hivra-agent"] as const)(
    "requires the exact current Selkies protocol revision before issuing for %s",
    async (computerKind) => {
      capabilityLookup(capability({ computer_kind: computerKind, observed_revision: PREDECESSOR_REVISION }));

      await expect(issueRemoteDesktopSession(issueParams({ computerKind }))).resolves.toMatchObject({
        ok: false,
        status: 409,
        code: "desktop_upgrade_required",
      });
      expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    },
  );

  it("denies a stale native guardian session before authorization", async () => {
    protocolEvidenceLookup({
      session: sessionEvidence({ computer_kind: "hivra-agent", transport: "sunshine-moonlight" }),
      capability: { observed_revision: PREDECESSOR_REVISION },
    });
    const token = `hrs1_${"a".repeat(43)}`;
    await expect(authorizeRemoteDesktopSession({
      sessionToken: token,
      computerKind: "hivra-agent",
      computerId: COMPUTER_ID,
      transport: "sunshine-moonlight",
      wantsInput: true,
    })).resolves.toMatchObject({ ok: false, code: "desktop_upgrade_required" });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("does not apply the Selkies WebSocket revision gate to WebRTC", async () => {
    capabilityLookup(capability({
      installed_transports: ["selkies-webrtc"],
      observed_revision: PREDECESSOR_REVISION,
    }));
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "issued", capabilityGeneration: GENERATION, streamingMode: "hq" },
      error: null,
    });

    await expect(issueRemoteDesktopSession(issueParams({
      requestedTransport: "selkies-webrtc",
    }))).resolves.toMatchObject({ ok: true, session: { transport: "selkies-webrtc" } });
  });

  it("requires the exact current Omarchy guardian revision before native issue", async () => {
    const native = {
      computer_kind: "hivra-agent",
      compositor: "wayland",
      installed_transports: ["sunshine-moonlight"],
      private_network_reachable: true,
      observed_revision: PREDECESSOR_REVISION,
    };
    capabilityLookup(capability(native));
    const params = issueParams({
      sessionId: SESSION_ID,
      computerKind: "hivra-agent",
      requestedTransport: "sunshine-moonlight",
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "direct" },
      nativeProfile: NATIVE_PROFILE,
    });
    await expect(issueRemoteDesktopSession(params)).resolves.toMatchObject({
      ok: false,
      code: "desktop_upgrade_required",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();

    capabilityLookup(capability({ ...native, observed_revision: OMARCHY_DESKTOP_SESSION_REVISION }));
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: {
        status: "issued", capabilityGeneration: GENERATION, streamingMode: "hq",
        nativeProfileBound: true, nativeClientId: NATIVE_PROFILE.clientId,
        nativeClientCertificateSha256: NATIVE_PROFILE.clientCertificateSha256,
      },
      error: null,
    });
    await expect(issueRemoteDesktopSession(params)).resolves.toMatchObject({
      ok: true,
      session: { transport: "sunshine-moonlight" },
    });
  });

  it("uses the app-prepared session UUID only for an exact native Sunshine controller", async () => {
    const native = {
      computer_kind: "hivra-agent",
      compositor: "wayland",
      installed_transports: ["sunshine-moonlight"],
      private_network_reachable: true,
      observed_revision: OMARCHY_DESKTOP_SESSION_REVISION,
    };
    capabilityLookup(capability(native));
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: {
        status: "issued", capabilityGeneration: GENERATION, streamingMode: "performance",
        nativeProfileBound: true, nativeClientId: NATIVE_PROFILE.clientId,
        nativeClientCertificateSha256: NATIVE_PROFILE.clientCertificateSha256,
      },
      error: null,
    });
    const result = await issueRemoteDesktopSession(issueParams({
      sessionId: SESSION_ID,
      computerKind: "hivra-agent",
      streamingMode: "performance",
      requestedTransport: "sunshine-moonlight",
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "direct" },
      nativeProfile: NATIVE_PROFILE,
    }));
    expect(result).toMatchObject({
      ok: true,
      session: { id: SESSION_ID, streamingMode: "performance", transport: "sunshine-moonlight" },
    });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "issue_hivra_remote_desktop_session_v3",
      expect.objectContaining({
        p_session_id: SESSION_ID,
        p_streaming_mode: "performance",
        p_native_client_id: NATIVE_PROFILE.clientId,
        p_native_client_certificate_sha256: NATIVE_PROFILE.clientCertificateSha256,
      }),
    );

    jest.clearAllMocks();
    await expect(issueRemoteDesktopSession(issueParams({ sessionId: SESSION_ID }))).resolves.toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("rejects a native certificate whose claimed DER hash is not exact", async () => {
    await expect(issueRemoteDesktopSession(issueParams({
      sessionId: SESSION_ID,
      computerKind: "hivra-agent",
      requestedTransport: "sunshine-moonlight",
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "relay" },
      nativeProfile: { ...NATIVE_PROFILE, clientCertificateSha256: "0".repeat(64) },
    }))).resolves.toMatchObject({ ok: false, status: 400, code: "invalid_request" });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("claims one exact exchanged Omarchy activation without exposing the session token", async () => {
    const activationId = "88888888-8888-4888-8888-888888888888";
    const sessionToken = `hrs1_${"t".repeat(43)}`;
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: {
        status: "claimed", activationId, sessionId: SESSION_ID, ownerId: "user-1",
        computerId: COMPUTER_ID, capabilityGeneration: GENERATION,
        observedRevision: OMARCHY_NATIVE_SESSION_REVISION,
        clientId: NATIVE_PROFILE.clientId,
        clientCertificatePem: NATIVE_PROFILE.clientCertificatePem,
        clientCertificateSha256: NATIVE_PROFILE.clientCertificateSha256,
        streamingMode: "hq", expiresAt: new Date(Date.now() + 120_000).toISOString(),
        continuousExpiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
      },
      error: null,
    });
    await expect(claimOmarchyNativeActivation({
      userId: "user-1", sessionId: SESSION_ID, sessionToken, activationId,
    })).resolves.toMatchObject({
      ok: true,
      claim: { activationId, sessionId: SESSION_ID, clientId: NATIVE_PROFILE.clientId },
    });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "claim_hivra_omarchy_native_activation",
      expect.objectContaining({
        p_session_id: SESSION_ID,
        p_activation_id: activationId,
        p_session_token_hash: crypto.createHash("sha256").update(sessionToken).digest("hex"),
      }),
    );
    expect(JSON.stringify((supabaseAdmin!.rpc as jest.Mock).mock.calls[0]?.[1])).not.toContain(sessionToken);
  });

  it("claims and records one idempotent native renewal", async () => {
    const activationId = "88888888-8888-4888-8888-888888888888";
    const renewalId = "99999999-9999-4999-8999-999999999999";
    const previousExpiresAt = new Date(Date.now() + 90_000).toISOString();
    const expiresAt = new Date(Date.now() + 240_000).toISOString();
    const continuousExpiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: {
      status: "claimed", sessionId: SESSION_ID, activationId, renewalId, renewalCount: 1,
      previousExpiresAt, expiresAt, continuousExpiresAt, guardianRenewal: null,
    }, error: null });
    await expect(claimOmarchyNativeRenewal({
      userId: "user-1", sessionId: SESSION_ID, activationId, renewalId,
    })).resolves.toEqual({ ok: true, renewal: { sessionId: SESSION_ID, activationId,
      renewalId, renewalCount: 1, previousExpiresAt, expiresAt, continuousExpiresAt,
      guardianRenewal: null } });
    expect(supabaseAdmin!.rpc).toHaveBeenLastCalledWith("claim_hivra_omarchy_native_renewal", {
      p_user_id: "user-1", p_session_id: SESSION_ID, p_activation_id: activationId,
      p_renewal_id: renewalId, p_ttl_seconds: 240,
    });

    const guardianRenewal = { protocol: "hivra-omarchy-guardian-renewal-v1" };
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({
      data: { status: "recorded", sessionId: SESSION_ID, renewalId }, error: null,
    });
    await expect(recordOmarchyNativeRenewal({ userId: "user-1", sessionId: SESSION_ID,
      activationId, renewalId, guardianRenewal })).resolves.toEqual({ ok: true });
    expect(supabaseAdmin!.rpc).toHaveBeenLastCalledWith("record_hivra_omarchy_native_renewal",
      expect.objectContaining({ p_renewal_id: renewalId, p_guardian_renewal: guardianRenewal }));
  });

  it("refreshes only the exact server-observed native capability", async () => {
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: {
      status: "ready", computerId: COMPUTER_ID, generation: GENERATION,
      expiresAt: expiresAt.replace("Z", "+00:00"),
    }, error: null });
    await expect(refreshOmarchyNativeCapability({ userId: "user-1", computerId: COMPUTER_ID,
      capabilityGeneration: GENERATION, observedRevision: OMARCHY_NATIVE_SESSION_REVISION,
      observedAt, expiresAt })).resolves.toEqual({ ok: true });
    expect(supabaseAdmin!.rpc).toHaveBeenLastCalledWith("refresh_hivra_omarchy_native_capability", {
      p_user_id: "user-1", p_computer_id: COMPUTER_ID, p_generation: GENERATION,
      p_observed_revision: OMARCHY_NATIVE_SESSION_REVISION, p_observed_at: observedAt,
      p_expires_at: expiresAt,
    });
  });

  it("rejects a changed public identity in an activation claim receipt", async () => {
    const activationId = "88888888-8888-4888-8888-888888888888";
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: {
        status: "claimed", activationId, sessionId: SESSION_ID, ownerId: "user-1",
        computerId: COMPUTER_ID, capabilityGeneration: GENERATION,
        observedRevision: OMARCHY_NATIVE_SESSION_REVISION,
        clientId: NATIVE_PROFILE.clientId,
        clientCertificatePem: NATIVE_PROFILE.clientCertificatePem,
        clientCertificateSha256: "0".repeat(64), streamingMode: "hq",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      error: null,
    });
    await expect(claimOmarchyNativeActivation({
      userId: "user-1", sessionId: SESSION_ID,
      sessionToken: `hrs1_${"t".repeat(43)}`, activationId,
    })).resolves.toMatchObject({ ok: false, code: "invalid_activation_claim" });
  });

  it("records only an exact server-generated native guardian grant", async () => {
    const activationId = "88888888-8888-4888-8888-888888888888";
    const guardianGrant = {
      protocol: "hivra-omarchy-guardian-grant-v1",
      sessionId: SESSION_ID,
      leaseId: activationId,
    };
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "recorded", sessionId: SESSION_ID, activationId }, error: null,
    });
    await expect(recordOmarchyNativeActivationGrant({
      userId: "user-1", sessionId: SESSION_ID, activationId, guardianGrant,
    })).resolves.toEqual({ ok: true });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "record_hivra_omarchy_native_activation_grant",
      { p_user_id: "user-1", p_session_id: SESSION_ID, p_activation_id: activationId,
        p_guardian_grant: guardianGrant },
    );
  });

  it("loads one owner-bound persisted native guardian grant", async () => {
    const activationId = "88888888-8888-4888-8888-888888888888";
    const guardianGrant = { protocol: "hivra-omarchy-guardian-grant-v1" };
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "loaded", sessionId: SESSION_ID, activationId, guardianGrant }, error: null,
    });
    await expect(loadOmarchyNativeActivationGrant({
      userId: "user-1", sessionId: SESSION_ID, activationId,
    })).resolves.toEqual({ ok: true, guardianGrant });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "load_hivra_omarchy_native_activation_grant",
      { p_user_id: "user-1", p_session_id: SESSION_ID, p_activation_id: activationId },
    );
  });

  it("never returns an exchange secret if issue serialized against another capability generation", async () => {
    capabilityLookup();
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: {
        status: "issued",
        capabilityGeneration: "018f6d3c-1d91-7c65-9d86-37fc915b8380",
        streamingMode: "hq",
      },
      error: null,
    });

    await expect(issueRemoteDesktopSession(issueParams())).resolves.toMatchObject({
      ok: false,
      code: "capability_changed",
    });
  });

  it("never returns an exchange secret when the database does not confirm the requested profile", async () => {
    capabilityLookup();
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "issued", capabilityGeneration: GENERATION, streamingMode: "performance" },
      error: null,
    });

    await expect(issueRemoteDesktopSession(issueParams())).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "invalid_issue_receipt",
    });
  });

  it("fails closed without a current capability or safe controller takeover", async () => {
    capabilityLookup(null);
    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      code: "capability_unavailable",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();

    jest.clearAllMocks();
    capabilityLookup(capability({ supports_input_takeover: false }));
    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      code: "input_takeover_unavailable",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("honours explicit transport compatibility rather than silently falling back", async () => {
    capabilityLookup();
    const result = await issueRemoteDesktopSession(issueParams({
      requestedTransport: "selkies-webrtc",
      client: { kind: "browser", moonlight: false, webCodecs: true, udp: "blocked" },
    }));
    expect(result).toMatchObject({ ok: false, code: "transport_unavailable" });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("never turns a recovery-only capability into a daily-driver session", async () => {
    capabilityLookup(capability({ installed_transports: ["recovery-console"] }));

    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      code: "transport_unavailable",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("preserves a live controller as a serialized conflict", async () => {
    const lookup = controllerConflictLookup([{
      capability_generation: GENERATION,
      input_state: "active",
      revoked_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "controller_conflict" },
      error: null,
    });
    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      status: 409,
      code: "controller_conflict",
    });
    expect(lookup.eq).toHaveBeenCalledWith("input_role", "controller");
    expect(lookup.in).toHaveBeenCalledWith("input_state", ["takeover-pending", "active", "release-pending"]);
  });

  it("identifies release-pending without weakening the controller fence", async () => {
    controllerConflictLookup([{
      capability_generation: GENERATION,
      input_state: "release-pending",
      revoked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "controller_conflict" },
      error: null,
    });

    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      status: 409,
      code: "controller_releasing",
      error: "The previous desktop is still releasing this computer input lease.",
    });
  });

  it("fails closed when a controller conflict cannot be classified", async () => {
    controllerConflictLookup([], { message: "lookup failed" });
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "controller_conflict" },
      error: null,
    });

    expect(await issueRemoteDesktopSession(issueParams())).toMatchObject({
      ok: false,
      status: 409,
      code: "controller_conflict",
    });
  });

  it("exchanges PKCE once and returns a plaintext bearer that was never sent to storage", async () => {
    const lookup = protocolEvidenceLookup({
      session: sessionEvidence({ transport: "selkies-webrtc" }),
      capability: { observed_revision: PREDECESSOR_REVISION },
    });
    (supabaseAdmin!.rpc as jest.Mock).mockImplementation(async (name, args) => {
      expect(name).toBe("exchange_hivra_remote_desktop_session");
      expect(args.p_exchange_code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(args.p_pkce_challenge).toBe(PKCE);
      expect(args.p_session_token_hash).toMatch(/^[a-f0-9]{64}$/);
      return {
        data: {
          status: "exchanged",
          sessionId: SESSION_ID,
          computerKind: "hermes-instance",
          computerId: COMPUTER_ID,
          capabilityGeneration: GENERATION,
          transport: "selkies-webrtc",
          inputRole: "controller",
          inputReady: false,
          audience: `hivra-computer:hermes-instance:${COMPUTER_ID}:desktop`,
          brokerOrigin: "https://desktop.example.com",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      };
    });
    const exchangeCode = "e".repeat(43);
    const result = await exchangeRemoteDesktopSession({ exchangeCode, verifier: VERIFIER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.sessionToken).toMatch(/^hrs1_[A-Za-z0-9_-]{43}$/);
    const args = (supabaseAdmin!.rpc as jest.Mock).mock.calls[0][1];
    expect(JSON.stringify(args)).not.toContain(exchangeCode);
    expect(JSON.stringify(args)).not.toContain(result.grant.sessionToken);
    expect(result.grant.inputReady).toBe(false);
    expect(lookup.capabilityBuilder.maybeSingle).not.toHaveBeenCalled();
  });

  it("rejects a live predecessor Selkies handoff before consuming it", async () => {
    protocolEvidenceLookup({
      session: sessionEvidence(),
      capability: { observed_revision: PREDECESSOR_REVISION },
    });

    await expect(exchangeRemoteDesktopSession({
      exchangeCode: "e".repeat(43),
      verifier: VERIFIER,
    })).resolves.toMatchObject({
      ok: false,
      code: "desktop_upgrade_required",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed exchange material before touching storage", async () => {
    expect(await exchangeRemoteDesktopSession({ exchangeCode: "short", verifier: VERIFIER })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await exchangeRemoteDesktopSession({ exchangeCode: "e".repeat(43), verifier: "short" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
  });

  it.each(REMOTE_DESKTOP_SESSION_REVISIONS)("authorizes compatible revision %s with a token hash and the database input decision", async (revision) => {
    protocolEvidenceLookup({ capability: { observed_revision: revision } });
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "authorized", inputReady: true, sessionId: SESSION_ID },
      error: null,
    });
    const token = `hrs1_${"a".repeat(43)}`;
    const result = await authorizeRemoteDesktopSession({
      sessionToken: token,
      computerKind: "hermes-instance",
      computerId: COMPUTER_ID,
      transport: "selkies-websocket",
      wantsInput: true,
    });
    expect(result).toMatchObject({ ok: true, authorization: { inputReady: true } });
    const args = (supabaseAdmin!.rpc as jest.Mock).mock.calls[0][1];
    expect(args.p_session_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it.each(["hermes-instance", "hivra-agent"] as const)(
    "denies current use of a predecessor Selkies session for %s",
    async (computerKind) => {
      protocolEvidenceLookup({
        session: sessionEvidence({ computer_kind: computerKind }),
        capability: { observed_revision: PREDECESSOR_REVISION },
      });
      const token = `hrs1_${"a".repeat(43)}`;

      await expect(authorizeRemoteDesktopSession({
        sessionToken: token,
        computerKind,
        computerId: COMPUTER_ID,
        transport: "selkies-websocket",
        wantsInput: true,
      })).resolves.toMatchObject({
        ok: false,
        code: "desktop_upgrade_required",
      });
      expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(REMOTE_DESKTOP_SESSION_REVISIONS)("renews compatible revision %s only through the guest bearer hash", async (revision) => {
    const token = `hrs1_${"r".repeat(43)}`;
    const expiresAt = new Date(Date.now() + 240_000).toISOString();
    const continuousExpiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    protocolEvidenceLookup({ capability: { observed_revision: revision } });
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "renewed", sessionId: SESSION_ID, expiresAt, continuousExpiresAt, renewalCount: 2 },
      error: null,
    });

    await expect(renewRemoteDesktopSessionByToken({ sessionToken: token, ttlMs: 240_000 })).resolves.toEqual({
      ok: true,
      renewal: { sessionId: SESSION_ID, expiresAt, continuousExpiresAt, renewalCount: 2 },
    });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "renew_hivra_remote_desktop_session_by_token",
      { p_session_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/), p_ttl_seconds: 240 },
    );
    expect(JSON.stringify((supabaseAdmin!.rpc as jest.Mock).mock.calls[0][1])).not.toContain(token);
  });

  it("does not renew a predecessor Selkies session even when application-clock liveness disagrees", async () => {
    const token = `hrs1_${"r".repeat(43)}`;
    const lookup = protocolEvidenceLookup({
      session: sessionEvidence({
        issued_at: new Date(Date.now() + 60_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
      capability: { observed_revision: PREDECESSOR_REVISION },
    });

    await expect(renewRemoteDesktopSessionByToken({
      sessionToken: token,
      ttlMs: 240_000,
    })).resolves.toMatchObject({
      ok: false,
      code: "desktop_upgrade_required",
    });
    expect(supabaseAdmin!.rpc).not.toHaveBeenCalled();
    expect(lookup.sessionBuilder.eq).toHaveBeenCalledWith(
      "session_token_hash",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(JSON.stringify(lookup.sessionBuilder.eq.mock.calls)).not.toContain(token);
  });

  it("records capability and input receipts only through service-only RPCs", async () => {
    (supabaseAdmin!.rpc as jest.Mock)
      .mockResolvedValueOnce({ data: { status: "ready" }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const receipt = {
      protocol: "hivra-remote-desktop-capability-v1" as const,
      computerKind: "hermes-instance" as const,
      computerId: COMPUTER_ID,
      capabilityGeneration: GENERATION,
      observedRevision: "a".repeat(40),
      compositor: "x11" as const,
      installedTransports: ["selkies-websocket" as const],
      privateNetworkReachable: false,
      supportsInputTakeover: true,
      brokerOrigin: "https://desktop.example.com",
      observedAt: new Date().toISOString(),
    };
    expect(await recordRemoteDesktopCapability({
      userId: "user-1",
      receipt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).toEqual({ ok: true, generation: GENERATION });
    expect(await confirmRemoteDesktopInputTransition({
      userId: "user-1",
      receipt: {
        protocol: "hivra-remote-desktop-input-v1",
        action: "agent-input-suspended",
        sessionId: SESSION_ID,
        computerKind: "hermes-instance",
        computerId: COMPUTER_ID,
        capabilityGeneration: GENERATION,
        transport: "selkies-websocket",
        agentInputSuspended: true,
        controllerCount: 1,
        observedAt: new Date().toISOString(),
      },
    })).toEqual({ ok: true });
    expect((supabaseAdmin!.rpc as jest.Mock).mock.calls.map(([name]) => name)).toEqual([
      "record_hivra_remote_desktop_capability",
      "confirm_hivra_remote_desktop_takeover",
    ]);
  });

  it("records trusted boot evidence outside the strict capability receipt", async () => {
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: { status: "ready" }, error: null });
    const bootIdentitySha256 = "f".repeat(64);
    const receipt = {
      protocol: "hivra-remote-desktop-capability-v1" as const,
      computerKind: "hivra-agent" as const,
      computerId: COMPUTER_ID,
      capabilityGeneration: GENERATION,
      bootIdentitySha256,
      observedRevision: "a".repeat(64),
      compositor: "x11" as const,
      installedTransports: ["selkies-websocket" as const],
      privateNetworkReachable: false,
      supportsInputTakeover: true,
      brokerOrigin: "https://desktop.example.com",
      observedAt: new Date().toISOString(),
    };
    expect(await recordRemoteDesktopCapability({
      userId: "user-1", receipt, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).toEqual({ ok: true, generation: GENERATION });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "record_hivra_remote_desktop_capability_v2",
      expect.objectContaining({
        p_boot_identity_sha256: bootIdentitySha256,
        p_receipt: expect.not.objectContaining({ bootIdentitySha256: expect.anything() }),
      }),
    );
    expect(await recordRemoteDesktopCapability({
      userId: "user-1", receipt: { ...receipt, bootIdentitySha256: "INVALID" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).toMatchObject({ ok: false, code: "invalid_receipt" });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledTimes(1);
  });

  it("revokes only the owner's exact session and reports release-pending", async () => {
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({
      data: { status: "revoked", inputState: "release-pending" },
      error: null,
    });
    expect(await revokeRemoteDesktopSession({
      userId: "user-1",
      sessionId: SESSION_ID,
      reason: "user_revoked",
    })).toEqual({ ok: true, inputState: "release-pending" });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "revoke_hivra_remote_desktop_session",
      expect.objectContaining({ p_user_id: "user-1", p_session_id: SESSION_ID }),
    );
  });

  it("revokes the exact current capability generation and treats absence as clean", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.select = jest.fn(() => builder);
    builder.eq = jest.fn(() => builder);
    builder.is = jest.fn(() => builder);
    builder.maybeSingle = jest.fn().mockResolvedValue({ data: { generation: GENERATION }, error: null });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(builder);
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValue({ data: true, error: null });

    await expect(revokeRemoteDesktopCapability({
      userId: "user-1",
      computerKind: "hermes-instance",
      computerId: COMPUTER_ID,
    })).resolves.toEqual({ ok: true, revoked: true });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith(
      "revoke_hivra_remote_desktop_capability",
      {
        p_user_id: "user-1",
        p_computer_kind: "hermes-instance",
        p_computer_id: COMPUTER_ID,
        p_generation: GENERATION,
      },
    );

    jest.clearAllMocks();
    capabilityLookup(null);
    await expect(revokeRemoteDesktopCapability({
      userId: "user-1",
      computerKind: "hermes-instance",
      computerId: COMPUTER_ID,
    })).resolves.toEqual({ ok: true, revoked: false });
  });
});
