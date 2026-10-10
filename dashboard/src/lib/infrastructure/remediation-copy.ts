import { isLocalAuthMode } from "@/lib/self-host/config";

// Fix text that depends on who runs Hivra. Hosted owners can't read server
// logs or change the control plane's network policy, so they never see that
// advice; a self-hosted operator can, so they do.

/** When a server resolves to an address this Hivra may not dial. */
export function blockedAddressRemediation(): string {
  return isLocalAuthMode()
    ? "Use an address this Hivra server can reach, or allow private networks on your self-hosted Hivra and restart it."
    : "Use the server's public IP address or hostname. Hosted Hivra can't reach home or office networks.";
}

/** When an operation failed inside Hivra rather than on the server. */
export function internalFailureRemediation(): string {
  return isLocalAuthMode()
    ? "Try again. If it keeps failing, check your Hivra server's logs."
    : "Try again. If it keeps failing, contact support.";
}
