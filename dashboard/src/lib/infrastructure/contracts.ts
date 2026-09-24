import { z } from "zod";

import {
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
  PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS,
  isCompatibleProviderVmProvisionerVersion,
} from "./portable-provisioner-contract";

// `proxmox` is retained for backwards compatibility with existing prepared
// connections. New host-first connections use `host`; discovery decides which
// isolation driver, if any, can safely prepare and launch on that host.
const INFRASTRUCTURE_PROVIDERS = ["proxmox", "host", "hetzner-cloud", "digitalocean"] as const;
const INFRASTRUCTURE_OPERATING_MODES = ["self-managed"] as const;
const INFRASTRUCTURE_SETUP_MODES = ["simple", "advanced"] as const;
export const INFRASTRUCTURE_CONNECTION_STATUSES = [
  "pending",
  "checking",
  "ready",
  "error",
  "disabled",
] as const;
export const HETZNER_CLOUD_CONNECTION_ERROR_CODES = [
  "invalid_credentials",
  "provider_unavailable",
  "provider_response_invalid",
] as const;
/** Provider-API failures for a DigitalOcean Managed Agents connection. These
 * never share the Proxmox preflight vocabulary. */
export const DIGITALOCEAN_CONNECTION_ERROR_CODES = [
  "invalid_credentials",
  "managed_agents_forbidden",
  "provider_unavailable",
  "provider_response_invalid",
] as const;
/** Reviewed Hivra relay for DigitalOcean harness sessions. Bumping it retires
 * every published target until the connection is re-validated. */
export const DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION = "2026.09.23.1" as const;
/** DigitalOcean adapters Hivra can drive today, keyed to catalog agent ids. */
export const DIGITALOCEAN_HARNESSES = ["claude-code", "codex", "hermes"] as const;
/** Sandbox sizes accepted by the harness runtime (environment-spec reference). */
export const DIGITALOCEAN_SANDBOX_SIZES = [
  "mars-1vcpu-1gb",
  "mars-2vcpu-2gb",
  "mars-2vcpu-4gb",
  "mars-4vcpu-8gb",
  "mars-16vcpu-32gb",
] as const;
export const DIGITALOCEAN_CONNECTION_CAPABILITIES = {
  inventory: false,
  offerCatalog: false,
  createCapacity: false,
  agentLaunch: true,
  reason:
    "DigitalOcean runs each agent in its own managed session. Sessions bill your DigitalOcean account while they run.",
} as const;
const HETZNER_CLOUD_CAPACITY_ERROR_CODES = [
  "selection_invalid",
  "quote_expired",
  "quote_changed",
  "connection_changed",
  "idempotency_conflict",
  "canary_capacity_limit",
  "quote_rate_limited",
  "credential_reconnect_required",
  "invalid_credentials",
  "token_read_only",
  "provider_forbidden",
  "provider_resource_limit",
  "provider_maintenance",
  "provider_rate_limited",
  "provider_conflict",
  "provider_unavailable",
  "provider_response_invalid",
  "provider_action_failed",
  "access_setup_failed",
] as const;
const HETZNER_CLOUD_CAPACITY_OPERATION_STATUSES = [
  "creating",
  "created_off",
  "ambiguous",
  "provider_rejected",
  "cleaning",
  "deleted",
  "cleanup_abandoned",
] as const;
export const HETZNER_CLOUD_SPENDING_CONFIRMATION =
  "Create server and start billing" as const;
export const HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION =
  "FORGET HIVRA ACCESS AND KEEP PROVIDER RESOURCES" as const;
export const HETZNER_CLOUD_FIREWALL_LIMITATION =
  "Hivra does not request or manage a provider firewall in this canary milestone. An existing Hetzner label-selector or project policy may still attach one. The host firewall is applied by cloud-init on first boot, so there is a boot-time gap." as const;
export const HETZNER_CLOUD_BILLING_SEMANTICS = {
  model: "hourly-with-monthly-cap",
  partialHoursRoundedUp: true,
  poweredOffStillBilled: true,
  primaryIpLifecycle:
    "Primary IPs are separate resources; any non-zero provider price is billed while the IP exists. Verify or delete retained IPs after deleting the server.",
  trafficOverage:
    "Included traffic is fixed by the selected offer; additional outgoing traffic is variable usage billed separately.",
} as const;

/**
 * Canary simple mode intentionally exposes only modest shared-CPU machines.
 * The currency caps are conservative product guardrails, not provider price
 * claims; every purchase is still bound to a fresh provider quote.
 */
export const HETZNER_CLOUD_SIMPLE_MODE_POLICY = {
  cpuType: "shared",
  minCores: 2,
  minMemoryGb: 4,
  maxCores: 8,
  maxMemoryGb: 32,
  maxDiskGb: 320,
  maxMonthlyGrossByCurrency: [
    { currency: "EUR", amount: "45.00" },
    { currency: "USD", amount: "60.00" },
  ],
} as const;
const PROXMOX_ISOLATION_DRIVERS = ["proxmox-kvm"] as const;
const PROXMOX_ISOLATION_CLASSES = ["hardware-vm"] as const;

export const HETZNER_CLOUD_CONNECTION_CAPABILITIES = {
  inventory: true,
  offerCatalog: true,
  createCapacity: true,
  agentLaunch: false,
  reason:
    "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
} as const;

export const PROXMOX_PREFLIGHT_ERROR_CODES = [
  "INVALID_CONNECTION",
  "CONNECTION_NOT_FOUND",
  "HOST_RESOLUTION_FAILED",
  "HOST_ADDRESS_BLOCKED",
  "SSH_HOST_KEY_MISMATCH",
  "SSH_AUTHENTICATION_FAILED",
  "SSH_CONNECTION_FAILED",
  "SSH_COMMAND_FAILED",
  "PROXMOX_UNAVAILABLE",
  "PROXMOX_VERSION_UNSUPPORTED",
  "PROXMOX_PERMISSION_UNAVAILABLE",
  "NODE_UNAVAILABLE",
  "KVM_UNAVAILABLE",
  "BRIDGE_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "TEMPLATE_UNAVAILABLE",
  "PROVISIONER_UNAVAILABLE",
  "VMID_RANGE_UNAVAILABLE",
  "CAPACITY_UNAVAILABLE",
  "PREFLIGHT_SUPERSEDED",
  "PREFLIGHT_INTERNAL_ERROR",
] as const;

export const MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES = 65_536;
export const MAX_PROXMOX_VMID_RANGE_SIZE = 10_000;

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const UuidSchema = z.string().uuid();
const SafeMessageSchema = z.string().trim().min(1).max(500);

const ConnectionNameSchema = z
  .string()
  .trim()
  .min(1, "Connection name is required")
  .max(80, "Connection name must be 80 characters or fewer")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Connection name cannot contain control characters",
  });

const ProxmoxIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Use only letters, numbers, dots, underscores, and hyphens",
  );

