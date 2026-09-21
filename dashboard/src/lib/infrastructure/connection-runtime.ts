import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

import { reservedAddressReason } from "@/lib/url-safety";
import { normalizeProxmoxSshHostFingerprint } from "@/lib/services/proxmox-instance-service";

type DnsAddress = { address: string; family: number };
type EnvLike = Record<string, string | undefined>;
type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsAddress[]>;

export type ProxmoxConnectionRuntimeInput = {
  id: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostFingerprintSha256: string;
  sshPrivateKey: string;
  node?: string | null;
  templateId?: number | null;
  vmidStart?: number | null;
  vmidEnd?: number | null;
  bridge?: string | null;
  storage?: string | null;
};

export type ValidatedSshDestination = {
  /** Original display/configuration hostname. Never used for the socket. */
  hostname: string;
  /** Validated address used for the SSH socket, preventing DNS-rebind TOCTOU. */
  address: string;
  family: number;
};

export class InfrastructureNetworkError extends Error {
  constructor(
    readonly code:
      | "ssh_host_invalid"
      | "ssh_host_unresolvable"
      | "ssh_host_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "InfrastructureNetworkError";
  }
}

const PRIVATE_REASONS = new Set([
  "private_v4",
  "cgnat_v4",
  "unique_local_v6",
  "ipv6_mapped_private_v4",
  "ipv6_mapped_cgnat_v4",
]);

function privateNetworksAllowed(env: EnvLike): boolean {
  return env.HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS?.trim().toLowerCase() === "true";
}

function validateResolvedAddress(address: string, allowPrivateNetwork: boolean): void {
  if (!net.isIP(address)) {
    throw new InfrastructureNetworkError("ssh_host_invalid", "SSH host resolved to an invalid address.");
  }

  const reason = reservedAddressReason(address);
  if (!reason) return;
  if (allowPrivateNetwork && PRIVATE_REASONS.has(reason)) return;

  // Loopback, unspecified, link-local and metadata destinations remain blocked
  // even for a self-hosted control plane with private-network access enabled.
  throw new InfrastructureNetworkError(
    "ssh_host_forbidden",
    "SSH host resolves to an address that this control plane is not allowed to reach.",
  );
}

export async function resolveValidatedSshDestination(
  rawHostname: string,
  options: {
    env?: EnvLike;
    lookup?: DnsLookup;
  } = {},
): Promise<ValidatedSshDestination> {
  const hostname = rawHostname.trim().replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.toLowerCase();
  if (
    !hostname ||
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost")
  ) {
    throw new InfrastructureNetworkError("ssh_host_invalid", "SSH host is invalid.");
  }

  const allowPrivateNetwork = privateNetworksAllowed(options.env ?? process.env);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    validateResolvedAddress(hostname, allowPrivateNetwork);
    return { hostname, address: hostname, family: literalFamily };
  }

  let addresses: DnsAddress[];
  try {
    const resolver: DnsLookup = options.lookup ?? ((name, lookupOptions) =>
      dnsLookup(name, lookupOptions));
    addresses = await resolver(hostname, {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new InfrastructureNetworkError(
      "ssh_host_unresolvable",
      "SSH host could not be resolved.",
    );
  }

  const uniqueAddresses = addresses.filter(
    (entry, index, all) =>
      net.isIP(entry.address) > 0 &&
      all.findIndex((candidate) => candidate.address === entry.address) === index,
  );
  if (uniqueAddresses.length === 0) {
    throw new InfrastructureNetworkError(
      "ssh_host_unresolvable",
      "SSH host did not resolve to an address.",
    );
  }

  // Reject the hostname if ANY answer is forbidden. Selecting only a public
  // answer from a mixed public/private response would leave room for rebinding
  // and inconsistent resolver order between checks.
  for (const entry of uniqueAddresses) {
    validateResolvedAddress(entry.address, allowPrivateNetwork);
  }

  return {
    hostname,
    address: uniqueAddresses[0].address,
    family: uniqueAddresses[0].family,
  };
}

/**
 * Build a fresh, allowlisted environment for one user-owned Proxmox target.
 * No ambient managed-fleet credential or routing variable is inherited.
 */
export function buildUserProxmoxEnvironment(
  connection: ProxmoxConnectionRuntimeInput,
  destination: ValidatedSshDestination,
): EnvLike {
  const env: EnvLike = {
    HIVRA_USER_INFRA_CONNECTION: "true",
    HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true",
    PROXMOX_EXEC_MODE: "ssh",
    PROXMOX_ALLOW_SSH_AGENT: "false",
    PROXMOX_SSH_HOST: destination.address,
    PROXMOX_SSH_PORT: String(connection.sshPort),
    PROXMOX_SSH_USER: connection.sshUser,
    PROXMOX_SSH_PRIVATE_KEY: connection.sshPrivateKey,
    PROXMOX_SSH_HOST_FINGERPRINT: normalizeProxmoxSshHostFingerprint(
      connection.sshHostFingerprintSha256,
    ),
  };

  if (connection.node) env.PROXMOX_NODE = connection.node;
  if (connection.templateId != null) env.PROXMOX_TEMPLATE_ID = String(connection.templateId);
  if (connection.vmidStart != null) env.PROXMOX_VMID_START = String(connection.vmidStart);
  if (connection.vmidEnd != null) env.PROXMOX_VMID_END = String(connection.vmidEnd);
  if (connection.bridge) env.PROXMOX_BRIDGE = connection.bridge;
  if (connection.storage) env.PROXMOX_STORAGE = connection.storage;

  return env;
}
