import {
  activateNativeOmarchyDesktop,
  focusNativeDesktopProcess,
  inspectNativeDesktopProcess,
  prepareNativeDesktopHandoff,
  renewNativeOmarchyDesktop,
  stopNativeOmarchyDesktop,
} from "../native-desktop-handoff";
import { webcrypto } from "node:crypto";

const COMPUTER_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
const SESSION_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8379";
const CLIENT_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8380";
const BOOT_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8382";
const PEM = `-----BEGIN CERTIFICATE-----\n${"a".repeat(96)}\n-----END CERTIFICATE-----\n`;
const SERVER_PEM = `-----BEGIN CERTIFICATE-----\n${"b".repeat(96)}\n-----END CERTIFICATE-----\n`;

function dependencies(options: {
  profile?: Record<string, unknown>;
  issue?: { status: number; body: Record<string, unknown> };
  exchange?: { status: number; body: Record<string, unknown> };
  activation?: { status: number; body: Record<string, unknown> };
  discardFails?: boolean;
  launchFails?: boolean;
  localStopFails?: boolean;
  processRunning?: boolean;
  serverStop?: { status: number; body: Record<string, unknown> };
  serverRenew?: { status: number; body: Record<string, unknown> };
} = {}) {
  const profile = options.profile ?? {
    type: "hivra.native-desktop.profile-ready.v1",
    sessionId: SESSION_ID,
    clientId: CLIENT_ID,
    clientCertificatePem: PEM,
    clientCertificateSha256: "a".repeat(64),
    streamingMode: "performance",
  };
  const bridge = {
    postMessage: jest.fn(async (message: Record<string, unknown>) => {
      if (message.type === "hivra.native-desktop.prepare-profile.v1") return profile;
      if (message.type === "hivra.native-desktop.launch.v1") {
        if (options.launchFails) throw new Error("launch acknowledgement unavailable");
        return {
          type: "hivra.native-desktop.launched.v1", sessionId: SESSION_ID,
          streamingMode: "performance", processIdentifier: 4242,
        };
      }
      if (message.type === "hivra.native-desktop.stop.v1") {
        if (options.localStopFails) throw new Error("local stop acknowledgement unavailable");
        return {
          type: "hivra.native-desktop.stopped.v1", sessionId: SESSION_ID,
          processIdentifier: message.processIdentifier,
        };
      }
      if (message.type === "hivra.native-desktop.status.v1") return {
        type: "hivra.native-desktop.status-result.v1", sessionId: SESSION_ID,
        processIdentifier: message.processIdentifier, running: options.processRunning ?? true,
      };
      if (message.type === "hivra.native-desktop.focus.v1") return {
        type: "hivra.native-desktop.focused.v1", sessionId: SESSION_ID,
        processIdentifier: message.processIdentifier,
      };
      if (options.discardFails) throw new Error("discard unavailable");
      return {
        type: "hivra.native-desktop.profile-discarded.v1",
        sessionId: message.sessionId,
      };
    }),
  };
  const issue = options.issue ?? {
    status: 201,
    body: {
      success: true,
      data: {
        id: SESSION_ID,
        exchangeCode: "e".repeat(43),
        handoff: "message",
        transport: "sunshine-moonlight",
        inputRole: "controller",
        streamingMode: "performance",
        brokerOrigin: "https://desktop.example.test",
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      },
    },
  };
  const fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    if (String(_input).endsWith("/native/omarchy/stop")) {
      const stopped = options.serverStop ?? { status: 200, body: { success: true, data: {
        ok: true, sessionId: SESSION_ID,
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        controllerReleased: true, desktopReady: false,
      } } };
      return new Response(JSON.stringify(stopped.body), { status: stopped.status,
        headers: { "content-type": "application/json" } });
    }
    if (String(_input).endsWith("/native/omarchy/renew")) {
      const renewed = options.serverRenew ?? { status: 200, body: { success: true, data: {
        ok: true, sessionId: SESSION_ID,
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        renewalId: "018f6d3c-1d91-7c65-9d86-37fc915b8384", renewalCount: 1,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        continuousExpiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
        desktopReady: true,
      } } };
      return new Response(JSON.stringify(renewed.body), { status: renewed.status,
        headers: { "content-type": "application/json" } });
    }
    if (String(_input).endsWith("/exchange")) {
      const exchange = options.exchange ?? { status: 200, body: { success: true, data: {
        sessionToken: `hrs1_${"t".repeat(43)}`, sessionId: SESSION_ID,
        computerKind: "hivra-agent", computerId: COMPUTER_ID,
        transport: "sunshine-moonlight", inputRole: "controller", inputReady: false,
      } } };
      return new Response(JSON.stringify(exchange.body), { status: exchange.status,
        headers: { "content-type": "application/json" } });
    }
    if (String(_input).endsWith("/native/omarchy/activate")) {
      const activation = options.activation ?? { status: 200, body: { success: true, data: {
        ok: true, sessionId: SESSION_ID, activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        streamingMode: "performance", desktopReady: true, pairingVerified: true,
        guestBootId: BOOT_ID, serverId: COMPUTER_ID, guestPrivateIpv4: "10.240.20.99",
        connectionIpv4: "198.51.100.11",
        serverCertificatePem: SERVER_PEM, serverCertificateSha256: "b".repeat(64),
      } } };
      return new Response(JSON.stringify(activation.body), { status: activation.status,
        headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(issue.body), {
      status: issue.status,
      headers: { "content-type": "application/json" },
    });
  });
  const cryptoApi = {
    randomUUID: (() => SESSION_ID) as Crypto["randomUUID"],
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto) as Crypto["getRandomValues"],
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  };
  return { dependencies: { bridge, fetch, crypto: cryptoApi }, bridge, fetch };
}