// Linux interface names are bounded by IFNAMSIZ (16 bytes including NUL).
// Keep the stored override within the same limit enforced by the host probe.
const ProxmoxBridgeSchema = z
  .string()
  .trim()
  .min(1)
  .max(15)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Bridge name contains unsupported characters");

const ProvisionerVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    "Provisioner version contains unsupported characters",
  );

const PortableHivraCatalogRuntimeIdSchema = z.enum(
  PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS,
);

/**
 * Versioned, secret-free proof of which catalog runtimes an observed
 * provisioner bundle can install. The record is deliberately strict: unknown
 * fields, runtime ids, duplicates, or contract versions are not authority.
 */
export const PortableHivraRuntimeCompatibilitySchema = z
  .object({
    contractVersion: z.literal(
      PORTABLE_HIVRA_RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    ),
    provisionerVersion: ProvisionerVersionSchema,
    supportedCatalogRuntimeIds: z
      .array(PortableHivraCatalogRuntimeIdSchema)
      .max(PORTABLE_HIVRA_SUPPORTED_CATALOG_RUNTIME_IDS.length)
      .refine(
        (values) => new Set(values).size === values.length,
        "Supported catalog runtime ids must be unique",
      ),
    supportedHostCapabilities: z.array(z.literal("windows-installer")).max(1).optional(),
  })
  .strict();

const ProvisionerDirectorySchema = z
  .string()
  .trim()
  .min(2)
  .max(256)
  .regex(/^\/(?:[A-Za-z0-9._-]+\/?)+$/, "Use an absolute directory without spaces")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Provisioner directory cannot traverse parent directories",
  );

function isValidIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  if (!/^[A-Fa-f0-9:]+$/.test(value) || !value.includes(":")) return false;
  const compressionParts = value.split("::");
  if (compressionParts.length > 2) return false;

  const groups = compressionParts.flatMap((part) => (part ? part.split(":") : []));
  if (!groups.every((group) => /^[A-Fa-f0-9]{1,4}$/.test(group))) return false;

  if (compressionParts.length === 1) return groups.length === 8;
  return groups.length < 8;
}

function isValidDnsName(value: string): boolean {
  if (value.length > 253 || value.endsWith(".")) return false;
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

function isValidSshHost(value: string): boolean {
  if (!value || /[\s/@\[\]]/.test(value) || value.includes("://")) return false;
  if (value.includes(":")) return isValidIpv6(value);
  if (/^[0-9.]+$/.test(value)) return isValidIpv4(value);
  return isValidDnsName(value);
}

function isSha256Fingerprint(value: string): boolean {
  const trimmed = value.trim();
  // A SHA-256 digest is 32 bytes. Its unpadded Base64 form is 43 chars and,
  // because two bytes remain in the final quantum, the last index must be a
  // multiple of four. Keep this browser-safe rather than depending on Buffer.
  const canonicalBase64 =
    /^(?:SHA256|sha256):[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=?$/;
  const compactHex = /^[A-Fa-f0-9]{64}$/;
  const colonHex = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
  return canonicalBase64.test(trimmed) || compactHex.test(trimmed) || colonHex.test(trimmed);
}

function isSupportedPrivateKey(value: string): boolean {
  const trimmed = value.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const label = firstLine.match(/^-----BEGIN (.+)-----$/)?.[1];
  if (!label) return false;
  if (!["OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY", "PRIVATE KEY"].includes(label)) {
    return false;
  }
  return trimmed.endsWith(`-----END ${label}-----`);
}

export const ProxmoxSshHostSchema = z
  .string()
  .trim()
  .min(1, "SSH host is required")
  .max(253)
  .refine(isValidSshHost, "Enter a hostname, IPv4 address, or IPv6 address without a URL or port");

export const ProxmoxSshHostFingerprintSchema = z
  .string()
  .trim()
  .refine(isSha256Fingerprint, {
    message: "Use an OpenSSH SHA256: fingerprint or a 32-byte hexadecimal SHA-256 digest",
  });

const ProxmoxSshPrivateKeySchema = z
  .string()
  .min(64, "SSH private key is incomplete")
  .max(
    MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES,
    `SSH private key must be ${MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES} bytes or fewer`,
  )
  .refine(isSupportedPrivateKey, "Use an OpenSSH, RSA, EC, DSA, or PKCS#8 private key");

const ProxmoxVmidSchema = z.number().int().min(100).max(999_999_999);

const ProxmoxVmidRangeObjectSchema = z
  .object({
    start: ProxmoxVmidSchema,
    end: ProxmoxVmidSchema,
  })
  .strict();

function validateVmidRange(
  range: { start: number; end: number },
  context: z.RefinementCtx,
): void {
    if (range.end < range.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "VMID range end must be greater than or equal to its start",
      });
      return;
    }
    if (range.end - range.start + 1 > MAX_PROXMOX_VMID_RANGE_SIZE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: `VMID range cannot contain more than ${MAX_PROXMOX_VMID_RANGE_SIZE} IDs`,
      });
    }
}

export const ProxmoxVmidRangeSchema =
  ProxmoxVmidRangeObjectSchema.superRefine(validateVmidRange);

const ProxmoxSshEndpointSchema = z
  .object({
    sshHost: ProxmoxSshHostSchema,
    sshPort: z.number().int().min(1).max(65_535),
    sshUser: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "SSH user contains unsupported characters"),
    sshHostFingerprintSha256: ProxmoxSshHostFingerprintSchema,
  })
  .strict();

export const ProxmoxHostCapacityPolicySchema = z
  .object({
    mode: z.enum(["observe", "enforce"]),
    hostMemoryReserveMb: z.number().int().min(512).max(1_048_576),
    cpuCeilingDensity: z.number().min(1).max(4).multipleOf(0.25),
    memoryCeilingDensity: z.number().min(1).max(4).multipleOf(0.25),
  })
  .strict();

export const ProxmoxAdvancedConfigurationSchema = z
  .object({
    node: ProxmoxIdentifierSchema.optional(),
    bridge: ProxmoxBridgeSchema.optional(),
    storage: ProxmoxIdentifierSchema.optional(),
    template: z
      .object({
        vmid: ProxmoxVmidSchema,
        expectedName: ProxmoxIdentifierSchema.optional(),
      })
      .strict()
      .optional(),
    provisioner: z
      .object({
        directory: ProvisionerDirectorySchema,
        expectedVersion: ProvisionerVersionSchema,
      })
      .strict()
      .optional(),
    vmidRange: ProxmoxVmidRangeSchema.optional(),
    capacityPolicy: ProxmoxHostCapacityPolicySchema.optional(),
  })
  .strict();

export const ProxmoxConnectionCredentialsSchema = z
  .object({
    sshPrivateKey: ProxmoxSshPrivateKeySchema,
  })
  .strict();

const ProxmoxConnectionCreateObjectSchema = z
  .object({
    name: ConnectionNameSchema,
    provider: z.literal("proxmox"),
    operatingMode: z.literal("self-managed"),
    setupMode: z.enum(INFRASTRUCTURE_SETUP_MODES),
    endpoint: ProxmoxSshEndpointSchema,
    configuration: ProxmoxAdvancedConfigurationSchema.optional(),
    credentials: ProxmoxConnectionCredentialsSchema,
  })
  .strict();

