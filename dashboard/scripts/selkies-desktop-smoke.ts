// Disposable local Selkies desktop acceptance fixture.
//
// This is deliberately not an Omarchy installer. It proves the upstream
// Selkies-owned desktop container on an isolated loopback port, with an
// immutable multi-architecture image digest and unconditional cleanup.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

export type SelkiesTransport = "websocket" | "webrtc";

export const SELKIES_DESKTOP_FIXTURE = {
  repository: "https://github.com/selkies-project/selkies",
  sourceCommit: "dbc97872dbeae49e7f1e4491c3dee54f437f364d",
  imageTag: "ghcr.io/selkies-project/selkies-egl-desktop:26.04",
  imageIndexDigest: "sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa",
  arm64ManifestDigest: "sha256:4ceac6a5079a501d68ea429c5cee9e8c734333e04e291bb3bce8f69182930e9b",
  amd64ManifestDigest: "sha256:4219c5becdd5650dc3775863cd31b148cd4de077f72ac3de308dea98ed75f203",
  imageCreatedAt: "2026-08-31T23:16:06.109426199Z",
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
} as const;

const PINNED_IMAGE = `${SELKIES_DESKTOP_FIXTURE.imageTag.split(":main-")[0]}@${SELKIES_DESKTOP_FIXTURE.imageIndexDigest}`;
const TURN_PORT = 3478;
const TURN_MIN_PORT = 65532;
const TURN_MAX_PORT = 65535;
export function buildContainedCdpProxy(token: string, basicCredentials: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error("Contained CDP token must be a base64url value between 32 and 128 characters.");
  }
  if (!/^[A-Za-z0-9+/=]{32,256}$/.test(basicCredentials)) {
    throw new Error("Contained Selkies credentials must be a base64 value between 32 and 256 characters.");
  }
  return `import asyncio

TOKEN = "${token}"
BASIC_AUTH = "Basic ${basicCredentials}"

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    finally:
        try:
            writer.write_eof()
        except (AttributeError, OSError):
            pass

async def handle(client_reader, client_writer, upstream_port, required_token=None, authorization=None):
    try:
        header_block = await asyncio.wait_for(client_reader.readuntil(b"\\r\\n\\r\\n"), timeout=5)
        header_lines = header_block.decode("latin1").split("\\r\\n")
        supplied_token = next(
            (line.split(":", 1)[1].strip() for line in header_lines
             if line.lower().startswith("x-hivra-cdp-token:")),
            None,
        )
        if required_token is not None and supplied_token != required_token:
            client_writer.write(b"HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
            await client_writer.drain()
            return
        websocket_upgrade = any(
            line.lower().startswith("upgrade:") and "websocket" in line.lower()
            for line in header_lines[1:]
        )
        forwarded_headers = [header_lines[0]]
        forwarded_headers.extend(
            line for line in header_lines[1:]
            if line
            and not line.lower().startswith("x-hivra-cdp-token:")
            and not line.lower().startswith("authorization:")
            and not line.lower().startswith("connection:")
        )
        if authorization is not None:
            forwarded_headers.append(f"Authorization: {authorization}")
        forwarded_headers.append("Connection: Upgrade" if websocket_upgrade else "Connection: close")
        forwarded_block = ("\\r\\n".join(forwarded_headers) + "\\r\\n\\r\\n").encode("latin1")
        server_reader, server_writer = await asyncio.open_connection("127.0.0.1", upstream_port)
        server_writer.write(forwarded_block)
        await server_writer.drain()
        await asyncio.gather(
            pipe(client_reader, server_writer),
            pipe(server_reader, client_writer),
        )
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        pass
    finally:
        client_writer.close()
        await client_writer.wait_closed()

async def main():
    cdp_server = await asyncio.start_server(
        lambda reader, writer: handle(reader, writer, 9222, required_token=TOKEN),
        "0.0.0.0",
        9223,
    )
    selkies_server = await asyncio.start_server(
        lambda reader, writer: handle(reader, writer, 8080, authorization=BASIC_AUTH),
        "127.0.0.1",
        8081,
    )
    async with cdp_server, selkies_server:
        await asyncio.gather(cdp_server.serve_forever(), selkies_server.serve_forever())

asyncio.run(main())
`;
}

