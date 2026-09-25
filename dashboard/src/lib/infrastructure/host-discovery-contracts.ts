import { z } from "zod";

/** The snapshot contract new host and Proxmox inspections write. Version 2
 * records how the connection reached root (privilegeVia) and whether a
 * non-root login has passwordless sudo. Version 1 snapshots (written before
 * sudo connections existed) have neither field and are read as privilegeVia
 * "login", which is exact: they were all taken over the SSH login. */
export const HOST_DISCOVERY_CONTRACT_VERSION = 2 as const;
/** The Hetzner provider lane is a separate contract with its own SQL
 * (20260828030000 publishes only contractVersion 1) and its own script
 * protocol, run through the first-boot recipe. Slice 13 changes neither: the
 * provider lane keeps version 1, byte for byte. */
export const PROVIDER_GUEST_DISCOVERY_CONTRACT_VERSION = 1 as const;
export const HOST_DISCOVERY_PROTOCOL = "HIVRA_HOST_DISCOVERY_V1" as const;
/** The read-only script's own output protocol (its PROTOCOL line), per lane:
 * host and Proxmox connections emit version 2 (with PASSWORDLESS_SUDO), the
 * provider lane's first-boot recipe keeps version 1 (without it). */
export const HOST_DISCOVERY_SCRIPT_PROTOCOL_VERSION = 2 as const;
export const PROVIDER_GUEST_DISCOVERY_SCRIPT_PROTOCOL_VERSION = 1 as const;
export type HostDiscoveryScriptLane = "host" | "provider-guest";
export const HOST_DISCOVERY_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
export const MAX_HOST_DISCOVERY_OUTPUT_BYTES = 48 * 1_024;

const HOST_DISCOVERY_ERROR_CODES = [
  "CONNECTION_NOT_FOUND",
  "INVALID_CONNECTION",
  "HOST_RESOLUTION_FAILED",
  "HOST_ADDRESS_BLOCKED",
  "SSH_HOST_KEY_MISMATCH",
  "SSH_AUTHENTICATION_FAILED",
  "SSH_CONNECTION_FAILED",
  "SSH_COMMAND_FAILED",
  "SSH_SUDO_UNAVAILABLE",
  "DISCOVERY_OUTPUT_INVALID",
  "DISCOVERY_SUPERSEDED",
  "DISCOVERY_INTERNAL_ERROR",
] as const;

export const HOST_ISOLATION_ENGINE_IDS = [
  "proxmox-kvm",
  "qemu-kvm",
  "gvisor",
  "docker",
  "containerd",
  "podman",
  "oci-runc",
  "oci-crun",
  "lxc",
] as const;

const HOST_ENGINE_REQUIREMENTS = [
  "LINUX_REQUIRED",
  "ROOT_REQUIRED",
  "KVM_REQUIRED",
  "SUPPORTED_ARCH_REQUIRED",
  "PACKAGE_MANAGER_REQUIRED",
  "ENGINE_NOT_INSTALLED",
  "ENGINE_VERSION_UNSUPPORTED",
  "RUNTIME_ADAPTER_UNAVAILABLE",
  "CGROUP_V2_REQUIRED",
  "DOCKER_REQUIRED",
  "SUPPORTED_OS_REQUIRED",
] as const;

const UuidSchema = z.string().uuid();
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const NullableByteCountSchema = z.number().int().nonnegative().safe().nullable();
const NullableSafeIntegerSchema = z.number().int().nonnegative().safe().nullable();

const HostDiscoveryEngineSchema = z
  .object({
    id: z.enum(HOST_ISOLATION_ENGINE_IDS),
    availability: z.enum(["installed", "installable", "unavailable"]),
    supported: z.boolean(),
    detectedVersion: z.string().min(1).max(160).nullable(),
    unmetRequirements: z
      .array(z.enum(HOST_ENGINE_REQUIREMENTS))
      .max(HOST_ENGINE_REQUIREMENTS.length)
      .refine((requirements) => new Set(requirements).size === requirements.length, {
        message: "Engine requirements must be unique",
      }),
  })
  .strict();