export const ProxmoxConnectionCreateSchema = ProxmoxConnectionCreateObjectSchema.superRefine(
  (value, context) => {
    const simplePlacementOverrides = value.configuration
      ? Object.keys(value.configuration).filter((key) => key !== "capacityPolicy")
      : [];
    if (value.setupMode === "simple" && simplePlacementOverrides.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["configuration"],
        message: "Simple mode detects placement settings automatically",
      });
    }
  },
);

export const HostConnectionCreateSchema = z
  .object({
    name: ConnectionNameSchema,
    provider: z.literal("host"),
    operatingMode: z.literal("self-managed"),
    // A generic host has no truthful advanced placement fields until discovery
    // identifies an installed and supported substrate.
    setupMode: z.literal("simple"),
    endpoint: ProxmoxSshEndpointSchema,
    credentials: ProxmoxConnectionCredentialsSchema,
  })
  .strict();

const HetznerCloudApiTokenSchema = z
  .string()
  .trim()
  .min(20, "Hetzner Cloud API token is incomplete")
  .max(512, "Hetzner Cloud API token is too long")
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), {
    message: "Hetzner Cloud API token cannot contain whitespace or control characters",
  });

export const HetznerCloudConnectionCreateSchema = z
  .object({
    name: ConnectionNameSchema,
    provider: z.literal("hetzner-cloud"),
    operatingMode: z.literal("self-managed"),
    setupMode: z.literal("simple"),
    credentials: z
      .object({
        apiToken: HetznerCloudApiTokenSchema,
      })
      .strict(),
  })
  .strict();

const DigitalOceanApiTokenSchema = z
  .string()
  .trim()
  .min(20, "DigitalOcean API token is incomplete")
  .max(512, "DigitalOcean API token is too long")
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), {
    message: "DigitalOcean API token cannot contain whitespace or control characters",
  });

const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, { message: "Choose a real date" });

/** What the owner tells Hivra about when a provider token stops working.
 * DigitalOcean does not report a personal access token's expiry through the
 * API, so this is the owner's declaration, never provider evidence. */
export const ProviderTokenExpiryInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("date"), date: CalendarDateSchema }).strict(),
]);

export const CredentialExpiryDtoSchema = z
  .object({
    source: z.literal("owner-declared"),
    noExpiry: z.boolean(),
    expiresOn: CalendarDateSchema.nullable(),
    declaredAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((value) => value.noExpiry === (value.expiresOn === null), {
    message: "Token expiry is inconsistent",
  });

export const DigitalOceanConnectionCreateSchema = z
  .object({
    name: ConnectionNameSchema,
    provider: z.literal("digitalocean"),
    operatingMode: z.literal("self-managed"),
    setupMode: z.literal("simple"),
    credentials: z
      .object({
        apiToken: DigitalOceanApiTokenSchema,
      })
      .strict(),
    tokenExpiry: ProviderTokenExpiryInputSchema.optional(),
  })
  .strict();

export const InfrastructureConnectionCreateSchema = z.union([
  HostConnectionCreateSchema,
  ProxmoxConnectionCreateSchema,
  HetznerCloudConnectionCreateSchema,
  DigitalOceanConnectionCreateSchema,
]);

const ProxmoxConnectionUpdateObjectSchema = z
  .object({
    name: ConnectionNameSchema.optional(),
    setupMode: z.enum(INFRASTRUCTURE_SETUP_MODES).optional(),
    endpoint: ProxmoxSshEndpointSchema.optional(),
    configuration: ProxmoxAdvancedConfigurationSchema.nullable().optional(),
    credentials: ProxmoxConnectionCredentialsSchema.optional(),
  })
  .strict();

export const ProxmoxConnectionUpdateSchema = ProxmoxConnectionUpdateObjectSchema.superRefine(
  (value, context) => {
    if (!Object.values(value).some((entry) => entry !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one connection field must be updated",
      });
    }
    const simplePlacementOverrides = value.configuration
      ? Object.keys(value.configuration).filter((key) => key !== "capacityPolicy")
      : [];
    if (value.setupMode === "simple" && simplePlacementOverrides.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["configuration"],
        message: "Simple mode detects placement settings automatically; use null to clear overrides",
      });
    }
  },
);

export const ProxmoxPreflightErrorCodeSchema = z.enum(PROXMOX_PREFLIGHT_ERROR_CODES);

const InfrastructureConnectionDtoCommonFields = {
  id: UuidSchema,
  name: ConnectionNameSchema,
  operatingMode: z.literal("self-managed"),
  status: z.enum(INFRASTRUCTURE_CONNECTION_STATUSES),
  credentialsConfigured: z.boolean(),
  lastCheckedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

const SshInfrastructureConnectionDtoFields = {
  ...InfrastructureConnectionDtoCommonFields,
  setupMode: z.enum(INFRASTRUCTURE_SETUP_MODES),
  endpoint: ProxmoxSshEndpointSchema,
  configuration: ProxmoxAdvancedConfigurationSchema.nullable(),
  lastErrorCode: ProxmoxPreflightErrorCodeSchema.nullable(),
};

const HetznerCloudConnectionCapabilitiesSchema = z
  .object({
    inventory: z.literal(true),
    offerCatalog: z.literal(true),
    createCapacity: z.literal(true),
    agentLaunch: z.literal(false),
    reason: SafeMessageSchema,
  })
  .strict();

/**
 * Provider-discriminated, secret-free infrastructure connection read model.
 * Hetzner Cloud credentials bind a project API, not an SSH endpoint. Keeping
 * its endpoint null prevents fake SSH values from becoming accidental launch
 * authority in host and Proxmox code paths.
 */
export const InfrastructureConnectionDtoSchema = z.discriminatedUnion("provider", [
  z
    .object({
      ...SshInfrastructureConnectionDtoFields,
      provider: z.literal("proxmox"),
    })
    .strict(),
  z
    .object({
      ...SshInfrastructureConnectionDtoFields,
      provider: z.literal("host"),
    })
    .strict(),
  z
    .object({
      ...InfrastructureConnectionDtoCommonFields,
      provider: z.literal("hetzner-cloud"),
      setupMode: z.literal("simple"),
      endpoint: z.null(),
      configuration: z.null(),
      capabilities: HetznerCloudConnectionCapabilitiesSchema,
      // Provider observations use their own error vocabulary. They must never
      // be cast into Proxmox readiness failures, but a failed refresh still has
      // to remain visible after the browser reloads.
      lastErrorCode: z.enum(HETZNER_CLOUD_CONNECTION_ERROR_CODES).nullable(),
    })
    .strict(),
  z
    .object({
      ...InfrastructureConnectionDtoCommonFields,
      provider: z.literal("digitalocean"),
      setupMode: z.literal("simple"),
      endpoint: z.null(),
      configuration: z.null(),
      capabilities: z
        .object({
          inventory: z.literal(false),
          offerCatalog: z.literal(false),
          createCapacity: z.literal(false),
          agentLaunch: z.literal(true),
          reason: SafeMessageSchema,
        })
        .strict(),
      lastErrorCode: z.enum(DIGITALOCEAN_CONNECTION_ERROR_CODES).nullable(),
      /** Owner-declared token expiry; absent when never recorded. */
      credentialExpiry: CredentialExpiryDtoSchema.nullable().optional(),
    })
    .strict(),
]);

const HetznerCloudServerStatusSchema = z.enum([
  "running",
  "off",
  "initializing",
  "starting",
  "stopping",
  "deleting",
  "rebuilding",
  "migrating",
  "unknown",
]);

const HetznerArchitectureSchema = z.enum(["x86", "arm"]);
const HetznerIpv6NetworkSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => {
    const [address, prefix, ...rest] = value.split("/");
    if (rest.length > 0 || !isValidIpv6(address)) return false;
    if (prefix === undefined) return true;
    return /^\d{1,3}$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= 128;
  }, "Expected an IPv6 address or CIDR network");