export interface SelkiesDockerPlanInput {
  containerName: string;
  envFilePath: string;
  networkName: string;
  transport?: SelkiesTransport;
}

export function parseSelkiesTransport(args: readonly string[]): SelkiesTransport {
  const values: string[] = [];
  args.forEach((argument, index) => {
    if (argument === "--transport") {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) values.push(next);
    } else if (argument.startsWith("--transport=")) {
      values.push(argument.slice("--transport=".length));
    }
  });
  const hasTransportFlag = args.some(
    (argument) => argument === "--transport" || argument.startsWith("--transport="),
  );
  if (values.length === 0 && !hasTransportFlag) {
    return "websocket";
  }
  if (values.length !== 1 || !["websocket", "webrtc"].includes(values[0])) {
    throw new Error("--transport must be exactly one of: websocket, webrtc");
  }
  return values[0] as SelkiesTransport;
}

export function selkiesModeForTransport(transport: SelkiesTransport): "websockets" | "webrtc" {
  return transport === "websocket" ? "websockets" : "webrtc";
}

export function selkiesPointerLeftButtonState(payload: string): boolean | null {
  const fields = payload.split(",");
  if ((fields[0] !== "m" && fields[0] !== "m2") || fields.length !== 5) return null;
  const buttonMask = Number.parseInt(fields[3], 10);
  return Number.isInteger(buttonMask) ? (buttonMask & 1) === 1 : null;
}

export interface SelkiesCandidatePairEvidence {
  localCandidateType: string | null;
  localProtocol: string | null;
  remoteCandidateType: string | null;
  remoteProtocol: string | null;
}

export interface SelkiesPeerEvidence {
  connectionState: string;
  inboundVideoPackets: number;
  framesDecoded: number;
  dataChannelMessagesSent: number;
  selectedCandidatePairs: SelkiesCandidatePairEvidence[];
}

export function hasQualifiedSelkiesWebRtcPeer(peers: readonly SelkiesPeerEvidence[]): boolean {
  return peers.some((peer) => (
    peer.connectionState === "connected"
    && peer.inboundVideoPackets > 0
    && peer.framesDecoded > 0
    && peer.selectedCandidatePairs.some((pair) => (
      pair.localCandidateType === "host"
      && pair.remoteCandidateType === "host"
      && pair.localProtocol === "udp"
      && pair.remoteProtocol === "udp"
    ))
  ));
}

export function buildSelkiesDockerRunArgs(input: SelkiesDockerPlanInput): string[] {
  const args = [
    "run",
    "--name", input.containerName,
    "--detach",
    "--rm",
    "--pull=always",
    "--shm-size=2g",
    "--cpus=2",
    "--memory=4g",
    "--pids-limit=2048",
    "--network", input.networkName,
    "--publish", "127.0.0.1::8080",
    "--env-file", input.envFilePath,
  ];
  if (input.transport === "webrtc") {
    // The acceptance browser runs inside the fixture's private network, so no
    // UDP/TURN port is published on the host. CDP is loopback-only and test-only.
    args.push("--publish", "127.0.0.1::9223");
  }
  args.push(PINNED_IMAGE);
  return args;
}

export function publicSelkiesDockerPlan(input: SelkiesDockerPlanInput) {
  return {
    containerName: input.containerName,
    image: PINNED_IMAGE,
    loopbackOnly: true,
    containerNetwork: "ephemeral dedicated bridge",
    publishedContainerPort: 8080,
    loopbackBindings: input.transport === "webrtc"
      ? [
          "8080/tcp (ephemeral host port)",
          "9223/tcp (ephemeral CDP proxy port)",
        ]
      : ["8080/tcp (ephemeral host port)"],
    compositor: SELKIES_DESKTOP_FIXTURE.compositor,
    transport: input.transport ?? "websocket",
    resources: { cpu: 2, memoryGb: 4, sharedMemoryGb: 2, pids: 2048 },
    envFile: "ephemeral-0600-file",
    cleanup: "exact container/network removal plus authoritative absence inventory",
  };
}

