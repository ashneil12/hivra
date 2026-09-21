import "server-only";

import type { PortableProxmoxRuntime } from "@/lib/infrastructure/proxmox-execution-context";

const MANAGED_HIVRA_PROVISIONER_CHANNELS = ["default", "canary"] as const;
export type ManagedHivraProvisionerChannel =
  (typeof MANAGED_HIVRA_PROVISIONER_CHANNELS)[number];

export type ManagedHivraRuntimePaths = Pick<
  PortableProxmoxRuntime,
  | "provisionerDirectory"
  | "storage"
  | "bridge"
  | "ubuntuImage"
  | "vmSshKeyPath"
  | "logDirectory"
>;

type ManagedHivraProvisionerChannelConfiguration = {
  runtime: ManagedHivraRuntimePaths;
  rollbackRoot: string;
  uploadTemplate: string;
};

const SHARED_MANAGED_RUNTIME_PATHS = {
  storage: "local-lvm",
  bridge: "vmbr1",
  ubuntuImage: "/root/jammy-server-cloudimg-amd64.img",
  vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
  logDirectory: "/root",
} as const;

const MANAGED_HIVRA_PROVISIONER_CHANNEL_CONFIGURATIONS = {
  default: {
    runtime: {
      provisionerDirectory: "/root/hivra-provisioner",
      ...SHARED_MANAGED_RUNTIME_PATHS,
    },
    rollbackRoot: "/root/.hivra-provisioner-rollbacks",
    uploadTemplate: "/root/.hivra-provisioner-upload.XXXXXXXX",
  },
  canary: {
    runtime: {
      provisionerDirectory: "/root/hivra-provisioner-canary",
      ...SHARED_MANAGED_RUNTIME_PATHS,
    },
    rollbackRoot: "/root/.hivra-provisioner-canary-rollbacks",
    uploadTemplate: "/root/.hivra-provisioner-canary-upload.XXXXXXXX",
  },
} as const satisfies Record<
  ManagedHivraProvisionerChannel,
  ManagedHivraProvisionerChannelConfiguration
>;

// Existing managed rows and production deployments retain the historical
// directory. Canary is a separate server-selected delivery lane, not a client
// provided path or a fallback directory.
export const MANAGED_HIVRA_RUNTIME_PATHS =
  MANAGED_HIVRA_PROVISIONER_CHANNEL_CONFIGURATIONS.default.runtime;

export function managedHivraProvisionerChannelConfiguration(
  channel: ManagedHivraProvisionerChannel,
): ManagedHivraProvisionerChannelConfiguration {
  return MANAGED_HIVRA_PROVISIONER_CHANNEL_CONFIGURATIONS[channel];
}

export function parseManagedHivraProvisionerChannel(
  value: unknown,
): ManagedHivraProvisionerChannel | null {
  return value === "default" || value === "canary" ? value : null;
}

/**
 * N-1 rows do not carry the channel column. They retain the historical default
 * directory; any non-null unknown value is corruption and must fail closed.
 */
export function persistedManagedHivraProvisionerChannel(
  value: unknown,
): ManagedHivraProvisionerChannel | null {
  if (value === null || value === undefined) return "default";
  return parseManagedHivraProvisionerChannel(value);
}

/**
 * Choose the delivery lane from trusted server configuration. The dedicated
 * Canary project's production slot needs an explicit override for Vercel cron.
 * This selects delivery, not database/tenant isolation. Custom
 * environments must be named explicitly here: an unfamiliar value must never
 * silently write a shared production provisioner directory.
 */
export function managedHivraProvisionerChannelForServerEnvironment(
  env: Record<string, string | undefined>,
): ManagedHivraProvisionerChannel {
  const targetEnvironment = env.VERCEL_TARGET_ENV ?? "";
  if (
    targetEnvironment === "canary" ||
    targetEnvironment === "" ||
    targetEnvironment === "production" ||
    targetEnvironment === "preview" ||
    targetEnvironment === "development"
  ) {
    const override = env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
    if (override !== undefined) {
      const channel = parseManagedHivraProvisionerChannel(override);
      if (!channel || (targetEnvironment === "canary" && channel !== "canary")) {
        throw new Error("Unsupported managed Hivra provisioner deployment channel.");
      }
      return channel;
    }
    return targetEnvironment === "canary" ? "canary" : "default";
  }
  throw new Error("Unsupported managed Hivra provisioner deployment channel.");
}