export const HetznerCloudServerInventoryDtoSchema = z
  .object({
    id: UuidSchema,
    connectionId: UuidSchema,
    providerResourceId: z.string().regex(/^[1-9]\d*$/),
    name: z.string().trim().min(1).max(128),
    status: HetznerCloudServerStatusSchema,
    serverType: z
      .object({
        name: z.string().trim().min(1).max(64),
        description: z.string().trim().min(1).max(128).nullable(),
        cores: z.number().int().positive().max(1_024),
        memoryGb: z.number().positive().max(65_536),
        diskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        cpuType: z.enum(["shared", "dedicated"]).nullable(),
        architecture: HetznerArchitectureSchema.nullable(),
      })
      .strict(),
    location: z
      .object({
        name: z.string().trim().min(1).max(64),
        city: z.string().trim().min(1).max(128).nullable(),
        country: z.string().trim().length(2).nullable(),
      })
      .strict(),
    publicNetwork: z
      .object({
        ipv4: z.string().ip({ version: "v4" }).nullable(),
        ipv6: HetznerIpv6NetworkSchema.nullable(),
      })
      .strict(),
    providerCreatedAt: IsoDateTimeSchema,
    discoveredAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    launchReady: z.literal(false),
    launchBlockedReason: SafeMessageSchema,
  })
  .strict();

const HetznerMoneySchema = z
  .object({
    currency: z.string().trim().length(3),
    net: z.string().regex(/^\d+(?:\.\d+)?$/),
    gross: z.string().regex(/^\d+(?:\.\d+)?$/),
  })
  .strict();

const HetznerAmountSchema = z
  .object({
    net: z.string().regex(/^\d+(?:\.\d+)?$/),
    gross: z.string().regex(/^\d+(?:\.\d+)?$/),
  })
  .strict();

const HetznerCapacityPriceComponentSchema = z
  .object({
    hourly: HetznerAmountSchema,
    monthly: HetznerAmountSchema,
  })
  .strict();

const HetznerSimpleModePolicySchema = z
  .object({
    cpuType: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.cpuType),
    minCores: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.minCores),
    minMemoryGb: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.minMemoryGb),
    maxCores: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxCores),
    maxMemoryGb: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMemoryGb),
    maxDiskGb: z.literal(HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxDiskGb),
    maxMonthlyGrossByCurrency: z.tuple([
      z
        .object({ currency: z.literal("EUR"), amount: z.literal("45.00") })
        .strict(),
      z
        // Retain parsing of historical quotes; new admission uses current policy.
        .object({ currency: z.literal("USD"), amount: z.enum(["50.00", "60.00"]) })
        .strict(),
    ]),
  })
  .strict();

const HetznerBillingSemanticsSchema = z
  .object({
    model: z.literal(HETZNER_CLOUD_BILLING_SEMANTICS.model),
    partialHoursRoundedUp: z.literal(true),
    poweredOffStillBilled: z.literal(true),
    primaryIpLifecycle: z.literal(
      HETZNER_CLOUD_BILLING_SEMANTICS.primaryIpLifecycle,
    ),
    trafficOverage: z.literal(HETZNER_CLOUD_BILLING_SEMANTICS.trafficOverage),
  })
  .strict();