const HostDiscoverySnapshotFields = z
  .object({
    discoveryId: UuidSchema,
    connectionId: UuidSchema,
    connectionRevision: z.number().int().positive().safe(),
    /** Informational only. It is never an isolation or launch decision. */
    connectionProvider: z.enum(["proxmox", "host"]),
    contractVersion: z.union([z.literal(1), z.literal(2)]),
    observedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    hostIdentityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    host: z
      .object({
        os: z
          .object({
            family: z.enum(["linux", "unknown"]),
            id: z.string().min(1).max(64).nullable(),
            versionId: z.string().min(1).max(64).nullable(),
          })
          .strict(),
        kernel: z
          .object({
            release: z.string().min(1).max(128).nullable(),
            architecture: z.enum(["amd64", "arm64", "other"]),
          })
          .strict(),
        environment: z
          .object({
            effectivePrivilege: z.enum(["root", "non-root", "unknown"]),
            /** v2: whether a non-root login can run sudo without a password.
             * Null when Hivra didn't ask (already root, or no sudo). */
            passwordlessSudo: z.boolean().nullable().optional(),
            /** v2: how this connection reaches root, from the connection. */
            privilegeVia: z.enum(["login", "sudo"]).optional(),
            virtualization: z.enum([
              "bare-metal",
              "virtual-machine",
              "container",
              "unknown",
            ]),
            cgroupVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
            packageManagers: z
              .array(z.enum(["apt", "dnf", "yum", "zypper", "apk"]))
              .max(5)
              .refine((values) => new Set(values).size === values.length, {
                message: "Package managers must be unique",
              }),
          })
          .strict(),
        capacity: z
          .object({
            cpu: z.object({ logicalCores: NullableSafeIntegerSchema }).strict(),
            memoryBytes: z
              .object({
                total: NullableByteCountSchema,
                available: NullableByteCountSchema,
              })
              .strict(),
            rootStorageBytes: z
              .object({
                total: NullableByteCountSchema,
                available: NullableByteCountSchema,
              })
              .strict(),
          })
          .strict(),
        kvm: z
          .object({
            devicePresent: z.boolean(),
            cpuVirtualization: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    engines: z
      .array(HostDiscoveryEngineSchema)
      .length(HOST_ISOLATION_ENGINE_IDS.length)
      .refine((engines) => new Set(engines.map((engine) => engine.id)).size === engines.length, {
        message: "Discovered engines must be unique",
      }),
  })
  .strict();

function validateSnapshot(snapshot:Pick<z.infer<typeof HostDiscoverySnapshotFields>,"observedAt"|"expiresAt"|"host"|"contractVersion">,context:z.RefinementCtx) {
    const environment = snapshot.host.environment;
    const hasPrivilegeFields = environment.privilegeVia !== undefined || environment.passwordlessSudo !== undefined;
    if (snapshot.contractVersion === 1 ? hasPrivilegeFields
      : environment.privilegeVia === undefined || environment.passwordlessSudo === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host", "environment"],
        message: "Version 2 snapshots record privilegeVia and passwordlessSudo; version 1 snapshots record neither",
      });
    }
    const observedAt = Date.parse(snapshot.observedAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (
      !Number.isFinite(observedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - observedAt !== HOST_DISCOVERY_SNAPSHOT_TTL_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Discovery snapshots must use the bounded discovery TTL",
      });
    }

    const memory = snapshot.host.capacity.memoryBytes;
    if (memory.total !== null && memory.available !== null && memory.available > memory.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host", "capacity", "memoryBytes", "available"],
        message: "Available memory cannot exceed total memory",
      });
    }
    const storage = snapshot.host.capacity.rootStorageBytes;
    if (storage.total !== null && storage.available !== null && storage.available > storage.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host", "capacity", "rootStorageBytes", "available"],
        message: "Available storage cannot exceed total storage",
      });
    }
}

export const HostDiscoverySnapshotSchema = HostDiscoverySnapshotFields.superRefine(validateSnapshot);

/** Separate informational contract: this is one enrolled provider VM, not a
 * Proxmox pool or permission to create nested guests. It is never accepted by
 * the existing generic-host store or deployment-target admission schemas.
 */
export const ProviderGuestDiscoverySnapshotSchema = HostDiscoverySnapshotFields.extend({
  connectionProvider:z.literal("hetzner-cloud"),
  // A different contract from generic hosts; it always runs through sudo and
  // is unchanged by contract version 2.
  contractVersion:z.literal(PROVIDER_GUEST_DISCOVERY_CONTRACT_VERSION),
  providerServerId:z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value=>Number.isSafeInteger(Number(value))),
  capacityOrderId:UuidSchema,
  enrollmentAttemptId:UuidSchema,
}).superRefine((snapshot,context)=>{
  validateSnapshot(snapshot,context);
  snapshot.engines.forEach((engine,index)=>{
    if(engine.supported)context.addIssue({code:z.ZodIssueCode.custom,path:["engines",index,"supported"],
      message:"Provider guest discovery cannot authorize nested isolation engines"});
  });
});

const HostDiscoveryErrorSchema = z
  .object({
    code: z.enum(HOST_DISCOVERY_ERROR_CODES),
    message: z.string().min(1).max(300),
    remediation: z.string().min(1).max(500).optional(),
    /** For SSH_HOST_KEY_MISMATCH: the pinned identity and the one the server
     * presented, so the owner can compare them side by side. */
    hostKey: z
      .object({
        expected: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
        presented: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export const HostDiscoveryResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      snapshot: HostDiscoverySnapshotSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      connectionId: UuidSchema,
      attemptedAt: IsoDateTimeSchema,
      error: HostDiscoveryErrorSchema,
    })
    .strict(),
]);

export type HostDiscoveryErrorCode = (typeof HOST_DISCOVERY_ERROR_CODES)[number];
export type HostIsolationEngineId = (typeof HOST_ISOLATION_ENGINE_IDS)[number];
export type HostEngineRequirement = (typeof HOST_ENGINE_REQUIREMENTS)[number];
export type HostDiscoveryEngine = z.infer<typeof HostDiscoveryEngineSchema>;
export type HostDiscoverySnapshot = z.infer<typeof HostDiscoverySnapshotSchema>;

/** How a snapshot's connection reached root. Version 1 is always "login". */
export function snapshotPrivilegeVia(snapshot: Pick<HostDiscoverySnapshot, "contractVersion" | "host">): "login" | "sudo" {
  return snapshot.contractVersion === 1 ? "login" : snapshot.host.environment.privilegeVia ?? "login";
}
export type ProviderGuestDiscoverySnapshot = z.infer<typeof ProviderGuestDiscoverySnapshotSchema>;
export type HostDiscoveryResult = z.infer<typeof HostDiscoveryResultSchema>;