export function redactSelkiesLogs(logs: string): string {
  return logs
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP_REDACTED]")
    .replace(/\[[0-9a-fA-F:]*:[0-9a-fA-F:]*\]/g, "[IP_REDACTED]")
    .replace(/(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g, "[IP_REDACTED]");
}

export function redactSelkiesSecrets(logs: string, secrets: readonly string[]): string {
  return redactSelkiesLogs(
    secrets.reduce(
      (redacted, secret) => secret ? redacted.replaceAll(secret, "[REDACTED]") : redacted,
      logs,
    ),
  );
}

export type DockerObjectKind = "container" | "network";

export interface DockerCommandReceipt {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export type DockerReceiptRunner = (args: readonly string[]) => DockerCommandReceipt;

function runDockerReceipt(args: readonly string[]): DockerCommandReceipt {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 2 * 60_000,
  });
}

function dockerReceiptDetail(receipt: DockerCommandReceipt): string {
  return [receipt.stdout, receipt.stderr, receipt.error?.message]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function receiptProvesAbsence(kind: DockerObjectKind, receipt: DockerCommandReceipt): boolean {
  if (receipt.status !== 1) return false;
  const detail = dockerReceiptDetail(receipt);
  return kind === "container"
    ? /No such (?:object|container)/i.test(detail)
    : /No such network|network .* not found/i.test(detail);
}

function inspectDockerObject(
  kind: DockerObjectKind,
  name: string,
  runner: DockerReceiptRunner,
): DockerCommandReceipt {
  return runner(kind === "container" ? ["inspect", name] : ["network", "inspect", name]);
}

export function assertDockerObjectAbsent(
  kind: DockerObjectKind,
  name: string,
  runner: DockerReceiptRunner = runDockerReceipt,
): void {
  const receipt = inspectDockerObject(kind, name, runner);
  if (receiptProvesAbsence(kind, receipt)) return;
  if (receipt.status === 0) throw new Error(`Refusing to replace existing Docker ${kind} ${name}.`);
  throw new Error(
    `Could not prove Docker ${kind} ${name} is absent: ${dockerReceiptDetail(receipt) || "no receipt"}`,
  );
}

export function cleanupSelkiesDockerObjects(
  input: {
    containerName: string;
    networkName: string;
    cleanupContainer: boolean;
    cleanupNetwork: boolean;
  },
  runner: DockerReceiptRunner = runDockerReceipt,
): void {
  const failures: string[] = [];

  if (input.cleanupContainer) {
    runner(["rm", "--force", input.containerName]);
    const receipt = inspectDockerObject("container", input.containerName, runner);
    if (receipt.status === 0) {
      failures.push(`container ${input.containerName} still exists`);
    } else if (!receiptProvesAbsence("container", receipt)) {
      failures.push(`container absence is unproven: ${dockerReceiptDetail(receipt) || "no receipt"}`);
    }
  }

  if (input.cleanupNetwork) {
    runner(["network", "rm", input.networkName]);
    const receipt = inspectDockerObject("network", input.networkName, runner);
    if (receipt.status === 0) {
      failures.push(`network ${input.networkName} still exists`);
    } else if (!receiptProvesAbsence("network", receipt)) {
      failures.push(`network absence is unproven: ${dockerReceiptDetail(receipt) || "no receipt"}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Selkies Docker cleanup failed: ${failures.join("; ")}`);
  }
}

function docker(args: readonly string[], options: { tolerateFailure?: boolean } = {}): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 15 * 60_000 });
  if (result.status !== 0 && !options.tolerateFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`docker ${args[0] ?? "command"} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function resolvePublishedPort(containerName: string, containerPort = 8080): number {
  const raw = docker(["port", containerName, `${containerPort}/tcp`]);
  const match = raw.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`Selkies did not publish a loopback port: ${raw}`);
  return Number.parseInt(match[1], 10);
}

async function waitForCdp(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`, {
        headers: { "x-hivra-cdp-token": token },
      });
      const body = await response.json() as { webSocketDebuggerUrl?: string };
      if (response.status === 200 && body.webSocketDebuggerUrl) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    sleep(500);
  }
  throw new Error(`Contained Chromium CDP timed out: ${lastError}`);
}