export const HetznerCloudOfferCatalogDtoSchema = z
  .object({
    fetchedAt: IsoDateTimeSchema,
    currency: z.string().trim().length(3),
    vatRate: z.string().regex(/^\d+(?:\.\d+)?$/),
    serverTypes: z.array(
      z
        .object({
          id: z.number().int().positive(),
          name: z.string().trim().min(1).max(64),
          description: z.string().trim().min(1).max(128).nullable(),
          cores: z.number().int().positive().max(1_024),
          memoryGb: z.number().positive().max(65_536),
          diskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          cpuType: z.enum(["shared", "dedicated"]).nullable(),
          architecture: HetznerArchitectureSchema.nullable(),
          deprecated: z.boolean(),
          locations: z.array(
            z
              .object({
                name: z.string().trim().min(1).max(64),
                available: z.boolean(),
                recommended: z.boolean(),
                deprecated: z.boolean(),
              })
              .strict(),
          ),
          prices: z.array(
            z
              .object({
                location: z.string().trim().min(1).max(64),
                monthly: HetznerMoneySchema,
                hourly: HetznerMoneySchema,
                includedTrafficBytes: z.number().int().nonnegative(),
                additionalTrafficPerTb: HetznerMoneySchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    locations: z.array(
      z
        .object({
          id: z.number().int().positive(),
          name: z.string().trim().min(1).max(64),
          city: z.string().trim().min(1).max(128),
          country: z.string().trim().length(2),
          networkZone: z.string().trim().min(1).max(64),
        })
        .strict(),
    ),
    primaryIpPrices: z.array(
      z
        .object({
          location: z.string().trim().min(1).max(64),
          ipv4: HetznerCapacityPriceComponentSchema,
          ipv6: HetznerCapacityPriceComponentSchema,
        })
        .strict(),
    ),
    images: z.array(
      z
        .object({
          id: z.number().int().positive(),
          type: z.literal("system"),
          name: z.string().trim().min(1).max(128),
          description: z.string().trim().min(1).max(256),
          architecture: HetznerArchitectureSchema,
          osFlavor: z.string().trim().min(1).max(64),
          osVersion: z.string().trim().min(1).max(64).nullable(),
          deprecated: z.boolean(),
        })
        .strict(),
    ),
    simpleModePolicy: HetznerSimpleModePolicySchema,
    billing: HetznerBillingSemanticsSchema,
    capabilities: HetznerCloudConnectionCapabilitiesSchema,
  })
  .strict();

const HetznerCloudServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use a lowercase RFC 1123 hostname with letters, numbers, and hyphens",
  );

export const HetznerCloudCapacityQuoteRequestSchema = z
  .object({
    serverTypeId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    imageId: z.number().int().positive(),
  })
  .strict();

export const HetznerCloudCapacityQuoteDtoSchema = z
  .object({
    id: UuidSchema,
    connectionId: UuidSchema,
    connectionRevision: z.number().int().positive(),
    serverName: HetznerCloudServerNameSchema,
    serverType: z
      .object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(64),
        description: z.string().trim().min(1).max(128).nullable(),
        architecture: HetznerArchitectureSchema,
        cores: z.number().int().positive().max(1_024),
        memoryGb: z.number().positive().max(65_536),
        diskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    location: z
      .object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(64),
        city: z.string().trim().min(1).max(128),
        country: z.string().trim().length(2),
      })
      .strict(),
    image: z
      .object({
        id: z.number().int().positive(),
        type: z.literal("system"),
        name: z.string().trim().min(1).max(128),
        description: z.string().trim().min(1).max(256),
        architecture: HetznerArchitectureSchema,
        osFlavor: z.literal("ubuntu"),
        osVersion: z.string().trim().min(1).max(64).nullable(),
      })
      .strict(),
    price: z
      .object({
        currency: z.string().trim().length(3),
        vatRate: z.string().regex(/^\d+(?:\.\d+)?$/),
        server: HetznerCapacityPriceComponentSchema,
        primaryIpv4: HetznerCapacityPriceComponentSchema,
        primaryIpv6: HetznerCapacityPriceComponentSchema,
        total: HetznerCapacityPriceComponentSchema,
        traffic: z
          .object({
            includedBytes: z.number().int().nonnegative(),
            additionalPerTb: HetznerAmountSchema,
          })
          .strict(),
      })
      .strict(),
    publicNetwork: z
      .object({ ipv4: z.literal(true), ipv6: z.literal(true) })
      .strict(),
    backups: z.literal(false),
    volumes: z.array(z.never()).length(0),
    startAfterCreate: z.literal(false),
    simpleModePolicy: HetznerSimpleModePolicySchema,
    billing: HetznerBillingSemanticsSchema,
    access: z
      .object({
        username: z.literal("hivra"),
        method: z.literal("generated-ed25519"),
        inboundTcpPortsAfterFirstBoot: z.tuple([z.literal(22)]),
        passwordAuthentication: z.literal(false),
        rootSshLogin: z.literal(false),
        providerFirewallAttached: z.literal(false),
        firewallLimitation: z.literal(HETZNER_CLOUD_FIREWALL_LIMITATION),
      })
      .strict(),
    fetchedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    spendingConfirmation: z.literal(HETZNER_CLOUD_SPENDING_CONFIRMATION),
  })
  .strict();

export const HetznerCloudCapacityCreateRequestSchema = z
  .object({
    quoteId: UuidSchema,
    idempotencyKey: UuidSchema,
    spendingConfirmation: z.literal(HETZNER_CLOUD_SPENDING_CONFIRMATION),
  })
  .strict();

export const HetznerCloudForceForgetRequestSchema = z
  .object({
    confirmation: z.literal(HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION),
  })
  .strict();

export const HetznerCloudForceForgetResultSchema = z
  .object({
    connectionDeleted: z.literal(true),
    localCredentialsWiped: z.literal(true),
    providerCleanupPerformed: z.literal(false),
    canarySlotHeld: z.literal(true),
  })
  .strict();

export const HetznerCloudCapacityOperationDtoSchema = z
  .object({
    id: UuidSchema,
    connectionId: UuidSchema,
    idempotencyKey: UuidSchema,
    status: z.enum(HETZNER_CLOUD_CAPACITY_OPERATION_STATUSES),
    providerServerId: z.string().regex(/^[1-9]\d*$/).nullable(),
    providerActionId: z.string().regex(/^[1-9]\d*$/).nullable(),
    providerActionCommand: z.string().trim().min(1).max(64).nullable(),
    providerActionStatus: z.enum(["running", "success", "error"]).nullable(),
    providerNextActions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[1-9]\d*$/),
            command: z.string().trim().min(1).max(64),
            status: z.enum(["running", "success", "error"]),
          })
          .strict(),
      )
      .max(8),
    observedServerStatus: HetznerCloudServerStatusSchema.nullable(),
    providerObservedAt: IsoDateTimeSchema.nullable(),
    errorCode: z.enum(HETZNER_CLOUD_CAPACITY_ERROR_CODES).nullable(),
    canarySlotHeld: z.boolean(),
    externalCleanupResolutionId: UuidSchema.nullable().optional(),
    replayed: z.boolean(),
    quote: HetznerCloudCapacityQuoteDtoSchema,
    createdPoweredOff: z.boolean(),
    launchReady: z.literal(false),
    launchBlockedReason: SafeMessageSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.externalCleanupResolutionId && (operation.status !== "ambiguous" || operation.canarySlotHeld)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "External cleanup preserves ambiguity and releases only its original claim" });
    }
    const completed = operation.status === "created_off";
    if (
      operation.createdPoweredOff !== completed
      || (completed && operation.providerActionStatus !== "success")
      || (completed && operation.observedServerStatus !== "off")
      || (completed && operation.providerObservedAt === null)
      || (completed && operation.providerServerId === null)
      || (completed && operation.providerActionId === null)
      || (completed && operation.providerActionCommand !== "create_server")
      || (
        completed
        && operation.providerNextActions.some((action) => action.status !== "success")
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Created capacity requires a successful action and observed powered-off server",
      });
    }
  });

function availableCapacitySchema(unitLabel: string) {
  return z
    .object({
      total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      available: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .refine((value) => value.available <= value.total, {
      path: ["available"],
      message: `Available ${unitLabel} cannot exceed total ${unitLabel}`,
    });
}

const UniqueProxmoxIdentifiersSchema = z
  .array(ProxmoxIdentifierSchema)
  .max(256)
  .refine((values) => new Set(values).size === values.length, "Values must be unique");

const ProxmoxHostCapacityEvidenceSchema = z.object({
  mode: z.enum(["observe", "enforce"]),
  hostMemoryReserveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cpuCeilingDensity: z.number().min(1).max(4),
  memoryCeilingDensity: z.number().min(1).max(4),
  activeFloorMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeCeilingMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeCeilingCpu: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  floorMemoryHeadroomBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ceilingMemoryHeadroomBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ceilingCpuHeadroom: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const ProxmoxPreflightCapacitySchema = z
  .object({
    cpu: z
      .object({
        totalCores: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        utilizationRatio: z.number().min(0).max(1),
      })
      .strict(),
    memoryBytes: availableCapacitySchema("memory"),
    storageBytes: availableCapacitySchema("storage"),
    policy: ProxmoxHostCapacityEvidenceSchema.optional(),
  })
  .strict();

const ProxmoxPreflightCapabilitiesSchema = z
  .object({
    isolationDrivers: z
      .array(z.enum(PROXMOX_ISOLATION_DRIVERS))
      .min(1)
      .max(PROXMOX_ISOLATION_DRIVERS.length)
      .refine((values) => new Set(values).size === values.length, "Isolation drivers must be unique"),
    isolationClass: z.literal("hardware-vm"),
    kvmAvailable: z.literal(true),
    bridges: z
      .array(ProxmoxBridgeSchema)
      .max(256)
      .refine((values) => new Set(values).size === values.length, "Values must be unique"),
    storages: UniqueProxmoxIdentifiersSchema,
    template: z
      .object({
        vmid: ProxmoxVmidSchema,
        ready: z.boolean(),
      })
      .strict()
      .nullable(),
    provisioner: z
      .object({
        ready: z.boolean(),
        version: ProvisionerVersionSchema.nullable(),
      })
      .strict()
      .nullable(),
    runtimeCompatibility: PortableHivraRuntimeCompatibilitySchema.nullable(),
    vmidRange: ProxmoxVmidRangeObjectSchema.extend({
      freeCount: z.number().int().nonnegative().max(MAX_PROXMOX_VMID_RANGE_SIZE),
    })
      .strict()
      .superRefine((range, context) => {
        validateVmidRange(range, context);
        const rangeSize = range.end - range.start + 1;
        if (rangeSize >= 0 && range.freeCount > rangeSize) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["freeCount"],
            message: "Free VMID count cannot exceed the configured range",
          });
        }
      }),
  })
  .strict();

const NullableCapacityValueSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

const NullableAvailableCapacitySchema = z
  .object({
    total: NullableCapacityValueSchema,
    available: NullableCapacityValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.total !== null && value.available !== null && value.available > value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["available"],
        message: "Available capacity cannot exceed total capacity",
      });
    }
  });

