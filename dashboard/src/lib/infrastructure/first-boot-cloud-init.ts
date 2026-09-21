import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalFirstBootHostKey, verifyFirstBootChallengeSecret,
  type FirstBootBinding, type FirstBootChallenge,
} from "./first-boot-enrollment";

const HELPER_SHA256 = "963f3ef98e79d76ebe215a4ba577481456b0fd6cfb4304c57df1e3d2dfab70a7";
const MAX_USER_DATA_BYTES = 32_768;
const HELPER_PATH = "/usr/local/lib/hivra/hetzner-enroll.py";
const CONFIG_PATH = "/run/hivra/first-boot-enrollment.json";
const CALLBACK_PATH = "/api/infrastructure/first-boot/enroll";

class FirstBootRecipeError extends Error {
  constructor(public readonly code: "invalid_origin" | "helper_unavailable" | "recipe_too_large") {
    super("First-boot recipe unavailable: " + code);
    this.name = "FirstBootRecipeError";
  }
}

export function firstBootCallbackUrl(origin: string): string {
  try {
    // The caller supplies the trusted deployment configuration, never a Host,
    // Origin or forwarded header from the incoming request.
    if (typeof origin !== "string" || origin.length > 253
      || /[\u0000-\u0020\u007f\\]/.test(origin)) throw new Error();
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash || !url.hostname
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
      || url.hostname.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
      throw new Error();
    }
    return url.origin + CALLBACK_PATH;
  } catch {
    throw new FirstBootRecipeError("invalid_origin");
  }
}

async function loadEnrollmentHelper(): Promise<string> {
  try {
    const file = await readFile(join(process.cwd(), "bootstrap/hetzner-enroll.py"));
    if (file.length > 16_384 || createHash("sha256").update(file).digest("hex") !== HELPER_SHA256) {
      throw new Error();
    }
    return file.toString("utf8");
  } catch {
    throw new FirstBootRecipeError("helper_unavailable");
  }
}

/** Private server-side user-data, not a DTO or a readiness receipt. The token
 * is deliberately present in the encoded root-only enrollment configuration.
 * Never log or return this output to the browser. Provider/guest caches may
 * retain it; its short expiry and atomic consumption remove its authority.
 * This renderer performs no provider mutation and cannot authorize power-on.
 */
export async function renderFirstBootCloudInit(input: {
  publicKeyOpenSsh: string;
  currentBinding: FirstBootBinding;
  challenge: FirstBootChallenge;
  token: string;
  callbackOrigin: string;
  now?: Date;
}): Promise<string> {
  const challenge = verifyFirstBootChallengeSecret(input);
  const publicKey = canonicalFirstBootHostKey(input.publicKeyOpenSsh).publicKey;
  const endpoint = firstBootCallbackUrl(input.callbackOrigin);
  const helper = await loadEnrollmentHelper();
  const guestConfig = JSON.stringify({
    version: 1, recipeVersion: challenge.binding.recipeVersion,
    orderId: challenge.binding.orderId, attemptId: challenge.binding.attemptId,
    token: input.token, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
    callbackUrl: endpoint,
  });
  const inline = (path: string, permissions: string, content: string) => ({
    path, owner: "root:root", permissions, encoding: "b64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
  // JSON is a YAML subset, avoiding ad-hoc quoting or shell interpolation.
  const userData = "#cloud-config\n" + JSON.stringify({
    users: [{ name: "hivra", groups: ["sudo"], sudo: ["ALL=(ALL) NOPASSWD:ALL"],
      shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [publicKey] }],
    ssh_pwauth: false, disable_root: true, ssh_deletekeys: true,
    ssh_genkeytypes: ["ed25519"], ssh_quiet_keygen: true,
    ssh_publish_hostkeys: { enabled: false },
    package_update: true, packages: ["ufw", "python3", "ca-certificates"],
    write_files: [
      inline(HELPER_PATH, "0700", helper), inline(CONFIG_PATH, "0600", guestConfig),
      inline("/etc/ssh/sshd_config.d/00-hivra-bootstrap.conf", "0644", [
        "PasswordAuthentication no", "KbdInteractiveAuthentication no",
        "PermitRootLogin no", "PubkeyAuthentication yes", "",
      ].join("\n")),
    ],
    // cloud-init does not stop a list of runcmd entries after a failure. Use
    // one fixed fail-closed program; no user input or token enters its argv.
    runcmd: [["/bin/sh", "-eu", "-c", [
      "ufw default deny incoming", "ufw default allow outgoing",
      "ufw allow 22/tcp", "ufw --force enable",
      "/usr/sbin/sshd -t", "systemctl reload ssh",
      "exec /usr/bin/python3 -I -B /usr/local/lib/hivra/hetzner-enroll.py",
    ].join("\n")]],
  }) + "\n";
  if (Buffer.byteLength(userData, "utf8") > MAX_USER_DATA_BYTES) throw new FirstBootRecipeError("recipe_too_large");
  return userData;
}
