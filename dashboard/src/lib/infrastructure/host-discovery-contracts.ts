import { z } from "zod";

export const HOST_DISCOVERY_CONTRACT_VERSION = 1 as const;
export const HOST_DISCOVERY_PROTOCOL = "HIVRA_HOST_DISCOVERY_V1" as const;
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
    contractVersion: z.literal(HOST_DISCOVERY_CONTRACT_VERSION),
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

function validateSnapshot(snapshot:Pick<z.infer<typeof HostDiscoverySnapshotFields>,"observedAt"|"expiresAt"|"host">,context:z.RefinementCtx) {
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
export type ProviderGuestDiscoverySnapshot = z.infer<typeof ProviderGuestDiscoverySnapshotSchema>;
export type HostDiscoveryResult = z.infer<typeof HostDiscoveryResultSchema>;