const DeploymentTargetEvidenceFields = {
  externalId: ProxmoxIdentifierSchema,
  displayName: z.string().trim().min(1).max(128),
  capacity: z
    .object({
      cpu: z
        .object({
          totalCores: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
          utilizationRatio: z.number().min(0).max(1).nullable(),
        })
        .strict(),
      memoryBytes: NullableAvailableCapacitySchema,
      storageBytes: NullableAvailableCapacitySchema.nullable(),
      policy: ProxmoxHostCapacityEvidenceSchema.nullable().optional(),
    })
    .strict(),
  capabilities: z
    .object({
      proxmoxVersion: z.string().trim().min(1).max(64).nullable(),
      launchReady: z.boolean(),
      directRootAccess: z.boolean(),
      kvmAvailable: z.boolean(),
      bridges: z
        .array(ProxmoxBridgeSchema)
        .max(256)
        .refine((values) => new Set(values).size === values.length, "Values must be unique"),
      selectedBridge: ProxmoxBridgeSchema.nullable(),
      storages: UniqueProxmoxIdentifiersSchema,
      selectedStorage: ProxmoxIdentifierSchema.nullable(),
      template: z
        .object({
          vmid: ProxmoxVmidSchema,
          exists: z.boolean(),
          isTemplate: z.boolean(),
          nameMatches: z.boolean(),
          ready: z.boolean(),
        })
        .strict()
        .nullable(),
      provisioner: z
        .object({
          configured: z.boolean(),
          ready: z.boolean(),
          version: ProvisionerVersionSchema.nullable(),
        })
        .strict()
        .nullable(),
      runtimeCompatibility: PortableHivraRuntimeCompatibilitySchema.nullable(),
      vmidRange: ProxmoxVmidRangeObjectSchema.extend({
        freeCount: z.number().int().nonnegative().max(MAX_PROXMOX_VMID_RANGE_SIZE).nullable(),
        firstAvailable: ProxmoxVmidSchema.nullable(),
      })
        .strict()
        .superRefine((range, context) => {
          validateVmidRange(range, context);
          const rangeSize = range.end - range.start + 1;
          if (range.freeCount !== null && range.freeCount > rangeSize) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["freeCount"],
              message: "Free VMID count cannot exceed the configured range",
            });
          }
        }),
      issues: z
        .array(
          z
            .object({
              code: ProxmoxPreflightErrorCodeSchema,
              message: SafeMessageSchema,
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  supportedIsolationDrivers: z
    .array(z.enum(PROXMOX_ISOLATION_DRIVERS))
    .max(PROXMOX_ISOLATION_DRIVERS.length)
    .refine((values) => new Set(values).size === values.length, "Isolation drivers must be unique"),
  isolationClass: z.enum(PROXMOX_ISOLATION_CLASSES).nullable(),
  lastErrorCode: ProxmoxPreflightErrorCodeSchema.nullable(),
};

type DeploymentTargetClaim = {
  status: "ready" | "unavailable";
  capabilities: {
    launchReady: boolean;
    directRootAccess: boolean;
  };
  supportedIsolationDrivers: Array<(typeof PROXMOX_ISOLATION_DRIVERS)[number]>;
  isolationClass: (typeof PROXMOX_ISOLATION_CLASSES)[number] | null;
  lastErrorCode: ProxmoxPreflightErrorCode | null;
};

function validateDeploymentTargetClaim(
  value: DeploymentTargetClaim,
  context: z.RefinementCtx,
): void {
  if (value.isolationClass === null && value.supportedIsolationDrivers.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supportedIsolationDrivers"],
      message: "Isolation drivers require a proven isolation class",
    });
  }
  if (!value.capabilities.directRootAccess && value.isolationClass !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isolationClass"],
      message: "This direct-command adapter requires root proof before claiming isolation",
    });
  }
  if (value.status === "ready" && !value.capabilities.launchReady) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "A ready target must be launch-ready",
    });
  }
  if (value.status === "ready" && value.lastErrorCode !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lastErrorCode"],
      message: "A ready target cannot retain an error code",
    });
  }
}

/**
 * Sanitized persistence contract for both ready and discovered-but-unavailable
 * Proxmox nodes. This is deliberately distinct from the public success DTO:
 * failed proofs retain useful nullable evidence without claiming an isolation
 * boundary or casting raw probe output into a success shape.
 */
export const InfrastructurePreflightTargetEvidenceSchema = z
  .object({
    ...DeploymentTargetEvidenceFields,
    status: z.enum(["ready", "unavailable"]),
  })
  .strict()
  .superRefine(validateDeploymentTargetClaim);

/**
 * Owner-facing, secret-free read model for persisted target evidence. The
 * database row's user id remains an internal query predicate and is never
 * serialized. Raw preflight output and infrastructure credentials are not
 * part of this contract.
 */