async function startContainedChromium(
  containerName: string,
  proxyFilePath: string,
  cdpToken: string,
): Promise<string> {
  const browserBinary = docker([
    "exec", containerName, "/bin/bash", "-lc",
    "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser",
  ]).trim();
  if (![
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].includes(browserBinary)) {
    throw new Error(`No supported contained Chromium binary was found: ${browserBinary || "empty result"}`);
  }
  const browserCommand = [
    `exec ${browserBinary}`,
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--disable-background-networking",
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/hivra-webrtc-browser",
    "--window-size=1440,900",
    "about:blank",
    ">/tmp/hivra-contained-chromium.log 2>&1",
  ].join(" ");
  docker([
    "exec", "--detach", "--user", "ubuntu", containerName,
    "/bin/bash", "-lc", browserCommand,
  ]);
  docker(["cp", proxyFilePath, `${containerName}:/tmp/hivra-cdp-proxy.py`]);
  docker([
    "exec", "--detach", "--user", "0", containerName,
    "/bin/bash", "-lc",
    "exec /usr/bin/python3 /tmp/hivra-cdp-proxy.py >/tmp/hivra-cdp-proxy.log 2>&1",
  ]);
  const port = resolvePublishedPort(containerName, 9223);
  const cdpUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForCdp(cdpUrl, cdpToken);
  } catch (error) {
    const browserLogs = redactSelkiesLogs(
      docker(
        ["exec", containerName, "/bin/bash", "-lc", "tail -80 /tmp/hivra-contained-chromium.log 2>/dev/null"],
        { tolerateFailure: true },
      ),
    );
    const proxyLogs = redactSelkiesLogs(
      docker(
        ["exec", containerName, "/bin/bash", "-lc", "tail -80 /tmp/hivra-cdp-proxy.log 2>/dev/null"],
        { tolerateFailure: true },
      ),
    );
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}; contained Chromium log: ${browserLogs || "empty"}; CDP proxy log: ${proxyLogs || "empty"}`,
    );
  }
  return cdpUrl;
}

function sleep(ms: number): void {
  execFileSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore" });
}

async function waitForHttp(url: string, authorization: string): Promise<{ unauthenticated: number; authenticated: number; body: string }> {
  const deadline = Date.now() + 3 * 60_000;
  let lastError = "no response";

  while (Date.now() < deadline) {
    try {
      const unauthenticated = await fetch(url, { redirect: "manual" });
      const authenticated = await fetch(url, {
        headers: { authorization: authorization },
        redirect: "manual",
      });
      const body = await authenticated.text();
      if (unauthenticated.status === 401 && authenticated.status === 200 && /selkies/i.test(body)) {
        return { unauthenticated: unauthenticated.status, authenticated: authenticated.status, body };
      }
      lastError = `unauth=${unauthenticated.status} auth=${authenticated.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    sleep(1_000);
  }

  throw new Error(`Selkies HTTP acceptance timed out: ${lastError}`);
}

