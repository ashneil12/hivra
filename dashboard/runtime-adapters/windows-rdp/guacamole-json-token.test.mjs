import assert from "node:assert/strict";
import { createDecipheriv, createHmac } from "node:crypto";
import test from "node:test";

import { buildGuacamoleJsonToken, buildGuacamoleRdpParameters } from "./guacamole-json-token.mjs";

const SECRET = "00000000000000000000000000000000";

function decrypt(token) {
  const key = Buffer.from(SECRET, "hex");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16));
  const signed = Buffer.concat([decipher.update(Buffer.from(token, "base64")), decipher.final()]);
  const signature = signed.subarray(0, 32);
  const payload = signed.subarray(32);
  assert.deepEqual(signature, createHmac("sha256", key).update(payload).digest());
  return JSON.parse(payload.toString("utf8"));
}

test("builds one expiring private RDP connection for Guacamole JSON auth", () => {
  const expires = Date.now() + 30_000;
  const token = buildGuacamoleJsonToken({
    secretHex: SECRET,
    username: "owner-id",
    expires,
    connectionName: "Windows",
    hostname: "10.240.20.98",
    rdpUsername: "fixture-user",
    rdpPassword: "fixture-password",
    certificateFingerprint: `sha256:${"a".repeat(64)}`,
    streamingMode: "hq",
  });

  assert.deepEqual(decrypt(token), {
    username: "owner-id",
    expires,
    connections: {
      Windows: {
        protocol: "rdp",
        parameters: {
          hostname: "10.240.20.98",
          port: "3389",
          username: "fixture-user",
          password: "fixture-password",
          security: "nla",
          "cert-fingerprints": `sha256:${"aa:".repeat(31)}aa`,
          "resize-method": "display-update",
          "normalize-clipboard": "windows",
          "color-depth": "24",
          "enable-wallpaper": "true",
          "enable-theming": "true",
          "enable-font-smoothing": "true",
          "enable-full-window-drag": "true",
          "enable-desktop-composition": "true",
          "enable-menu-animations": "true",
        },
      },
    },
  });
});

test("rejects public targets, unbounded payloads, expired grants, and weak secrets", () => {
  const valid = {
    secretHex: SECRET,
    username: "owner-id",
    expires: Date.now() + 30_000,
    connectionName: "Windows",
    hostname: "10.240.20.98",
    rdpUsername: "fixture-user",
    rdpPassword: "fixture-password",
    certificateFingerprint: `sha256:${"a".repeat(64)}`,
    streamingMode: "hq",
  };
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, secretHex: "short" }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, expires: Date.now() - 1 }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, expires: Date.now() + 60_001 }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, hostname: "203.0.113.10" }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, hostname: "10.999.1.1" }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, certificateFingerprint: "sha256:weak" }));
  assert.throws(() => buildGuacamoleJsonToken({ ...valid, streamingMode: "automatic" }));
});

test("keeps Performance responsive while HQ retains Windows visual effects", () => {
  const base = {
    hostname: "10.251.0.8",
    username: "fixture-user",
    password: "fixture-password",
    certificateFingerprint: `sha256:${"b".repeat(64)}`,
  };
  const hq = buildGuacamoleRdpParameters({ ...base, streamingMode: "hq" });
  const performance = buildGuacamoleRdpParameters({ ...base, streamingMode: "performance" });
  assert.equal(hq["color-depth"], "24");
  assert.equal(hq["enable-desktop-composition"], "true");
  assert.equal(performance["color-depth"], "16");
  assert.equal("enable-desktop-composition" in performance, false);
  assert.equal(performance["resize-method"], "display-update");
  assert.equal(performance["cert-fingerprints"], `sha256:${"bb:".repeat(31)}bb`);
});