export const ProxmoxDeploymentTargetDtoSchema = z
  .object({
    id: UuidSchema,
    connectionId: UuidSchema,
    evidenceConnectionRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    ...DeploymentTargetEvidenceFields,
    status: z.enum(["ready", "unavailable"]),
    lastPreflightAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine(validateDeploymentTargetClaim);

/** A provider computer is an exclusive VM, not a Proxmox node or a pool of
 * nested guests. Keeping a distinct shape makes accidental VMID/bridge-based
 * execution a type error. This contract alone does not publish launch authority.
 */
export const ProviderVmDeploymentTargetDtoSchema = z.object({
  id: UuidSchema,
  connectionId: UuidSchema,
  evidenceConnectionRevision: z.number().int().positive().safe(),
  externalId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value))),
  displayName: z.string().trim().min(1).max(128),
  status: z.enum(["ready", "unavailable"]),
  capacity: DeploymentTargetEvidenceFields.capacity,
  capabilities: z.object({
    kind: z.literal("provider-vm"),
    provider: z.literal("hetzner-cloud"),
    capacityOrderId: UuidSchema,
    enrollmentAttemptId: UuidSchema,
    hostIdentityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    allocation: z.literal("exclusive-computer"),
    launchReady: z.boolean(),
    provisioner: z.object({
      configured: z.literal(true),
      ready: z.boolean(),
      version: ProvisionerVersionSchema,
      bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
      scopeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    runtimeCompatibility: PortableHivraRuntimeCompatibilitySchema.nullable(),
  }).strict(),
  supportedIsolationDrivers: z.array(z.literal("provider-vm")).max(1),
  isolationClass: z.literal("provider-vm").nullable(),
  lastPreflightAt: IsoDateTimeSchema.nullable(),
  lastErrorCode: z.enum(["PROVIDER_ADAPTER_UNAVAILABLE", "PREFLIGHT_SUPERSEDED", "PROVIDER_COMPUTER_RETIRING"]).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((target, context) => {
  if ((target.supportedIsolationDrivers.length > 0) !== (target.isolationClass === "provider-vm")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["isolationClass"], message: "Provider VM isolation requires matching driver evidence" });
  }
  // A provider VM uses the exact reviewed guest bundle, not the Proxmox host
  // runtime ABI. Preparation alone does not admit it: the separate, lease-bound
  // admission must publish a coherent ready claim after all adapters exist.
  const ready = target.status === "ready";
  if (target.capabilities.runtimeCompatibility !== null
    || ready !== target.capabilities.launchReady || ready !== (target.lastErrorCode === null)
    || (ready && (!target.capabilities.provisioner.ready
      || !isCompatibleProviderVmProvisionerVersion(target.capabilities.provisioner.version)
      || target.isolationClass !== "provider-vm" || !target.lastPreflightAt
      || !target.capacity.cpu.totalCores || !target.capacity.memoryBytes.total
      || !target.capacity.memoryBytes.available || !target.capacity.storageBytes?.available))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Provider VM launch authority is incomplete" });
  }
});

/** A direct-host gVisor target launches Linux terminal workloads through the
 * reviewed runsc adapter. It is an application-kernel boundary and never
 * inherits VM, desktop, or Windows capability claims.
 */
export const GvisorDeploymentTargetDtoSchema = z.object({
  id: UuidSchema,
  connectionId: UuidSchema,
  evidenceConnectionRevision: z.number().int().positive().safe(),
  externalId: z.string().regex(/^gvisor-[0-9a-f]{24}$/),
  displayName: z.string().trim().min(1).max(128),
  status: z.enum(["ready", "unavailable"]),
  capacity: DeploymentTargetEvidenceFields.capacity,
  capabilities: z.object({
    kind: z.literal("gvisor"),
    launchReady: z.boolean(),
    hostIdentityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    adapter: z.object({
      version: z.literal("2026.09.15.1"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    runtime: z.object({
      path: z.literal("/usr/local/bin/runsc"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    runtimeCompatibility: z.object({
      contractVersion: z.literal(1),
      supportedWorkloadKinds: z.tuple([z.literal("linux-terminal")]),
    }).strict(),
    resourcePolicy: z.object({
      reservationEqualsMaximum: z.literal(true),
      aggregateAdmission: z.literal("serialized-host-headroom-v1"),
    }).strict(),
    access: z.object({
      terminal: z.literal("owner-gated-command-v1"),
      publicPorts: z.literal(false),
    }).strict(),
    desktop: z.literal(false),
    windows: z.literal(false),
  }).strict(),
  supportedIsolationDrivers: z.tuple([z.literal("gvisor-runsc")]),
  isolationClass: z.literal("application-kernel").nullable(),
  lastPreflightAt: IsoDateTimeSchema.nullable(),
  lastErrorCode: z.enum(["GVISOR_ADAPTER_UNAVAILABLE", "PREFLIGHT_SUPERSEDED"]).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((target, context) => {
  const ready = target.status === "ready";
  if (ready !== target.capabilities.launchReady
    || ready !== (target.lastErrorCode === null)
    || (ready && (target.isolationClass !== "application-kernel" || !target.lastPreflightAt))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "gVisor launch authority is incomplete",
    });
  }
});

/** A DigitalOcean target is the team's serverless Harness Runtime. Each launch
 * creates one provider-managed Firecracker microVM session. DigitalOcean
 * attests that boundary; Hivra did not measure it, hence `provider-microvm`.
 */
export const DigitalOceanDeploymentTargetDtoSchema = z.object({
  id: UuidSchema,
  connectionId: UuidSchema,
  evidenceConnectionRevision: z.number().int().positive().safe(),
  externalId: z.literal("do-harness-runtime"),
  displayName: z.string().trim().min(1).max(128),
  status: z.enum(["ready", "unavailable"]),
  capacity: z.object({
    model: z.literal("serverless-sessions"),
    sizes: z.array(z.object({
      slug: z.enum(DIGITALOCEAN_SANDBOX_SIZES),
      vcpus: z.number().int().nonnegative(),
      memoryMb: z.number().int().nonnegative(),
    }).strict()).max(DIGITALOCEAN_SANDBOX_SIZES.length),
  }).strict(),
  capabilities: z.object({
    kind: z.literal("digitalocean-managed-agents"),
    launchReady: z.boolean(),
    adapter: z.object({ version: z.literal(DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION) }).strict(),
    harnesses: z.array(z.enum(DIGITALOCEAN_HARNESSES)).max(DIGITALOCEAN_HARNESSES.length),
    sizes: z.array(z.enum(DIGITALOCEAN_SANDBOX_SIZES)).max(DIGITALOCEAN_SANDBOX_SIZES.length),
    access: z.object({
      chat: z.literal("hivra-relay-v1"),
      approvals: z.literal("hivra-relay-v1"),
      terminal: z.literal(false),
      publicPorts: z.literal(false),
    }).strict(),
    desktop: z.literal(false),
    windows: z.literal(false),
  }).strict(),
  supportedIsolationDrivers: z.tuple([z.literal("do-harness-microvm")]),
  isolationClass: z.literal("provider-microvm"),
  lastPreflightAt: IsoDateTimeSchema.nullable(),
  lastErrorCode: z.enum(DIGITALOCEAN_CONNECTION_ERROR_CODES).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((target, context) => {
  const ready = target.status === "ready";
  if (ready !== target.capabilities.launchReady || ready !== (target.lastErrorCode === null)
    || (ready && (!target.lastPreflightAt || target.capabilities.harnesses.length === 0
      || target.capabilities.sizes.length === 0))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "DigitalOcean launch authority is incomplete",
    });
  }
});

// DigitalOcean targets are deliberately not part of this union: the generic
// target list and launch journey admit host capacity only, and a serverless
// DigitalOcean target launches through its own session path.
export const DeploymentTargetDtoSchema = z.union([
  ProxmoxDeploymentTargetDtoSchema,
  ProviderVmDeploymentTargetDtoSchema,
  GvisorDeploymentTargetDtoSchema,
]);

export type ProxmoxDeploymentTargetDto = z.infer<typeof ProxmoxDeploymentTargetDtoSchema>;
export type ProviderVmDeploymentTargetDto = z.infer<typeof ProviderVmDeploymentTargetDtoSchema>;
export type GvisorDeploymentTargetDto = z.infer<typeof GvisorDeploymentTargetDtoSchema>;
export type DigitalOceanDeploymentTargetDto = z.infer<typeof DigitalOceanDeploymentTargetDtoSchema>;

export function isProxmoxDeploymentTarget(target: DeploymentTargetDto): target is ProxmoxDeploymentTargetDto {
  return !("kind" in target.capabilities);
}

export function isGvisorDeploymentTarget(target: DeploymentTargetDto): target is GvisorDeploymentTargetDto {
  return "kind" in target.capabilities && target.capabilities.kind === "gvisor";
}



const ProxmoxPreflightSuccessSchema = z
  .object({
    ok: z.literal(true),
    connectionId: UuidSchema,
    checkedAt: IsoDateTimeSchema,
    target: z
      .object({
        externalId: ProxmoxIdentifierSchema,
        displayName: z.string().trim().min(1).max(128),
        proxmoxVersion: z.string().trim().min(1).max(64),
        launchReady: z.boolean(),
        capacity: ProxmoxPreflightCapacitySchema,
        capabilities: ProxmoxPreflightCapabilitiesSchema,
      })
      .strict(),
    warnings: z.array(SafeMessageSchema).max(20),
    unmetRequirements: z
      .array(
        z
          .object({
            code: ProxmoxPreflightErrorCodeSchema,
            message: SafeMessageSchema,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const ProxmoxPreflightFailureSchema = z
  .object({
    ok: z.literal(false),
    connectionId: UuidSchema,
    checkedAt: IsoDateTimeSchema,
    error: z
      .object({
        code: ProxmoxPreflightErrorCodeSchema,
        message: SafeMessageSchema,
        remediation: SafeMessageSchema.optional(),
      })
      .strict(),
    unmetRequirements: z
      .array(
        z
          .object({
            code: ProxmoxPreflightErrorCodeSchema,
            message: SafeMessageSchema,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const ProxmoxPreflightResultSchema = z.discriminatedUnion("ok", [
  ProxmoxPreflightSuccessSchema,
  ProxmoxPreflightFailureSchema,
]);
export type InfrastructureConnectionStatus =
  (typeof INFRASTRUCTURE_CONNECTION_STATUSES)[number];
export type HetznerCloudConnectionErrorCode =
  (typeof HETZNER_CLOUD_CONNECTION_ERROR_CODES)[number];
export type HetznerCloudCapacityErrorCode =
  (typeof HETZNER_CLOUD_CAPACITY_ERROR_CODES)[number];
export type ProxmoxConnectionCreate = z.infer<typeof ProxmoxConnectionCreateSchema>;
export type HetznerCloudConnectionCreate = z.infer<
  typeof HetznerCloudConnectionCreateSchema
>;
export type InfrastructureConnectionCreate = z.infer<
  typeof InfrastructureConnectionCreateSchema
>;
export type ProxmoxConnectionUpdate = z.infer<typeof ProxmoxConnectionUpdateSchema>;
export type ProxmoxAdvancedConfiguration = z.infer<
  typeof ProxmoxAdvancedConfigurationSchema
>;
export type ProxmoxHostCapacityPolicy = z.infer<typeof ProxmoxHostCapacityPolicySchema>;
export type InfrastructureConnectionDto = z.infer<typeof InfrastructureConnectionDtoSchema>;
export type HetznerCloudConnectionDto = Extract<
  InfrastructureConnectionDto,
  { provider: "hetzner-cloud" }
>;
/** Connections whose credential is an SSH endpoint and key. Provider-API
 * connections (Hetzner, DigitalOcean) never reach SSH preflight or preparation. */
export type SshInfrastructureConnectionDto = Extract<
  InfrastructureConnectionDto,
  { provider: "proxmox" | "host" }
>;
export type SshInfrastructureConnectionCreate = Extract<
  InfrastructureConnectionCreate,
  { provider: "proxmox" | "host" }
>;
export function isProviderApiConnection(
  connection: { provider: InfrastructureConnectionDto["provider"] },
): connection is { provider: "hetzner-cloud" | "digitalocean" } {
  return connection.provider === "hetzner-cloud" || connection.provider === "digitalocean";
}
export type DigitalOceanConnectionDto = Extract<
  InfrastructureConnectionDto,
  { provider: "digitalocean" }
>;
export type DigitalOceanConnectionCreate = z.infer<typeof DigitalOceanConnectionCreateSchema>;
export type ProviderTokenExpiryInput = z.infer<typeof ProviderTokenExpiryInputSchema>;
export type CredentialExpiryDto = z.infer<typeof CredentialExpiryDtoSchema>;
export type DigitalOceanConnectionErrorCode = (typeof DIGITALOCEAN_CONNECTION_ERROR_CODES)[number];
export type DigitalOceanHarness = (typeof DIGITALOCEAN_HARNESSES)[number];
export type DigitalOceanSandboxSize = (typeof DIGITALOCEAN_SANDBOX_SIZES)[number];
export type HetznerCloudServerInventoryDto = z.infer<
  typeof HetznerCloudServerInventoryDtoSchema
>;
export type HetznerCloudOfferCatalogDto = z.infer<
  typeof HetznerCloudOfferCatalogDtoSchema
>;
export type HetznerCloudCapacityQuoteRequest = z.infer<
  typeof HetznerCloudCapacityQuoteRequestSchema
>;
export type HetznerCloudCapacityQuoteDto = z.infer<
  typeof HetznerCloudCapacityQuoteDtoSchema
>;
export type HetznerCloudCapacityCreateRequest = z.infer<
  typeof HetznerCloudCapacityCreateRequestSchema
>;
export type HetznerCloudCapacityOperationDto = z.infer<
  typeof HetznerCloudCapacityOperationDtoSchema
>;
export type HetznerCloudForceForgetRequest = z.infer<
  typeof HetznerCloudForceForgetRequestSchema
>;
export type HetznerCloudForceForgetResult = z.infer<
  typeof HetznerCloudForceForgetResultSchema
>;
export type DeploymentTargetDto = z.infer<typeof DeploymentTargetDtoSchema>;
export type ProxmoxPreflightErrorCode = z.infer<typeof ProxmoxPreflightErrorCodeSchema>;
export type InfrastructurePreflightTargetEvidence = z.infer<
  typeof InfrastructurePreflightTargetEvidenceSchema
>;
export type ProxmoxPreflightResult = z.infer<typeof ProxmoxPreflightResultSchema>;