describe("native desktop dashboard handoff", () => {
  it("focuses only the exact app-owned Moonlight process", async () => {
    const fixture = dependencies();
    await expect(focusNativeDesktopProcess({
      sessionId: SESSION_ID, processIdentifier: 4242,
    }, fixture.dependencies)).resolves.toEqual({
      ok: true, sessionId: SESSION_ID, processIdentifier: 4242,
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledWith({
      type: "hivra.native-desktop.focus.v1", sessionId: SESSION_ID, processIdentifier: 4242,
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("reads the exact app-owned Moonlight process without changing it", async () => {
    const fixture = dependencies({ processRunning: false });
    await expect(inspectNativeDesktopProcess({
      sessionId: SESSION_ID, processIdentifier: 4242,
    }, fixture.dependencies)).resolves.toEqual({
      ok: true, sessionId: SESSION_ID, processIdentifier: 4242, running: false,
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledWith({
      type: "hivra.native-desktop.status.v1", sessionId: SESSION_ID, processIdentifier: 4242,
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("binds the app-selected profile and UUID to the native Sunshine session", async () => {
    const fixture = dependencies();
    const result = await prepareNativeDesktopHandoff(
      { computerId: COMPUTER_ID, udp: "relay", streamingMode: "performance" },
      fixture.dependencies,
    );
    expect(result).toMatchObject({
      ok: true,
      handoff: {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        streamingMode: "performance",
        exchangeCode: "e".repeat(43),
      },
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.postMessage).toHaveBeenCalledWith({
      type: "hivra.native-desktop.prepare-profile.v1",
      sessionId: SESSION_ID,
      streamingMode: "performance",
    });
    const request = JSON.parse(String(fixture.fetch.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      sessionId: SESSION_ID,
      computerId: COMPUTER_ID,
      streamingMode: "performance",
      requestedTransport: "sunshine-moonlight",
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "relay" },
      nativeProfile: {
        clientId: CLIENT_ID,
        clientCertificatePem: PEM,
        clientCertificateSha256: "a".repeat(64),
      },
    });
    expect(request.pkceChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(request)).not.toContain("PRIVATE KEY");
  });

  it("discards an untrusted profile response before returning", async () => {
    const fixture = dependencies({
      profile: {
        type: "hivra.native-desktop.profile-ready.v1",
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        clientCertificatePem: PEM,
        clientCertificateSha256: "a".repeat(64),
        streamingMode: "hq",
        executable: "/Applications/Moonlight.app",
      },
    });
    await expect(prepareNativeDesktopHandoff(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "invalid_native_profile",
      profileReleasePending: false,
      sessionReleasePending: false,
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.bridge.postMessage).toHaveBeenLastCalledWith({
      type: "hivra.native-desktop.discard-profile.v1",
      sessionId: SESSION_ID,
    });
  });

  it("discards a profile if the app does not bind the explicitly selected mode", async () => {
    const fixture = dependencies({
      profile: {
        type: "hivra.native-desktop.profile-ready.v1",
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        clientCertificatePem: PEM,
        clientCertificateSha256: "a".repeat(64),
        streamingMode: "hq",
      },
    });
    await expect(prepareNativeDesktopHandoff(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "invalid_native_profile",
      profileReleasePending: false,
      sessionReleasePending: false,
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.bridge.postMessage).toHaveBeenLastCalledWith({
      type: "hivra.native-desktop.discard-profile.v1",
      sessionId: SESSION_ID,
    });
  });

  it("discards the profile when session issue is rejected", async () => {
    const fixture = dependencies({
      issue: { status: 409, body: { success: false, code: "capability_unavailable" } },
    });
    await expect(prepareNativeDesktopHandoff(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "capability_unavailable",
      profileReleasePending: false,
      sessionReleasePending: false,
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledTimes(2);
    expect(fixture.fetch).toHaveBeenCalledWith(
      `/api/remote-desktop/sessions/${SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("reports rather than hiding an uncertain profile cleanup", async () => {
    const fixture = dependencies({
      issue: { status: 409, body: { success: false, code: "capability_unavailable" } },
      discardFails: true,
    });
    await expect(prepareNativeDesktopHandoff(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "capability_unavailable",
      profileReleasePending: true,
      sessionReleasePending: false,
    });
  });

  it("exchanges and activates one prepared Omarchy session", async () => {
    const fixture = dependencies();
    await expect(activateNativeOmarchyDesktop(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toMatchObject({
      ok: true,
      sessionToken: `hrs1_${"t".repeat(43)}`,
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      launched: true, processIdentifier: 4242,
      handoff: { sessionId: SESSION_ID, streamingMode: "performance" },
      server: { id: COMPUTER_ID, certificatePem: SERVER_PEM,
        certificateSha256: "b".repeat(64), guestBootId: BOOT_ID, connectionIpv4: "198.51.100.11" },
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.bridge.postMessage).toHaveBeenCalledTimes(2);
    const exchange = JSON.parse(String(fixture.fetch.mock.calls[1]?.[1]?.body));
    expect(exchange).toMatchObject({ exchangeCode: "e".repeat(43) });
    const activation = JSON.parse(String(fixture.fetch.mock.calls[2]?.[1]?.body));
    expect(activation).toEqual({
      computerId: COMPUTER_ID,
      sessionId: SESSION_ID,
      sessionToken: `hrs1_${"t".repeat(43)}`,
    });
    expect(fixture.bridge.postMessage).toHaveBeenLastCalledWith({
      type: "hivra.native-desktop.launch.v1",
      sessionId: SESSION_ID,
      serverId: COMPUTER_ID,
      serverCertificatePem: SERVER_PEM,
      serverCertificateSha256: "b".repeat(64),
      guestBootId: BOOT_ID,
      connectionIpv4: "198.51.100.11",
      transport: "direct",
    });
  });

  it("retains the client profile when dispatch outcome is uncertain", async () => {
    const fixture = dependencies({
      activation: { status: 409, body: { success: false, code: "activation_uncertain" } },
    });
    await expect(activateNativeOmarchyDesktop(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "activation_uncertain",
      profileReleasePending: true,
      sessionReleasePending: true,
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledTimes(1);
    expect(fixture.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining(`/sessions/${SESSION_ID}`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("releases a session whose guest capability became stale before activation", async () => {
    const fixture = dependencies({
      activation: { status: 409, body: { success: false, code: "computer_not_ready" } },
    });
    await expect(activateNativeOmarchyDesktop(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false,
      code: "computer_not_ready",
      profileReleasePending: false,
      sessionReleasePending: false,
    });
    expect(fixture.fetch).toHaveBeenCalledWith(
      `/api/remote-desktop/sessions/${SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fixture.bridge.postMessage).toHaveBeenLastCalledWith({
      type: "hivra.native-desktop.discard-profile.v1",
      sessionId: SESSION_ID,
    });
  });

  it("holds a ready response whose server identity or private route is changed", async () => {
    for (const changed of [
      { serverId: "018f6d3c-1d91-7c65-9d86-37fc915b8383" },
      { guestPrivateIpv4: "8.8.8.8" },
      { guestPrivateIpv4: "10.70.20.999" },
      { connectionIpv4: "127.0.0.1" },
      { connectionIpv4: "999.1.1.1" },
      { desktopReady: false },
      { serverCertificateSha256: "invalid" },
    ]) {
      const fixture = dependencies({ activation: { status: 200, body: { success: true, data: {
        ok: true, sessionId: SESSION_ID,
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        streamingMode: "performance", desktopReady: true, pairingVerified: true,
        guestBootId: BOOT_ID, serverId: COMPUTER_ID, guestPrivateIpv4: "10.240.20.99",
        connectionIpv4: "198.51.100.11",
        serverCertificatePem: SERVER_PEM, serverCertificateSha256: "b".repeat(64),
        ...changed,
      } } } });
      await expect(activateNativeOmarchyDesktop(
        { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
      )).resolves.toMatchObject({ ok: false, code: "native_activation_uncertain" });
    }
  });

  it("does not create a session for a relay until a local relay is implemented", async () => {
    const fixture = dependencies();
    await expect(activateNativeOmarchyDesktop(
      { computerId: COMPUTER_ID, udp: "relay", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false, code: "native_relay_unavailable",
      profileReleasePending: false, sessionReleasePending: false,
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.bridge.postMessage).not.toHaveBeenCalled();
  });

  it("retains the active lease and bound profile when launch acknowledgement is uncertain", async () => {
    const fixture = dependencies({ launchFails: true });
    await expect(activateNativeOmarchyDesktop(
      { computerId: COMPUTER_ID, udp: "direct", streamingMode: "performance" }, fixture.dependencies,
    )).resolves.toEqual({
      ok: false, code: "native_activation_uncertain",
      profileReleasePending: true, sessionReleasePending: true,
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.bridge.postMessage).toHaveBeenCalledTimes(2);
  });

  it("stops the exact local process and proves server controller release", async () => {
    const fixture = dependencies();
    await expect(stopNativeOmarchyDesktop({
      computerId: COMPUTER_ID,
      sessionId: SESSION_ID,
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    }, fixture.dependencies)).resolves.toEqual({
      ok: true,
      sessionId: SESSION_ID,
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      localProcessStopped: true,
      controllerReleased: true,
      desktopReady: false,
    });
    expect(fixture.bridge.postMessage).toHaveBeenCalledWith({
      type: "hivra.native-desktop.stop.v1", sessionId: SESSION_ID, processIdentifier: 4242,
    });
    expect(fixture.fetch).toHaveBeenCalledWith(
      "/api/remote-desktop/native/omarchy/stop",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("renews the exact activation without relaunching Moonlight", async () => {
    const fixture = dependencies();
    const renewalId = "018f6d3c-1d91-7c65-9d86-37fc915b8384";
    await expect(renewNativeOmarchyDesktop({
      computerId: COMPUTER_ID, sessionId: SESSION_ID,
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381", renewalId,
    }, fixture.dependencies)).resolves.toMatchObject({
      ok: true, sessionId: SESSION_ID, renewalId, renewalCount: 1, desktopReady: true,
    });
    expect(fixture.fetch).toHaveBeenCalledWith("/api/remote-desktop/native/omarchy/renew",
      expect.objectContaining({ method: "POST" }));
    expect(fixture.bridge.postMessage).not.toHaveBeenCalled();
  });

  it("still releases the guest controller when the local stop acknowledgement is lost", async () => {
    const fixture = dependencies({ localStopFails: true });
    await expect(stopNativeOmarchyDesktop({
      computerId: COMPUTER_ID,
      sessionId: SESSION_ID,
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    }, fixture.dependencies)).resolves.toMatchObject({
      ok: true, localProcessStopped: false, controllerReleased: true,
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
});
