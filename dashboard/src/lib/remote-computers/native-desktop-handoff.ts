export type NativeDesktopStreamingMode = "hq" | "qhd" | "uhd" | "performance";

type NativeBridge = {
  postMessage(message: Record<string, unknown>): Promise<unknown>;
};

type Dependencies = {
  crypto: Pick<Crypto, "getRandomValues" | "randomUUID" | "subtle">;
  fetch: typeof fetch;
  bridge: NativeBridge;
};

type PreparedProfile = {
  sessionId: string;
  clientId: string;
  clientCertificatePem: string;
  clientCertificateSha256: string;
  streamingMode: NativeDesktopStreamingMode;
};

export type NativeDesktopHandoff = PreparedProfile & {
  exchangeCode: string;
  verifier: string;
  brokerOrigin: string;
  expiresAt: string;
};

export type NativeDesktopHandoffResult =
  | { ok: true; handoff: NativeDesktopHandoff }
  | { ok: false; code: string; profileReleasePending: boolean; sessionReleasePending: boolean };

export type NativeDesktopActivationResult =
  | { ok: true; handoff: NativeDesktopHandoff; sessionToken: string; activationId: string;
      launched: true; processIdentifier: number;
      server: { id: string; certificatePem: string; certificateSha256: string;
        guestBootId: string; connectionIpv4: string } }
  | { ok: false; code: string; profileReleasePending: boolean; sessionReleasePending: boolean };

export type NativeDesktopStopResult =
  | { ok: true; sessionId: string; activationId: string; localProcessStopped: boolean;
      controllerReleased: true; desktopReady: false }
  | { ok: false; code: string; localProcessStopPending: boolean; sessionReleasePending: boolean };

export type NativeDesktopRenewalResult =
  | { ok: true; sessionId: string; activationId: string; renewalId: string;
      renewalCount: number; expiresAt: string; continuousExpiresAt: string; desktopReady: true }
  | { ok: false; code: string; deadlineUnchanged: true };

export type NativeDesktopProcessStatus =
  | { ok: true; sessionId: string; processIdentifier: number; running: boolean }
  | { ok: false; code: "native_status_uncertain" };

export type NativeDesktopFocusResult =
  | { ok: true; sessionId: string; processIdentifier: number }
  | { ok: false; code: "native_focus_uncertain" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EXCHANGE_CODE = /^[A-Za-z0-9_-]{43}$/;
function isPrivateIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isRoutableIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] !== 0 && octets[0] !== 127 && octets[0] < 224
    && !(octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && wanted.every((key, index) => actual[index] === key);
}