async function runBrowserAcceptance(
  url: string,
  username: string,
  password: string,
  screenshotPath: string,
  transport: SelkiesTransport,
  cdpUrl?: string,
  cdpToken?: string,
): Promise<{
  title: string;
  visualSurfaceCount: number;
  websocketCount: number;
  websocketFramesReceived: number;
  websocketFramesSent: number;
  rtcPeerCount: number;
  rtcConnectionStates: string[];
  rtcInboundVideoPackets: number;
  rtcFramesDecoded: number;
  rtcDataChannelMessagesSent: number;
  rtcInstrumentedDataSends: number;
  pointerMessageCount: number;
  clickDownObserved: boolean;
  clickUpAfterDownObserved: boolean;
  selectedCandidatePairs: Array<{
    localCandidateType: string | null;
    localProtocol: string | null;
    remoteCandidateType: string | null;
    remoteProtocol: string | null;
  }>;
  inputPath: "websocket" | "webrtc-data-channel";
  screenshotPath: string;
  screenshotSha256: string;
  screenshotBytes: number;
}> {
  const { chromium } = await import("@playwright/test");
  const browser = cdpUrl
    ? await chromium.connectOverCDP(cdpUrl, {
        headers: { "x-hivra-cdp-token": cdpToken ?? "" },
      })
    : await chromium.launch({ headless: true });
  let websocketCount = 0;
  let websocketFramesReceived = 0;
  let websocketFramesSent = 0;
  const websocketPointerLeftButtonStates: boolean[] = [];

  async function collectWebRtcEvidence(page: Page) {
    return page.evaluate(async () => {
      type InstrumentedWindow = typeof globalThis & {
        __hivraRtcPeers?: RTCPeerConnection[];
        __hivraRtcDataSends?: number;
        __hivraRtcPointerLeftButtonStates?: boolean[];
      };
      const instrumented = globalThis as InstrumentedWindow;
      const peers = instrumented.__hivraRtcPeers ?? [];
      let inboundVideoPackets = 0;
      let framesDecoded = 0;
      let dataChannelMessagesSent = 0;
      const selectedCandidatePairs: Array<{
        localCandidateType: string | null;
        localProtocol: string | null;
        remoteCandidateType: string | null;
        remoteProtocol: string | null;
      }> = [];
      const peerEvidence: Array<{
        connectionState: string;
        inboundVideoPackets: number;
        framesDecoded: number;
        dataChannelMessagesSent: number;
        selectedCandidatePairs: Array<{
          localCandidateType: string | null;
          localProtocol: string | null;
          remoteCandidateType: string | null;
          remoteProtocol: string | null;
        }>;
      }> = [];

      for (const peer of peers) {
        const stats = await peer.getStats();
        let peerInboundVideoPackets = 0;
        let peerFramesDecoded = 0;
        let peerDataChannelMessagesSent = 0;
        const peerSelectedCandidatePairs: typeof selectedCandidatePairs = [];
        stats.forEach((report) => {
          const stat = report as RTCStats & Record<string, unknown>;
          if (
            stat.type === "inbound-rtp"
            && (stat.kind === "video" || stat.mediaType === "video")
          ) {
            peerInboundVideoPackets += Number(stat.packetsReceived ?? 0);
            peerFramesDecoded += Number(stat.framesDecoded ?? 0);
          }
          if (stat.type === "data-channel") {
            peerDataChannelMessagesSent += Number(stat.messagesSent ?? 0);
          }
          if (
            stat.type === "candidate-pair"
            && stat.state === "succeeded"
            && (stat.selected === true || stat.nominated === true)
          ) {
            const local = stats.get(String(stat.localCandidateId ?? "")) as
              | (RTCStats & Record<string, unknown>)
              | undefined;
            const remote = stats.get(String(stat.remoteCandidateId ?? "")) as
              | (RTCStats & Record<string, unknown>)
              | undefined;
            peerSelectedCandidatePairs.push({
              localCandidateType: typeof local?.candidateType === "string" ? local.candidateType : null,
              localProtocol: typeof local?.protocol === "string" ? local.protocol : null,
              remoteCandidateType: typeof remote?.candidateType === "string" ? remote.candidateType : null,
              remoteProtocol: typeof remote?.protocol === "string" ? remote.protocol : null,
            });
          }
        });
        inboundVideoPackets += peerInboundVideoPackets;
        framesDecoded += peerFramesDecoded;
        dataChannelMessagesSent += peerDataChannelMessagesSent;
        selectedCandidatePairs.push(...peerSelectedCandidatePairs);
        peerEvidence.push({
          connectionState: peer.connectionState,
          inboundVideoPackets: peerInboundVideoPackets,
          framesDecoded: peerFramesDecoded,
          dataChannelMessagesSent: peerDataChannelMessagesSent,
          selectedCandidatePairs: peerSelectedCandidatePairs,
        });
      }

      return {
        peerCount: peers.length,
        connectionStates: peerEvidence.map((peer) => peer.connectionState),
        inboundVideoPackets,
        framesDecoded,
        dataChannelMessagesSent,
        instrumentedDataSends: instrumented.__hivraRtcDataSends ?? 0,
        pointerLeftButtonStates: instrumented.__hivraRtcPointerLeftButtonStates ?? [],
        selectedCandidatePairs,
        peerEvidence,
      };
    });
  }

  try {
    const expectedOrigin = new URL(url).origin;
    const context = cdpUrl
      ? browser.contexts()[0]
      : await browser.newContext({
          viewport: { width: 1440, height: 900 },
          httpCredentials: {
            username,
            password,
            origin: expectedOrigin,
            send: "always",
          },
        });
    if (!context) throw new Error("Contained Chromium exposed no browser context.");
    if (transport === "webrtc") {
      await context.addInitScript(() => {
        type InstrumentedWindow = typeof globalThis & {
          __hivraRtcPeers?: RTCPeerConnection[];
          __hivraRtcDataSends?: number;
          __hivraRtcPointerLeftButtonStates?: boolean[];
        };
        const instrumented = globalThis as InstrumentedWindow;
        instrumented.__hivraRtcPeers = [];
        instrumented.__hivraRtcDataSends = 0;
        instrumented.__hivraRtcPointerLeftButtonStates = [];

        const NativePeerConnection = globalThis.RTCPeerConnection;
        class InstrumentedPeerConnection extends NativePeerConnection {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            instrumented.__hivraRtcPeers?.push(this);
          }
        }
        globalThis.RTCPeerConnection = InstrumentedPeerConnection;

        const nativeSend = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function instrumentedSend(data: string | Blob | ArrayBuffer | ArrayBufferView) {
          instrumented.__hivraRtcDataSends = (instrumented.__hivraRtcDataSends ?? 0) + 1;
          if (typeof data === "string") {
            const fields = data.split(",");
            if ((fields[0] === "m" || fields[0] === "m2") && fields.length === 5) {
              const buttonMask = Number.parseInt(fields[3], 10);
              if (Number.isInteger(buttonMask)) {
                instrumented.__hivraRtcPointerLeftButtonStates?.push((buttonMask & 1) === 1);
              }
            }
          }
          return nativeSend.call(this, data as never);
        };
      });
    }
    const page = cdpUrl ? (context.pages()[0] ?? await context.newPage()) : await context.newPage();
    page.on("websocket", (socket) => {
      websocketCount += 1;
      socket.on("framereceived", () => { websocketFramesReceived += 1; });
      socket.on("framesent", (event) => {
        websocketFramesSent += 1;
        const payload = typeof event.payload === "string"
          ? event.payload
          : event.payload.toString("utf8");
        const pointerState = selkiesPointerLeftButtonState(payload);
        if (pointerState !== null) websocketPointerLeftButtonStates.push(pointerState);
      });
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (response?.status() !== 200) {
      throw new Error(`Browser received HTTP ${response?.status() ?? "no response"}.`);
    }
    await page.waitForFunction(
      () => document.querySelectorAll("canvas, video").length > 0,
      undefined,
      { timeout: 60_000 },
    );
    let rtcEvidence = await collectWebRtcEvidence(page);
    const frameDeadline = Date.now() + 60_000;
    while (Date.now() < frameDeadline) {
      const hasMedia = transport === "websocket"
        ? websocketFramesReceived > 0
        : hasQualifiedSelkiesWebRtcPeer(rtcEvidence.peerEvidence);
      if (hasMedia) break;
      await page.waitForTimeout(500);
      rtcEvidence = await collectWebRtcEvidence(page);
    }
    if (transport === "websocket" && (websocketCount === 0 || websocketFramesReceived === 0)) {
      throw new Error("The browser client rendered but no live WebSocket frames were observed.");
    }
    if (
      transport === "webrtc"
      && !hasQualifiedSelkiesWebRtcPeer(rtcEvidence.peerEvidence)
    ) {
      throw new Error(`The browser client rendered but no decoded WebRTC video was observed: ${JSON.stringify(rtcEvidence)}`);
    }

    // Exercise the input path without changing guest state: pointer motion and
    // a click on the rendered desktop surface should send client frames.
    const visualSurface = page.locator("canvas:visible, video:visible").first();
    if (await visualSurface.count() === 0) {
      const surfaceState = await page.locator("canvas, video").evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
        };
      }));
      await page.screenshot({ path: screenshotPath, fullPage: true });
      throw new Error(`The stream has frames but no visible input surface: ${JSON.stringify(surfaceState)}`);
    }
    const box = await visualSurface.boundingBox();
    if (!box) throw new Error("The visible stream surface has no input bounds.");
    const websocketPointerCountBeforeInput = websocketPointerLeftButtonStates.length;
    const rtcBeforeInput = rtcEvidence;
    let clickDownObserved = false;
    let clickUpAfterDownObserved = false;
    // Selkies intentionally places #overlayInput over the decoded surface so
    // keyboard/pointer events reach the guest. Drive the real page coordinates
    // instead of bypassing that overlay with a forced element click.
    await page.mouse.move(box.x + 120, box.y + 120);
    await page.mouse.click(box.x + 120, box.y + 120);
    const inputDeadline = Date.now() + 10_000;
    do {
      await page.waitForTimeout(250);
      rtcEvidence = await collectWebRtcEvidence(page);
      const pointerStates = rtcEvidence.pointerLeftButtonStates.slice(
        rtcBeforeInput.pointerLeftButtonStates.length,
      );
      const transportPointerStates = transport === "websocket"
        ? websocketPointerLeftButtonStates.slice(websocketPointerCountBeforeInput)
        : pointerStates;
      const downIndex = transportPointerStates.findIndex(Boolean);
      clickDownObserved = downIndex >= 0;
      clickUpAfterDownObserved = downIndex >= 0
        && transportPointerStates.slice(downIndex + 1).includes(false);
      const inputObserved = clickDownObserved && clickUpAfterDownObserved;
      if (inputObserved) break;
    } while (Date.now() < inputDeadline);
    if (transport === "websocket" && (!clickDownObserved || !clickUpAfterDownObserved)) {
      throw new Error("The live desktop rendered, but no WebSocket pointer down/up pair followed the click.");
    }
    if (
      transport === "webrtc"
      && (!clickDownObserved || !clickUpAfterDownObserved)
    ) {
      throw new Error("The live desktop rendered, but pointer input sent no WebRTC data-channel message.");
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshot = readFileSync(screenshotPath);

    return {
      title: await page.title(),
      visualSurfaceCount: await page.locator("canvas, video").count(),
      websocketCount,
      websocketFramesReceived,
      websocketFramesSent,
      rtcPeerCount: rtcEvidence.peerCount,
      rtcConnectionStates: rtcEvidence.connectionStates,
      rtcInboundVideoPackets: rtcEvidence.inboundVideoPackets,
      rtcFramesDecoded: rtcEvidence.framesDecoded,
      rtcDataChannelMessagesSent: rtcEvidence.dataChannelMessagesSent,
      rtcInstrumentedDataSends: rtcEvidence.instrumentedDataSends,
      pointerMessageCount: transport === "websocket"
        ? websocketPointerLeftButtonStates.length
        : rtcEvidence.pointerLeftButtonStates.length,
      clickDownObserved,
      clickUpAfterDownObserved,
      selectedCandidatePairs: rtcEvidence.selectedCandidatePairs,
      inputPath: transport === "webrtc" ? "webrtc-data-channel" : "websocket",
      screenshotPath,
      screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
      screenshotBytes: statSync(screenshotPath).size,
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const transport = parseSelkiesTransport(process.argv.slice(2));
  const runId = `${Date.now()}-${process.pid}`;
  const containerName = `hivra-selkies-smoke-${runId}`;
  const networkName = `hivra-selkies-net-${runId}`;
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "hivra-selkies-smoke-"));
  const envFilePath = path.join(temporaryDirectory, "session.env");
  const proxyFilePath = path.join(temporaryDirectory, "cdp-proxy.py");
  const screenshotPath = path.join(tmpdir(), `hivra-selkies-desktop-${runId}.png`);
  const plan = publicSelkiesDockerPlan({ containerName, envFilePath, networkName, transport });

  if (!apply) {
    console.log(JSON.stringify({ mode: "plan", ...plan }, null, 2));
    rmSync(temporaryDirectory, { recursive: true, force: true });
    return;
  }

  const username = "hivra-smoke";
  const password = randomBytes(24).toString("base64url");
  const basicCredentials = Buffer.from(`${username}:${password}`).toString("base64");
  const cdpToken = randomBytes(32).toString("base64url");
  writeFileSync(envFilePath, [
    `PASSWD=${password}`,
    `SELKIES_BASIC_AUTH_USER=${username}`,
    `SELKIES_BASIC_AUTH_PASSWORD=${password}`,
    "SELKIES_ENABLE_HTTPS=false",
    `SELKIES_MODE=${selkiesModeForTransport(transport)}`,
    ...(transport === "webrtc" ? [
      "SELKIES_TURN_HOST=127.0.0.1",
      `SELKIES_TURN_PORT=${TURN_PORT}`,
      "SELKIES_TURN_PROTOCOL=udp",
      `TURN_MIN_PORT=${TURN_MIN_PORT}`,
      `TURN_MAX_PORT=${TURN_MAX_PORT}`,
    ] : []),
    "SELKIES_WAYLAND=false",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(proxyFilePath, buildContainedCdpProxy(cdpToken, basicCredentials), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  let networkDispatchAttempted = false;
  let containerDispatchAttempted = false;
  try {
    assertDockerObjectAbsent("container", containerName);
    assertDockerObjectAbsent("network", networkName);
    networkDispatchAttempted = true;
    docker([
      "network", "create",
      "--driver", "bridge",
      "--label", "hivra.fixture=selkies-desktop",
      networkName,
    ]);
    containerDispatchAttempted = true;
    docker(buildSelkiesDockerRunArgs({ containerName, envFilePath, networkName, transport }));
    const port = resolvePublishedPort(containerName);
    const url = `http://127.0.0.1:${port}/`;
    const authorization = `Basic ${basicCredentials}`;
    const http = await waitForHttp(url, authorization);
    const cdpUrl = transport === "webrtc"
      ? await startContainedChromium(containerName, proxyFilePath, cdpToken)
      : undefined;
    // Contained Chromium reaches Selkies only through the guest-loopback proxy.
    // The browser never receives the Basic credential; the root-only proxy adds
    // it while forwarding to Selkies on the same container's loopback address.
    const browserUrl = transport === "webrtc" ? "http://127.0.0.1:8081/" : url;
    const browser = await runBrowserAcceptance(
      browserUrl,
      username,
      password,
      screenshotPath,
      transport,
      cdpUrl,
      cdpToken,
    );
    const inspect = JSON.parse(docker(["inspect", containerName]))[0];

    console.log(`SELKIES_DESKTOP_SMOKE_PASS ${JSON.stringify({
      protocol: "hivra-selkies-desktop-smoke-v2",
      sourceCommit: SELKIES_DESKTOP_FIXTURE.sourceCommit,
      image: PINNED_IMAGE,
      imageId: inspect?.Image,
      platform: inspect?.Platform,
      loopbackAddress: "127.0.0.1",
      unauthenticatedStatus: http.unauthenticated,
      authenticatedStatus: http.authenticated,
      pageContainsSelkiesClient: /selkies/i.test(http.body),
      browser,
      compositor: SELKIES_DESKTOP_FIXTURE.compositor,
      transport,
    })}`);
  } catch (error) {
    if (containerDispatchAttempted) {
      const logs = redactSelkiesSecrets(
        docker(["logs", "--tail", "160", containerName], { tolerateFailure: true }),
        [password, basicCredentials, cdpToken],
      );
      if (logs) console.error(logs);
    }
    throw error;
  } finally {
    let cleanupFailure: Error | null = null;
    try {
      cleanupSelkiesDockerObjects({
        containerName,
        networkName,
        cleanupContainer: containerDispatchAttempted,
        cleanupNetwork: networkDispatchAttempted,
      });
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (cleanupFailure) throw cleanupFailure;
    if (containerDispatchAttempted || networkDispatchAttempted) {
      console.log(`SELKIES_DESKTOP_SMOKE_CLEAN ${JSON.stringify({
        containerName,
        containerSurvives: false,
        networkName,
        networkSurvives: false,
        envFileRemoved: true,
        inventoryAuthoritative: true,
      })}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
