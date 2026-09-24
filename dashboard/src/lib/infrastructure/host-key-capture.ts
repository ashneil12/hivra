import "server-only";

import { Client as Ssh2Client, type ConnectConfig } from "ssh2";

import { resolveValidatedSshDestination } from "./connection-runtime";
import { canonicalEd25519HostKey, type CanonicalEd25519HostKey } from "./ssh-host-key";

/** Every failure answers at this fixed delay after the request, so neither
 * text nor timing tells a closed, filtered, slow, non-SSH or RSA-only
 * destination apart (T45). */
export const HOST_KEY_CAPTURE_FAILURE_DELAY_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 8_000;

type CaptureClient = Pick<Ssh2Client, "on" | "connect" | "end" | "destroy">;

type Dependencies = {
  resolve: typeof resolveValidatedSshDestination;
  client: () => CaptureClient;
};

const defaults: Dependencies = {
  resolve: resolveValidatedSshDestination,
  client: () => new Ssh2Client(),
};

/**
 * Read the Ed25519 host key a server presents, as a fallback for an owner who
 * doesn't have the fingerprint. Only destinations that pass the SSRF rules are
 * dialled. The verifier records the key and refuses it, so no authentication
 * and no command follows: Hivra never trusts this key by itself. The owner
 * compares it with the provider's console and confirms before it is pinned.
 */
export async function captureServerHostKey(
  input: { sshHost: string; sshPort: number },
  dependencies: Partial<Dependencies> = {},
): Promise<CanonicalEd25519HostKey | null> {
  const deps = { ...defaults, ...dependencies };
  let destination: Awaited<ReturnType<typeof resolveValidatedSshDestination>>;
  try {
    destination = await deps.resolve(input.sshHost);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let captured: Buffer | null = null;
    let settled = false;
    let client: CaptureClient;
    try {
      client = deps.client();
    } catch {
      resolve(null);
      return;
    }
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.destroy(); } catch { /* Best-effort teardown. */ }
      if (!captured) {
        resolve(null);
        return;
      }
      try {
        resolve(canonicalEd25519HostKey(`ssh-ed25519 ${captured.toString("base64")}`));
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(finish, CAPTURE_TIMEOUT_MS);
    const config: ConnectConfig = {
      host: destination.address,
      port: input.sshPort,
      username: "hivra-key-check",
      algorithms: { serverHostKey: ["ssh-ed25519"] },
      readyTimeout: CAPTURE_TIMEOUT_MS,
      tryKeyboard: false,
      keepaliveInterval: 0,
      // Record the raw key, then refuse it: the handshake stops before any
      // authentication is attempted.
      hostVerifier: (key: Buffer) => {
        if (Buffer.isBuffer(key) && !captured) captured = Buffer.from(key);
        setImmediate(finish);
        return false;
      },
      authHandler: () => false,
    };
    client.on("ready", finish);
    client.on("error", finish);
    client.on("close", finish);
    try {
      client.connect(config);
    } catch {
      finish();
    }
  });
}
