jest.mock("server-only", () => ({}));

import { createDecipheriv, createHmac } from "node:crypto";
import { windowsDesktopDimensions } from "../windows-desktop-viewport";

import {
  buildWindowsGatewayToken,
  gatewaySourceCidrForWindowsComputer,
  guacamoleClientIdentifier,
  readWindowsRdpGatewayConfig,
} from "../windows-rdp-gateway";

const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-09T09:00:00.000Z");
const config = {
  version: 1 as const,
  computerId: COMPUTER_ID,
  guestPrivateIpv4: "10.240.20.98",
  gatewaySourceCidr: "10.240.20.96/32",
  gatewayOrigin: "https://windows-canary.hermesos.cloud",
  connectionName: "Hivra Windows Canary",
  rdpUsername: "hivra-desktop",
  rdpPassword: "fixture-password-long-enough",
  certificateFingerprint: `sha256:${"a".repeat(64)}`,
  guacamoleSecretHex: "b".repeat(32),
};

it.each(["hq", "qhd", "uhd", "performance"] as const)("fits %s quality to the inline panel without a forced widescreen aspect", mode => {
  const viewport = { width: 816, height: 617 };
  const dimensions = windowsDesktopDimensions(mode, viewport)!;
  // A 64px canvas block is proportionally larger at Performance resolution.
  expect(Math.abs(dimensions.width / dimensions.height - viewport.width / viewport.height)).toBeLessThan(64 / dimensions.height);
  expect(dimensions.width % 64).toBe(0);
  expect(dimensions.height % 64).toBe(0);
  const token = buildWindowsGatewayToken({ config, ownerId: "user_fixture", streamingMode: mode, viewport, expires: NOW + 45_000 }, NOW)!;
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(config.guacamoleSecretHex, "hex"), Buffer.alloc(16));
  const decoded = Buffer.concat([decipher.update(Buffer.from(token, "base64")), decipher.final()]);
  const parameters = JSON.parse(decoded.subarray(32).toString("utf8")).connections[config.connectionName].parameters;
  expect(parameters).toMatchObject({ width: String(dimensions.width), height: String(dimensions.height), "resize-method": "display-update" });
  expect(dimensions.height).toBeLessThanOrEqual(mode === "uhd" ? 2160 : mode === "qhd" ? 1440 : mode === "performance" ? 720 : 1080);
});

it("requests the exact aligned canvas for the observed HQ panel so negotiation cannot enlarge it", () => {
  expect(windowsDesktopDimensions("hq", { width: 816, height: 617 })).toEqual({ width: 1344, height: 1024 });
  // Preserve compatibility for clients that do not yet send a panel viewport.
  expect(windowsDesktopDimensions("hq")).toEqual({ width: 1920, height: 1080 });
});

it.each([{ width: 1920, height: 600 }, { width: 800, height: 1200 }, { width: 816, height: 617 }])("bounds aligned desktop geometry for %j", viewport => {
  const dimensions = windowsDesktopDimensions("hq", viewport)!;
  expect(dimensions.width).toBeLessThanOrEqual(1920);
  expect(dimensions.height).toBeLessThanOrEqual(1080);
  expect(dimensions.width % 64).toBe(0);
  expect(dimensions.height % 64).toBe(0);
});

it.each([{ width: 0, height: 617 }, { width: 1.5, height: 617 }, { width: 16_385, height: 617 }, { width: 1, height: 1000 }])("rejects unsafe or unsupported viewport geometry %j", viewport => {
  expect(buildWindowsGatewayToken({ config, ownerId: "user_fixture", streamingMode: "hq", viewport, expires: NOW + 45_000 }, NOW)).toBeNull();
});

it("selects the exact configured gateway instead of the bridge router", () => {
  const env = { HIVRA_WINDOWS_RDP_GATEWAY_CONFIG: JSON.stringify(config) };
  expect(readWindowsRdpGatewayConfig(env)).toEqual(config);
  expect(gatewaySourceCidrForWindowsComputer({ computerId: COMPUTER_ID, guestPrivateIpv4: "10.240.20.98" }, env))
    .toBe("10.240.20.96/32");
  expect(gatewaySourceCidrForWindowsComputer({ computerId: COMPUTER_ID, guestPrivateIpv4: "10.240.20.99" }, env))
    .toBeNull();
});

it("fails closed when an explicitly configured gateway is malformed", () => {
  const env = { HIVRA_WINDOWS_RDP_GATEWAY_CONFIG: JSON.stringify({ ...config, gatewaySourceCidr: "0.0.0.0/0" }) };
  expect(readWindowsRdpGatewayConfig(env)).toBeNull();
  expect(gatewaySourceCidrForWindowsComputer({ computerId: COMPUTER_ID, guestPrivateIpv4: "10.240.20.98" }, env))
    .toBeNull();
});

it("builds a signed encrypted Guacamole handoff without exposing credentials", () => {
  const token = buildWindowsGatewayToken({ config, ownerId: "user_fixture", streamingMode: "performance", expires: NOW + 45_000 }, NOW);
  expect(token).toBeTruthy();
  const key = Buffer.from(config.guacamoleSecretHex, "hex");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16));
  const decoded = Buffer.concat([decipher.update(Buffer.from(token!, "base64")), decipher.final()]);
  const signature = decoded.subarray(0, 32);
  const payload = decoded.subarray(32);
  expect(signature).toEqual(createHmac("sha256", key).update(payload).digest());
  const parsed = JSON.parse(payload.toString("utf8"));
  expect(parsed.connections[config.connectionName]).toMatchObject({
    protocol: "rdp",
    parameters: {
      hostname: "10.240.20.98",
      username: "hivra-desktop",
      password: config.rdpPassword,
      "color-depth": "32",
      "cert-fingerprints": `sha256:${"aa:".repeat(31)}aa`,
    },
  });
  expect(parsed.connections[config.connectionName].parameters).not.toHaveProperty("enable-wallpaper");
  expect(guacamoleClientIdentifier(config.connectionName)).toBe("SGl2cmEgV2luZG93cyBDYW5hcnkAYwBqc29u");
});

it.each([
  ["hq", "1920", "1080"],
  ["qhd", "2560", "1440"],
  ["uhd", "3840", "2160"],
] as const)("binds the %s desktop dimensions into the Windows handoff", (streamingMode, width, height) => {
  const token = buildWindowsGatewayToken({ config, ownerId: "user_fixture", streamingMode, expires: NOW + 45_000 }, NOW)!;
  const key = Buffer.from(config.guacamoleSecretHex, "hex");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16));
  const decoded = Buffer.concat([decipher.update(Buffer.from(token, "base64")), decipher.final()]);
  const payload = JSON.parse(decoded.subarray(32).toString("utf8"));
  expect(payload.connections[config.connectionName].parameters).toMatchObject({ width, height });
});
