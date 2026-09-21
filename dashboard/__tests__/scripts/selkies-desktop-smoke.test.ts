import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SELKIES_DESKTOP_FIXTURE,
  assertDockerObjectAbsent,
  buildContainedCdpProxy,
  buildSelkiesDockerRunArgs,
  cleanupSelkiesDockerObjects,
  hasQualifiedSelkiesWebRtcPeer,
  parseSelkiesTransport,
  publicSelkiesDockerPlan,
  redactSelkiesLogs,
  redactSelkiesSecrets,
  selkiesModeForTransport,
  selkiesPointerLeftButtonState,
} from "../../scripts/selkies-desktop-smoke";

describe("Selkies desktop smoke fixture", () => {
  const input = {
    containerName: "hivra-selkies-smoke-fixture",
    envFilePath: "/tmp/fixture/session.env",
    networkName: "hivra-selkies-net-fixture",
  };

  it("pins a multi-architecture image digest and observed source revision", () => {
    expect(SELKIES_DESKTOP_FIXTURE).toMatchObject({
      sourceCommit: "dbc97872dbeae49e7f1e4491c3dee54f437f364d",
      imageIndexDigest: "sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa",
      arm64ManifestDigest: "sha256:4ceac6a5079a501d68ea429c5cee9e8c734333e04e291bb3bce8f69182930e9b",
      amd64ManifestDigest: "sha256:4219c5becdd5650dc3775863cd31b148cd4de077f72ac3de308dea98ed75f203",
      imageUser: "1000",
      imageEntrypoint: ["/etc/container-entrypoint.sh"],
      imageCommand: null,
      imageWorkingDirectory: "/home/ubuntu",
      desktopUser: "ubuntu",
      desktopUid: 1000,
      desktopGid: 1000,
      supportedTransports: ["websocket", "webrtc"],
      compositor: "x11",
      license: "MPL-2.0",
    });
  });

  it("selects one explicit transport and uses the upstream canonical mode names", () => {
    expect(parseSelkiesTransport([])).toBe("websocket");
    expect(parseSelkiesTransport(["--transport", "webrtc"])).toBe("webrtc");
    expect(parseSelkiesTransport(["--transport=websocket"])).toBe("websocket");
    expect(parseSelkiesTransport(["--transportation=rail"])).toBe("websocket");
    expect(() => parseSelkiesTransport(["--transport", "rdp"])).toThrow(
      "--transport must be exactly one of: websocket, webrtc",
    );
    expect(() => parseSelkiesTransport(["--transport"])).toThrow(
      "--transport must be exactly one of: websocket, webrtc",
    );
    expect(() => parseSelkiesTransport(["--transport=webrtc", "--transport=webrtc"])).toThrow(
      "--transport must be exactly one of: websocket, webrtc",
    );
    expect(selkiesModeForTransport("websocket")).toBe("websockets");
    expect(selkiesModeForTransport("webrtc")).toBe("webrtc");
  });

  it("publishes only on loopback and passes secrets through an ephemeral env file", () => {
    const args = buildSelkiesDockerRunArgs(input);

    expect(args).toEqual(expect.arrayContaining([
      "--publish", "127.0.0.1::8080",
      "--env-file", input.envFilePath,
      "--network", input.networkName,
      `ghcr.io/selkies-project/selkies-egl-desktop:26.04@${SELKIES_DESKTOP_FIXTURE.imageIndexDigest}`,
    ]));
    expect(args.join(" ")).not.toContain("PASSWD=");
    expect(args).not.toContain("--network=host");
    expect(args).not.toContain("--privileged");
  });

  it("keeps plan output free of the concrete secret-file path", () => {
    expect(publicSelkiesDockerPlan(input)).toEqual(expect.objectContaining({
      image: `ghcr.io/selkies-project/selkies-egl-desktop:26.04@${SELKIES_DESKTOP_FIXTURE.imageIndexDigest}`,
      loopbackOnly: true,
      envFile: "ephemeral-0600-file",
      cleanup: "exact container/network removal plus authoritative absence inventory",
      transport: "websocket",
    }));
    expect(JSON.stringify(publicSelkiesDockerPlan(input))).not.toContain(input.envFilePath);
  });

  it("changes the declared transport without widening the Docker boundary", () => {
    const webrtcInput = { ...input, transport: "webrtc" as const };
    const args = buildSelkiesDockerRunArgs(webrtcInput);

    expect(publicSelkiesDockerPlan(webrtcInput)).toEqual(expect.objectContaining({
      transport: "webrtc",
      loopbackOnly: true,
      publishedContainerPort: 8080,
    }));
    expect(args).toContain("127.0.0.1::8080");
    expect(args).toEqual(expect.arrayContaining([
      "127.0.0.1::9223",
    ]));
    expect(args.join(" ")).not.toContain("3478:");
    expect(args.join(" ")).not.toContain("65532:");
    expect(args.join(" ")).not.toContain("65535:");
    expect(args.join(" ")).not.toContain("0.0.0.0:");
    expect(args).not.toContain("--network=host");
    expect(args).not.toContain("--privileged");
  });

  it("redacts addresses from failure logs", () => {
    expect(redactSelkiesLogs("peers 203.0.113.163, 2001:db8::1 and [fe80::1]"))
      .toBe("peers [IP_REDACTED], [IP_REDACTED] and [IP_REDACTED]");
  });

  it("redacts raw and encoded credentials and authenticates the loopback CDP proxy", () => {
    const token = "a".repeat(43);
    const basicCredentials = Buffer.from("hivra-smoke:example-password-value").toString("base64");
    const proxy = buildContainedCdpProxy(token, basicCredentials);

    expect(proxy).toContain(`TOKEN = "${token}"`);
    expect(proxy).toContain(`BASIC_AUTH = "Basic ${basicCredentials}"`);
    expect(proxy).toContain("x-hivra-cdp-token:");
    expect(proxy).toContain("401 Unauthorized");
    expect(proxy).toContain('line.lower().startswith("authorization:")');
    expect(proxy).toContain('"Connection: Upgrade" if websocket_upgrade else "Connection: close"');
    expect(proxy).toContain('"127.0.0.1"');
    expect(proxy).toContain("8081");
    expect(redactSelkiesSecrets(
      "password=fixture basic=Zml4dHVyZQ==",
      ["fixture", "Zml4dHVyZQ=="],
    )).toBe("password=[REDACTED] basic=[REDACTED]");
  });

  it("distinguishes pointer down/up payloads from background control traffic", () => {
    expect(selkiesPointerLeftButtonState("_gz,1")).toBeNull();
    expect(selkiesPointerLeftButtonState("m,120,80,1,0")).toBe(true);
    expect(selkiesPointerLeftButtonState("m,120,80,0,0")).toBe(false);
    expect(selkiesPointerLeftButtonState("m2,0,0,1,0")).toBe(true);
  });

  it("requires one connected WebRTC peer to own the media and selected route", () => {
    const selectedHostUdpPair = [{
      localCandidateType: "host",
      localProtocol: "udp",
      remoteCandidateType: "host",
      remoteProtocol: "udp",
    }];
    expect(hasQualifiedSelkiesWebRtcPeer([
      {
        connectionState: "closed",
        inboundVideoPackets: 129,
        framesDecoded: 41,
        dataChannelMessagesSent: 9,
        selectedCandidatePairs: selectedHostUdpPair,
      },
      {
        connectionState: "connected",
        inboundVideoPackets: 0,
        framesDecoded: 0,
        dataChannelMessagesSent: 0,
        selectedCandidatePairs: [],
      },
    ])).toBe(false);
    expect(hasQualifiedSelkiesWebRtcPeer([{
      connectionState: "connected",
      inboundVideoPackets: 1,
      framesDecoded: 1,
      dataChannelMessagesSent: 0,
      selectedCandidatePairs: selectedHostUdpPair,
    }])).toBe(true);
  });

  it("cleans exact dispatched names after acknowledgement loss and proves absence", () => {
    const calls: string[][] = [];
    const runner = (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "inspect") return { status: 1, stderr: "Error: No such object" };
      if (args[0] === "network" && args[1] === "inspect") {
        return { status: 1, stderr: "Error: network fixture not found" };
      }
      return { status: 1, stderr: "simulated lost acknowledgement" };
    };

    expect(() => cleanupSelkiesDockerObjects({
      containerName: input.containerName,
      networkName: input.networkName,
      cleanupContainer: true,
      cleanupNetwork: true,
    }, runner)).not.toThrow();
    expect(calls).toContainEqual(["rm", "--force", input.containerName]);
    expect(calls).toContainEqual(["inspect", input.containerName]);
    expect(calls).toContainEqual(["network", "rm", input.networkName]);
    expect(calls).toContainEqual(["network", "inspect", input.networkName]);
  });

  it("refuses false cleanup success when removal or inventory cannot prove absence", () => {
    expect(() => cleanupSelkiesDockerObjects({
      containerName: input.containerName,
      networkName: input.networkName,
      cleanupContainer: true,
      cleanupNetwork: false,
    }, (args) => args[0] === "inspect"
      ? { status: 0, stdout: "still present" }
      : { status: 1, stderr: "removal failed" })).toThrow("still exists");

    expect(() => cleanupSelkiesDockerObjects({
      containerName: input.containerName,
      networkName: input.networkName,
      cleanupContainer: true,
      cleanupNetwork: false,
    }, (args) => args[0] === "inspect"
      ? { status: null, error: new Error("daemon timeout") }
      : { status: 0 })).toThrow("absence is unproven");
  });

  it("requires authoritative preflight absence instead of trusting failed inventory", () => {
    expect(() => assertDockerObjectAbsent(
      "container",
      input.containerName,
      () => ({ status: 0, stdout: "existing" }),
    )).toThrow("Refusing to replace existing Docker container");
    expect(() => assertDockerObjectAbsent(
      "container",
      input.containerName,
      () => ({ status: null, error: new Error("daemon timeout") }),
    )).toThrow("Could not prove Docker container");
  });

  it("contains a real browser stream acceptance instead of stopping at an HTTP health response", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../scripts/selkies-desktop-smoke.ts"),
      "utf8",
    );

    expect(source).toContain('page.on("websocket"');
    expect(source).toContain('document.querySelectorAll("canvas, video")');
    expect(source).toContain("websocketFramesReceived === 0");
    expect(source).toContain('page.locator("canvas:visible, video:visible")');
    expect(source).toContain("The stream has frames but no visible input surface");
    expect(source).toContain("#overlayInput");
    expect(source).toContain("page.mouse.click");
    expect(source).toContain("no WebSocket pointer down/up pair followed the click");
    expect(source).toContain("RTCPeerConnection");
    expect(source).toContain("framesDecoded");
    expect(source).toContain("inboundVideoPackets");
    expect(source).toContain("RTCDataChannel.prototype.send");
    expect(source).toContain("pointer input sent no WebRTC data-channel message");
    expect(source).toContain('peer.connectionState === "connected"');
    expect(source).toContain('localCandidateType === "host"');
    expect(source).toContain('localProtocol === "udp"');
    expect(source).toContain("expectedOrigin");
    expect(source).toContain("origin: expectedOrigin");
    expect(source).not.toContain('authSession.send("Fetch.enable"');
    expect(source).not.toContain("comparableOrigin === expectedOrigin");
    expect(source).not.toContain("setExtraHTTPHeaders");
    expect(source).toContain('transport === "webrtc" ? "http://127.0.0.1:8081/"');
    expect(source).not.toContain("candidate.address");
    expect(source).toContain("page.screenshot");
  });
});
