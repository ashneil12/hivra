#!/usr/bin/env node

import { createCipheriv, createHmac } from "node:crypto";
import { isIP } from "node:net";

const HEX_128 = /^[0-9a-f]{32}$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function isPrivateIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || first === 192 && second === 168
    || first === 172 && second >= 16 && second <= 31;
}

export function buildGuacamoleRdpParameters({
  hostname, username, password, certificateFingerprint, streamingMode,
}) {
  if (!isPrivateIpv4(hostname)) throw new TypeError("guacamole_rdp_target_invalid");
  if (typeof username !== "string" || username.length < 1 || username.length > 256
      || typeof password !== "string" || password.length < 1 || password.length > 512) {
    throw new TypeError("guacamole_rdp_credentials_invalid");
  }
  if (!SHA256_FINGERPRINT.test(certificateFingerprint)) {
    throw new TypeError("guacamole_rdp_certificate_invalid");
  }
  if (streamingMode !== "hq" && streamingMode !== "performance") {
    throw new TypeError("guacamole_streaming_mode_invalid");
  }
  // Hivra stores compact lower-case SHA-256 fingerprints. FreeRDP's
  // fingerprint option requires the digest bytes separated by colons.
  const fingerprintHex = certificateFingerprint.slice("sha256:".length);
  const freeRdpFingerprint = `sha256:${fingerprintHex.match(/.{2}/g).join(":")}`;
  const parameters = {
    hostname,
    port: "3389",
    username,
    password,
    security: "nla",
    "cert-fingerprints": freeRdpFingerprint,
    "resize-method": "display-update",
    "normalize-clipboard": "windows",
    "color-depth": streamingMode === "hq" ? "24" : "16",
  };
  if (streamingMode === "hq") {
    Object.assign(parameters, {
      "enable-wallpaper": "true",
      "enable-theming": "true",
      "enable-font-smoothing": "true",
      "enable-full-window-drag": "true",
      "enable-desktop-composition": "true",
      "enable-menu-animations": "true",
    });
  }
  return parameters;
}

export function buildGuacamoleJsonToken({
  secretHex, username, expires, connectionName, hostname, rdpUsername, rdpPassword,
  certificateFingerprint, streamingMode,
}) {
  if (!HEX_128.test(secretHex)) throw new TypeError("guacamole_secret_must_be_128_bit_lowercase_hex");
  if (typeof username !== "string" || username.length < 1 || username.length > 128) {
    throw new TypeError("guacamole_username_invalid");
  }
  const now = Date.now();
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + 60_000) {
    throw new TypeError("guacamole_expiry_invalid");
  }
  if (typeof connectionName !== "string" || connectionName.length < 1 || connectionName.length > 128) {
    throw new TypeError("guacamole_connection_name_invalid");
  }
  const parameters = buildGuacamoleRdpParameters({
    hostname, username: rdpUsername, password: rdpPassword,
    certificateFingerprint, streamingMode,
  });

  const payload = JSON.stringify({
    username,
    expires,
    connections: {
      [connectionName]: {
        protocol: "rdp",
        parameters,
      },
    },
  });
  const key = Buffer.from(secretHex, "hex");
  const signature = createHmac("sha256", key).update(payload).digest();
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
  return Buffer.concat([
    cipher.update(Buffer.concat([signature, Buffer.from(payload, "utf8")])),
    cipher.final(),
  ]).toString("base64");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secretHex = process.env.HIVRA_GUACAMOLE_JSON_SECRET;
  const expires = Number(process.env.HIVRA_GUACAMOLE_EXPIRES);
  const password = process.env.HIVRA_FIXTURE_RDP_PASSWORD;
  if (!secretHex || !password) throw new TypeError("guacamole_fixture_environment_missing");
  process.stdout.write(buildGuacamoleJsonToken({
    secretHex,
    username: "hivra-fixture-owner",
    expires,
    connectionName: "Hivra Windows fixture",
    hostname: "198.51.100.254",
    rdpUsername: "hivra-fixture-user",
    rdpPassword: password,
    certificateFingerprint: `sha256:${"a".repeat(64)}`,
    streamingMode: process.env.HIVRA_GUACAMOLE_STREAMING_MODE ?? "hq",
  }));
}