function parsePreparedProfile(raw: unknown, sessionId: string): PreparedProfile | null {
  const value = record(raw);
  if (!value || !exactKeys(value, [
    "type", "sessionId", "clientId", "clientCertificatePem",
    "clientCertificateSha256", "streamingMode",
  ])) return null;
  const pem = typeof value.clientCertificatePem === "string" ? value.clientCertificatePem : "";
  if (
    value.type !== "hivra.native-desktop.profile-ready.v1"
    || value.sessionId !== sessionId || typeof value.clientId !== "string" || !UUID.test(value.clientId)
    || typeof value.clientCertificateSha256 !== "string" || !SHA256.test(value.clientCertificateSha256)
    || !["hq", "qhd", "uhd", "performance"].includes(String(value.streamingMode))
    || pem.length < 64 || pem.length > 16_384
    || !pem.startsWith("-----BEGIN CERTIFICATE-----\n")
    || !pem.endsWith("-----END CERTIFICATE-----\n")
  ) return null;
  return {
    sessionId,
    clientId: value.clientId,
    clientCertificatePem: pem,
    clientCertificateSha256: value.clientCertificateSha256,
    streamingMode: value.streamingMode as NativeDesktopStreamingMode,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function newPkce(cryptoApi: Dependencies["crypto"]): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(cryptoApi.getRandomValues(new Uint8Array(32)));
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

async function discardProfile(bridge: NativeBridge, sessionId: string): Promise<boolean> {
  try {
    const raw = record(await bridge.postMessage({
      type: "hivra.native-desktop.discard-profile.v1",
      sessionId,
    }));
    return Boolean(raw && exactKeys(raw, ["type", "sessionId"])
      && raw.type === "hivra.native-desktop.profile-discarded.v1" && raw.sessionId === sessionId);
  } catch {
    return false;
  }
}

async function revokeSession(fetchApi: typeof fetch, sessionId: string): Promise<boolean> {
  try {
    const response = await fetchApi(`/api/remote-desktop/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export function browserNativeDesktopDependencies(): Dependencies | null {
  if (typeof window === "undefined" || !window.crypto?.subtle || !window.crypto.randomUUID) return null;
  const bridge = (window as unknown as {
    webkit?: { messageHandlers?: { hivraNativeDesktop?: NativeBridge } };
  }).webkit?.messageHandlers?.hivraNativeDesktop;
  return bridge?.postMessage ? { crypto: window.crypto, fetch: window.fetch.bind(window), bridge } : null;
}

/** Read the exact app-owned Moonlight process state without changing it. */
export async function inspectNativeDesktopProcess(
  params: { sessionId: string; processIdentifier: number },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopProcessStatus> {
  if (!dependencies || !UUID.test(params.sessionId)
    || !Number.isSafeInteger(params.processIdentifier) || params.processIdentifier <= 0) {
    return { ok: false, code: "native_status_uncertain" };
  }
  try {
    const value = record(await dependencies.bridge.postMessage({
      type: "hivra.native-desktop.status.v1",
      sessionId: params.sessionId,
      processIdentifier: params.processIdentifier,
    }));
    if (!value || !exactKeys(value, ["type", "sessionId", "processIdentifier", "running"])
      || value.type !== "hivra.native-desktop.status-result.v1"
      || value.sessionId !== params.sessionId || value.processIdentifier !== params.processIdentifier
      || typeof value.running !== "boolean") return { ok: false, code: "native_status_uncertain" };
    return { ok: true, sessionId: params.sessionId,
      processIdentifier: params.processIdentifier, running: value.running };
  } catch {
    return { ok: false, code: "native_status_uncertain" };
  }
}

/** Bring the exact app-owned Moonlight stream back to the foreground. */
export async function focusNativeDesktopProcess(
  params: { sessionId: string; processIdentifier: number },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopFocusResult> {
  if (!dependencies || !UUID.test(params.sessionId)
    || !Number.isSafeInteger(params.processIdentifier) || params.processIdentifier <= 0) {
    return { ok: false, code: "native_focus_uncertain" };
  }
  try {
    const value = record(await dependencies.bridge.postMessage({
      type: "hivra.native-desktop.focus.v1",
      sessionId: params.sessionId,
      processIdentifier: params.processIdentifier,
    }));
    if (!value || !exactKeys(value, ["type", "sessionId", "processIdentifier"])
      || value.type !== "hivra.native-desktop.focused.v1"
      || value.sessionId !== params.sessionId || value.processIdentifier !== params.processIdentifier) {
      return { ok: false, code: "native_focus_uncertain" };
    }
    return { ok: true, sessionId: params.sessionId, processIdentifier: params.processIdentifier };
  } catch {
    return { ok: false, code: "native_focus_uncertain" };
  }
}

/** Prepare one app-owned profile and bind it to one server session. */
export async function prepareNativeDesktopHandoff(
  params: { computerId: string; udp: "direct" | "relay"; streamingMode: NativeDesktopStreamingMode },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopHandoffResult> {
  if (!UUID.test(params.computerId) || !["direct", "relay"].includes(params.udp)
    || !["hq", "qhd", "uhd", "performance"].includes(params.streamingMode) || !dependencies) {
    return {
      ok: false,
      code: "native_client_unavailable",
      profileReleasePending: false,
      sessionReleasePending: false,
    };
  }
  const sessionId = dependencies.crypto.randomUUID().toLowerCase();
  let issueStarted = false;
  try {
    const profile = parsePreparedProfile(await dependencies.bridge.postMessage({
      type: "hivra.native-desktop.prepare-profile.v1",
      sessionId,
      streamingMode: params.streamingMode,
    }), sessionId);
    if (!profile || profile.streamingMode !== params.streamingMode) {
      const released = await discardProfile(dependencies.bridge, sessionId);
      return {
        ok: false,
        code: "invalid_native_profile",
        profileReleasePending: !released,
        sessionReleasePending: false,
      };
    }
    const { verifier, challenge } = await newPkce(dependencies.crypto);
    issueStarted = true;
    const response = await dependencies.fetch("/api/remote-desktop/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        computerKind: "hivra-agent",
        computerId: params.computerId,
        purpose: "daily-driver",
        inputRole: "controller",
        streamingMode: profile.streamingMode,
        requestedTransport: "sunshine-moonlight",
        client: { kind: "native", moonlight: true, webCodecs: false, udp: params.udp },
        nativeProfile: {
          clientId: profile.clientId,
          clientCertificatePem: profile.clientCertificatePem,
          clientCertificateSha256: profile.clientCertificateSha256,
        },
        pkceChallenge: challenge,
        ttlSeconds: 240,
      }),
    });
    const payload = record(await response.json().catch(() => null));
    const data = record(payload?.data);
    let brokerOrigin = "";
    try {
      const parsed = new URL(String(data?.brokerOrigin ?? ""));
      if (
        parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
        && parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
      ) brokerOrigin = parsed.origin;
    } catch {
      brokerOrigin = "";
    }
    if (
      !response.ok || payload?.success !== true || !data
      || data.id !== sessionId || data.streamingMode !== profile.streamingMode
      || data.handoff !== "message" || data.transport !== "sunshine-moonlight"
      || data.inputRole !== "controller" || typeof data.exchangeCode !== "string"
      || !EXCHANGE_CODE.test(data.exchangeCode) || !brokerOrigin
      || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))
    ) {
      const sessionReleased = await revokeSession(dependencies.fetch, sessionId);
      const released = await discardProfile(dependencies.bridge, sessionId);
      return {
        ok: false,
        code: typeof payload?.code === "string" ? payload.code : "native_session_issue_failed",
        profileReleasePending: !released,
        sessionReleasePending: !sessionReleased,
      };
    }
    return {
      ok: true,
      handoff: {
        ...profile,
        exchangeCode: data.exchangeCode,
        verifier,
        brokerOrigin,
        expiresAt: data.expiresAt,
      },
    };
  } catch {
    const sessionReleased = !issueStarted || await revokeSession(dependencies.fetch, sessionId);
    const released = await discardProfile(dependencies.bridge, sessionId);
    return {
      ok: false,
      code: "native_session_issue_failed",
      profileReleasePending: !released,
      sessionReleasePending: !sessionReleased,
    };
  }
}

/** Exchange and dispatch one prepared native Omarchy session exactly once. */
export async function activateNativeOmarchyDesktop(
  params: { computerId: string; udp: "direct" | "relay"; streamingMode: NativeDesktopStreamingMode },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopActivationResult> {
  if (params.udp === "relay") {
    return { ok: false, code: "native_relay_unavailable", profileReleasePending: false, sessionReleasePending: false };
  }
  const prepared = await prepareNativeDesktopHandoff(params, dependencies);
  if (!prepared.ok) return prepared;
  if (!dependencies) {
    return { ok: false, code: "native_client_unavailable", profileReleasePending: false, sessionReleasePending: false };
  }
  const { handoff } = prepared;
  try {
    const exchangeResponse = await dependencies.fetch("/api/remote-desktop/sessions/exchange", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exchangeCode: handoff.exchangeCode, verifier: handoff.verifier }),
    });
    const exchangePayload = record(await exchangeResponse.json().catch(() => null));
    const grant = record(exchangePayload?.data);
    const sessionToken = typeof grant?.sessionToken === "string" ? grant.sessionToken : "";
    if (
      !exchangeResponse.ok || exchangePayload?.success !== true || !grant
      || grant.sessionId !== handoff.sessionId || grant.computerKind !== "hivra-agent"
      || grant.computerId !== params.computerId || grant.transport !== "sunshine-moonlight"
      || grant.inputRole !== "controller" || grant.inputReady !== false
      || !/^hrs1_[A-Za-z0-9_-]{43}$/.test(sessionToken)
    ) return { ok: false, code: "native_exchange_uncertain", profileReleasePending: true, sessionReleasePending: true };

    const activationResponse = await dependencies.fetch("/api/remote-desktop/native/omarchy/activate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ computerId: params.computerId, sessionId: handoff.sessionId, sessionToken }),
    });
    const activationPayload = record(await activationResponse.json().catch(() => null));
    const activation = record(activationPayload?.data);
    const activationId = typeof activation?.activationId === "string" ? activation.activationId : "";
    const serverCertificatePem = typeof activation?.serverCertificatePem === "string"
      ? activation.serverCertificatePem : "";
    if (!activationResponse.ok && activationPayload?.code === "computer_not_ready") {
      const sessionReleased = await revokeSession(dependencies.fetch, handoff.sessionId);
      const released = await discardProfile(dependencies.bridge, handoff.sessionId);
      return {
        ok: false,
        code: "computer_not_ready",
        profileReleasePending: !released,
        sessionReleasePending: !sessionReleased,
      };
    }
    if (
      !activationResponse.ok || activationPayload?.success !== true || !activation
      || activation.ok !== true || activation.sessionId !== handoff.sessionId
      || activation.streamingMode !== handoff.streamingMode || !UUID.test(activationId)
      || activation.desktopReady !== true || activation.pairingVerified !== true
      || activation.serverId !== params.computerId
      || typeof activation.guestBootId !== "string" || !UUID.test(activation.guestBootId)
      || !isPrivateIpv4(activation.guestPrivateIpv4)
      || !isRoutableIpv4(activation.connectionIpv4)
      || typeof activation.serverCertificateSha256 !== "string"
      || !SHA256.test(activation.serverCertificateSha256)
      || serverCertificatePem.length < 64 || serverCertificatePem.length > 16_384
      || !serverCertificatePem.startsWith("-----BEGIN CERTIFICATE-----\n")
      || !serverCertificatePem.endsWith("-----END CERTIFICATE-----\n")
    ) return {
      ok: false,
      code: typeof activationPayload?.code === "string" ? activationPayload.code : "native_activation_uncertain",
      profileReleasePending: true,
      sessionReleasePending: true,
    };
    const launched = record(await dependencies.bridge.postMessage({
      type: "hivra.native-desktop.launch.v1",
      sessionId: handoff.sessionId,
      serverId: params.computerId,
      serverCertificatePem,
      serverCertificateSha256: activation.serverCertificateSha256,
      guestBootId: activation.guestBootId,
      connectionIpv4: activation.connectionIpv4,
      transport: params.udp,
    }));
    const processIdentifier = Number(launched?.processIdentifier);
    if (!launched || !exactKeys(launched, [
      "type", "sessionId", "streamingMode", "processIdentifier",
    ]) || launched.type !== "hivra.native-desktop.launched.v1"
      || launched.sessionId !== handoff.sessionId
      || launched.streamingMode !== handoff.streamingMode
      || !Number.isSafeInteger(processIdentifier) || processIdentifier <= 0) {
      return { ok: false, code: "native_launch_uncertain", profileReleasePending: true, sessionReleasePending: true };
    }
    return {
      ok: true,
      handoff,
      sessionToken,
      activationId,
      launched: true,
      processIdentifier,
      server: {
        id: params.computerId,
        certificatePem: serverCertificatePem,
        certificateSha256: String(activation.serverCertificateSha256),
        guestBootId: String(activation.guestBootId),
        connectionIpv4: String(activation.connectionIpv4),
      },
    };
  } catch {
    return { ok: false, code: "native_activation_uncertain", profileReleasePending: true, sessionReleasePending: true };
  }
}

/** Stop the exact app process and prove server-side guardian release. */
export async function stopNativeOmarchyDesktop(
  params: { computerId: string; sessionId: string; activationId: string; processIdentifier: number },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopStopResult> {
  if (
    !dependencies || !UUID.test(params.computerId) || !UUID.test(params.sessionId)
    || !UUID.test(params.activationId) || !Number.isSafeInteger(params.processIdentifier)
    || params.processIdentifier <= 0
  ) return { ok: false, code: "native_stop_denied", localProcessStopPending: false, sessionReleasePending: false };
  let localProcessStopped = false;
  try {
    const stopped = record(await dependencies.bridge.postMessage({
      type: "hivra.native-desktop.stop.v1",
      sessionId: params.sessionId,
      processIdentifier: params.processIdentifier,
    }));
    localProcessStopped = Boolean(stopped && exactKeys(stopped, [
      "type", "sessionId", "processIdentifier",
    ]) && stopped.type === "hivra.native-desktop.stopped.v1"
      && stopped.sessionId === params.sessionId
      && stopped.processIdentifier === params.processIdentifier);
  } catch {
    localProcessStopped = false;
  }
  try {
    const response = await dependencies.fetch("/api/remote-desktop/native/omarchy/stop", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        computerId: params.computerId,
        sessionId: params.sessionId,
        activationId: params.activationId,
      }),
    });
    const payload = record(await response.json().catch(() => null));
    const data = record(payload?.data);
    if (!response.ok || payload?.success !== true || !data || !exactKeys(data, [
      "ok", "sessionId", "activationId", "controllerReleased", "desktopReady",
    ]) || data.ok !== true || data.sessionId !== params.sessionId
      || data.activationId !== params.activationId || data.controllerReleased !== true
      || data.desktopReady !== false) {
      return {
        ok: false,
        code: typeof payload?.code === "string" ? payload.code : "native_stop_uncertain",
        localProcessStopPending: !localProcessStopped,
        sessionReleasePending: true,
      };
    }
    return {
      ok: true,
      sessionId: params.sessionId,
      activationId: params.activationId,
      localProcessStopped,
      controllerReleased: true,
      desktopReady: false,
    };
  } catch {
    return {
      ok: false,
      code: "native_stop_uncertain",
      localProcessStopPending: !localProcessStopped,
      sessionReleasePending: true,
    };
  }
}

/** Extend the same running guardian; never replace or relaunch Moonlight. */
export async function renewNativeOmarchyDesktop(
  params: { computerId: string; sessionId: string; activationId: string; renewalId: string },
  dependencies: Dependencies | null = browserNativeDesktopDependencies(),
): Promise<NativeDesktopRenewalResult> {
  if (
    !dependencies || !UUID.test(params.computerId) || !UUID.test(params.sessionId)
    || !UUID.test(params.activationId) || !UUID.test(params.renewalId)
  ) return { ok: false, code: "native_renewal_denied", deadlineUnchanged: true };
  try {
    const response = await dependencies.fetch("/api/remote-desktop/native/omarchy/renew", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const payload = record(await response.json().catch(() => null));
    const data = record(payload?.data);
    const renewalCount = Number(data?.renewalCount);
    const expiresAt = typeof data?.expiresAt === "string" ? data.expiresAt : "";
    const continuousExpiresAt = typeof data?.continuousExpiresAt === "string"
      ? data.continuousExpiresAt : "";
    if (
      !response.ok || payload?.success !== true || !data || !exactKeys(data, [
        "ok", "sessionId", "activationId", "renewalId", "renewalCount",
        "expiresAt", "continuousExpiresAt", "desktopReady",
      ]) || data.ok !== true || data.sessionId !== params.sessionId
      || data.activationId !== params.activationId || data.renewalId !== params.renewalId
      || !Number.isSafeInteger(renewalCount) || renewalCount < 1 || renewalCount > 240
      || !Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(Date.parse(continuousExpiresAt))
      || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.parse(continuousExpiresAt)
      || data.desktopReady !== true
    ) return { ok: false, code: typeof payload?.code === "string"
      ? payload.code : "native_renewal_uncertain", deadlineUnchanged: true };
    return { ok: true, sessionId: params.sessionId, activationId: params.activationId,
      renewalId: params.renewalId, renewalCount, expiresAt, continuousExpiresAt, desktopReady: true };
  } catch {
    return { ok: false, code: "native_renewal_uncertain", deadlineUnchanged: true };
  }
}
