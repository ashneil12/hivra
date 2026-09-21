import "server-only";

import { createCipheriv, createHmac } from "node:crypto";
import { z } from "zod";

import type { PreparedWindowsRdpDescriptor } from "@/lib/remote-computers/windows-rdp-capability";
import { type DesktopStreamingMode } from "@/lib/remote-computers/streaming-mode-preference";
import { windowsDesktopDimensions, type WindowsDesktopViewport } from "./windows-desktop-viewport";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4_32 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\/32$/;

const Config = z.object({
  version: z.literal(1),
  computerId: z.string().regex(UUID),
  guestPrivateIpv4: z.string().ip({ version: "v4" }),
  gatewaySourceCidr: z.string().regex(IPV4_32),
  gatewayOrigin: z.string().url(),
  connectionName: z.string().min(1).max(128),
  rdpUsername: z.string().min(1).max(128),
  rdpPassword: z.string().min(16).max(256),
  certificateFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  guacamoleSecretHex: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

export type WindowsRdpGatewayConfig = z.infer<typeof Config>;

function exactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function privateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168
      || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export function readWindowsRdpGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): WindowsRdpGatewayConfig | null {
  const raw = env.HIVRA_WINDOWS_RDP_GATEWAY_CONFIG?.trim();
  if (!raw) return null;
  try {
    const parsed = Config.parse(JSON.parse(raw));
    if (!privateIpv4(parsed.guestPrivateIpv4) || !exactHttpsOrigin(parsed.gatewayOrigin)) return null;
    const gatewayAddress = parsed.gatewaySourceCidr.slice(0, -3);
    if (!privateIpv4(gatewayAddress) || gatewayAddress === parsed.guestPrivateIpv4) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function gatewaySourceCidrForWindowsComputer(params: {
  computerId: string;
  guestPrivateIpv4: string;
}, env: Record<string, string | undefined> = process.env): string | null {
  const configured = readWindowsRdpGatewayConfig(env);
  if (env.HIVRA_WINDOWS_RDP_GATEWAY_CONFIG?.trim()) {
    return configured?.computerId === params.computerId
      && configured.guestPrivateIpv4 === params.guestPrivateIpv4
      ? configured.gatewaySourceCidr : null;
  }
  const octets = params.guestPrivateIpv4.split(".");
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.1/32` : null;
}

export function windowsDescriptorMatchesGateway(
  descriptor: PreparedWindowsRdpDescriptor,
  config: WindowsRdpGatewayConfig,
): boolean {
  return descriptor.computerId === config.computerId
    && descriptor.guestPrivateIpv4 === config.guestPrivateIpv4
    && descriptor.certificateFingerprint === config.certificateFingerprint
    && descriptor.rdpServiceState === "running"
    && descriptor.rdpPort === 3389
    && descriptor.nla === true
    && descriptor.listenerVerified === true
    && descriptor.route.exclusive === true
    && descriptor.route.sourceCidrs.length === 1
    && descriptor.route.sourceCidrs[0] === config.gatewaySourceCidr;
}

export function guacamoleClientIdentifier(connectionName: string): string {
  return Buffer.from(`${connectionName}\0c\0json`, "utf8").toString("base64url");
}

export function buildWindowsGatewayToken(params: {
  config: WindowsRdpGatewayConfig;
  ownerId: string;
  streamingMode: DesktopStreamingMode;
  viewport?: WindowsDesktopViewport;
  expires: number;
}, now = Date.now()): string | null {
  if (!params.ownerId || params.ownerId.length > 256 || !Number.isSafeInteger(params.expires)
    || params.expires <= now || params.expires > now + 60_000) return null;
  const fingerprintHex = params.config.certificateFingerprint.slice("sha256:".length);
  const profile = windowsDesktopDimensions(params.streamingMode, params.viewport);
  if (!profile) return null;
  const parameters: Record<string, string> = {
    hostname: params.config.guestPrivateIpv4,
    port: "3389",
    username: params.config.rdpUsername,
    password: params.config.rdpPassword,
    security: "nla",
    "cert-fingerprints": `sha256:${fingerprintHex.match(/.{2}/g)?.join(":")}`,
    "resize-method": "display-update",
    width: String(profile.width),
    height: String(profile.height),
    "normalize-clipboard": "windows",
    // FreeRDP's GFX pipeline requires 32-bit color. Performance mode reduces
    // effects instead of requesting a depth that the negotiated codec ignores.
    "color-depth": "32",
  };
  if (params.streamingMode !== "performance") Object.assign(parameters, {
    "enable-wallpaper": "true",
    "enable-theming": "true",
    "enable-font-smoothing": "true",
    "enable-full-window-drag": "true",
    "enable-desktop-composition": "true",
    "enable-menu-animations": "true",
  });
  const payload = JSON.stringify({
    username: `hivra:${params.ownerId.slice(0, 64)}`,
    expires: params.expires,
    connections: {
      [params.config.connectionName]: { protocol: "rdp", parameters },
    },
  });
  const key = Buffer.from(params.config.guacamoleSecretHex, "hex");
  const signature = createHmac("sha256", key).update(payload).digest();
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.concat([signature, Buffer.from(payload, "utf8")])), cipher.final()]).toString("base64");
}
