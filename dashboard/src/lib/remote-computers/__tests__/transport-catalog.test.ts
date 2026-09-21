import {
  REMOTE_DESKTOP_TRANSPORTS,
  assessRemoteDesktopAccessGrant,
  selectRemoteDesktopTransport,
} from "../transport-catalog";

describe("remote desktop transport catalog", () => {
  it("pins the native, Linux browser, and Windows browser implementations independently", () => {
    expect(REMOTE_DESKTOP_TRANSPORTS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "sunshine-moonlight",
        upstream: expect.objectContaining({
          release: "v2026.516.143833",
          commit: "14ffa6fdaa53f7b51512be2b3d24f3939695403c",
        }),
      }),
      expect.objectContaining({
        id: "selkies-webrtc",
        supportedCompositors: ["x11"],
        upstream: expect.objectContaining({
          release: "v1.6.2",
          commit: "7a80d7eea94f7ff5e754407a18364f4008d8b0fd",
        }),
      }),
      expect.objectContaining({
        id: "selkies-websocket",
        supportedCompositors: ["x11", "wayland"],
        upstream: expect.objectContaining({
          release: "main-2026-08-17",
          commit: "a1c5d9a8b2b0da0f354228cd0d451034e94b50db",
        }),
      }),
      expect.objectContaining({
        id: "guacamole-rdp",
        clientKinds: ["browser"],
        supportedCompositors: ["windows"],
        upstream: expect.objectContaining({
          release: "1.6.0",
          commit: "1f664e08feae6e7d15d8146b78acab2e6fb470ae",
          license: "Apache-2.0",
        }),
      }),
    ]));
  });

  it("selects verified Sunshine for an Omarchy Wayland desktop with a reachable native client", () => {
    const result = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: {
        compositor: "wayland",
        installedTransports: ["sunshine-moonlight", "recovery-console"],
        verifiedTransports: ["sunshine-moonlight", "recovery-console"],
        privateNetworkReachable: true,
      },
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "direct" },
    });

    expect(result.selected?.id).toBe("sunshine-moonlight");
  });

  it("selects only the capability-verified Selkies WebSocket lane for Omarchy Wayland", () => {
    const result = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: {
        compositor: "wayland",
        installedTransports: ["selkies-webrtc", "selkies-websocket", "recovery-console"],
        verifiedTransports: ["selkies-webrtc", "selkies-websocket", "recovery-console"],
        privateNetworkReachable: false,
      },
      client: { kind: "browser", moonlight: false, webCodecs: true, udp: "direct" },
    });

    expect(result.selected?.id).toBe("selkies-websocket");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ transportId: "selkies-webrtc", code: "COMPOSITOR_UNSUPPORTED" }),
    ]));
  });

  it("uses WebRTC on a proven X11 browser guest and WebSocket only when UDP is blocked", () => {
    const request = {
      purpose: "daily-driver" as const,
      host: {
        compositor: "x11" as const,
        installedTransports: ["selkies-webrtc", "selkies-websocket"] as const,
        verifiedTransports: ["selkies-webrtc", "selkies-websocket"] as const,
        privateNetworkReachable: false,
      },
      client: { kind: "browser" as const, moonlight: false, webCodecs: true, udp: "direct" as const },
    };

    expect(selectRemoteDesktopTransport(request).selected?.id).toBe("selkies-webrtc");
    expect(selectRemoteDesktopTransport({
      ...request,
      client: { ...request.client, udp: "blocked" },
    }).selected?.id).toBe("selkies-websocket");
  });

  it("selects Guacamole/RDP for a Windows browser only after host verification", () => {
    const unverified = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: {
        compositor: "windows",
        installedTransports: ["guacamole-rdp", "recovery-console"],
        verifiedTransports: ["recovery-console"],
        privateNetworkReachable: false,
      },
      client: { kind: "browser", moonlight: false, webCodecs: false, udp: "blocked" },
    });

    expect(unverified.selected).toBeNull();
    expect(unverified.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ transportId: "guacamole-rdp", code: "NOT_VERIFIED" }),
      expect.objectContaining({ transportId: "recovery-console", code: "RECOVERY_ONLY" }),
    ]));

    const verified = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: {
        compositor: "windows",
        installedTransports: ["guacamole-rdp", "recovery-console"],
        verifiedTransports: ["guacamole-rdp", "recovery-console"],
        privateNetworkReachable: false,
      },
      client: { kind: "browser", moonlight: false, webCodecs: false, udp: "blocked" },
    });

    expect(verified.selected?.id).toBe("guacamole-rdp");
  });

  it("keeps recovery and daily-driver purposes in separate lanes", () => {
    const host = {
      compositor: "x11" as const,
      installedTransports: ["selkies-websocket", "recovery-console"] as const,
      verifiedTransports: ["selkies-websocket", "recovery-console"] as const,
      privateNetworkReachable: false,
    };
    const client = { kind: "browser" as const, moonlight: false, webCodecs: true, udp: "blocked" as const };

    expect(selectRemoteDesktopTransport({ purpose: "daily-driver", host, client }).selected?.id)
      .toBe("selkies-websocket");
    expect(selectRemoteDesktopTransport({ purpose: "recovery", host, client }).selected?.id)
      .toBe("recovery-console");

    const dailyWithoutDailyDriver = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: { ...host, installedTransports: ["recovery-console"], verifiedTransports: ["recovery-console"] },
      client,
    });
    expect(dailyWithoutDailyDriver.selected).toBeNull();
    expect(dailyWithoutDailyDriver.rejected).toContainEqual(expect.objectContaining({
      transportId: "recovery-console",
      code: "RECOVERY_ONLY",
    }));
  });

  it("fails closed when an installed binary is not reachable from the actual client", () => {
    const result = selectRemoteDesktopTransport({
      purpose: "daily-driver",
      host: {
        compositor: "wayland",
        installedTransports: ["sunshine-moonlight"],
        verifiedTransports: ["sunshine-moonlight"],
        privateNetworkReachable: false,
      },
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "blocked" },
    });

    expect(result.selected).toBeNull();
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ transportId: "sunshine-moonlight", code: "UDP_UNAVAILABLE" }),
      expect.objectContaining({ transportId: "sunshine-moonlight", code: "PRIVATE_NETWORK_UNAVAILABLE" }),
    ]));
  });

  it("accepts only short-lived, non-URL, single-controller grants", () => {
    const now = Date.now();
    const accepted = assessRemoteDesktopAccessGrant({
      computerKind: "hivra-agent",
      computerId: "computer-1",
      userId: "user-1",
      audience: "hivra-computer:hivra-agent:computer-1:desktop",
      surface: "desktop",
      inputRole: "controller",
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
      handoff: "message",
      activeControllerCount: 0,
      relayCredentialExpiresAtMs: now + 30_000,
    });

    expect(accepted).toEqual({ accepted: true, issues: [] });

    const rejected = assessRemoteDesktopAccessGrant({
      computerKind: "hivra-agent",
      computerId: "computer-1",
      userId: "user-1",
      audience: "hivra-computer:other:desktop",
      surface: "desktop",
      inputRole: "controller",
      issuedAtMs: now,
      expiresAtMs: now + 10 * 60_000,
      handoff: "url",
      activeControllerCount: 1,
      relayCredentialExpiresAtMs: now + 11 * 60_000,
    });

    expect(rejected.accepted).toBe(false);
    expect(rejected.issues.map((issue) => issue.code)).toEqual([
      "AUDIENCE_MISMATCH",
      "INVALID_TTL",
      "URL_SECRET_FORBIDDEN",
      "CONTROLLER_CONFLICT",
      "RELAY_CREDENTIAL_OUTLIVES_GRANT",
    ]);
  });
});
