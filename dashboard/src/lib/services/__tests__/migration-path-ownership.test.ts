import {
  CreateInstanceSchema,
  InstanceService,
  isOwnedMigrationStoragePath,
} from "../instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    storage: { from: jest.fn() },
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/crypto", () => ({
  encryptApiKey: jest.fn((value: string) => `enc:${value}`),
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/codex-oauth", () => ({
  CODEX_DEFAULT_MODEL: "gpt-5.4",
  formatStoredProviderSecretPreview: jest.fn(() => "preview"),
  resolveCodexDeploymentSecret: jest.fn((apiKey: string) => ({ apiKey })),
}));

jest.mock("@/lib/nous-oauth", () => ({
  resolveNousDeploymentSecret: jest.fn((apiKey: string) => ({ apiKey })),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  provisionHetznerInstance: jest.fn(),
  getServerSpecs: jest.fn(() => ({ cpu: 2, ram: 4096 })),
  getHetznerInstanceStatus: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-host-guards", () => ({
  guardProxmoxHostPlacementReadiness: jest.fn(async () => ({ skip: false })),
  reportProxmoxVmidRangeUtilization: jest.fn(async () => "ok"),
  reportCorrelatedProxmoxHostFailure: jest.fn(async () => ({ correlated: false, hosts: [] })),
  reportProxmoxHostRegistryUnavailable: jest.fn(async () => undefined),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  DEFAULT_PROXMOX_VM_DISK_GB: 30,
  resolveProxmoxVmDiskGb: jest.fn(() => 30),
  provisionProxmoxInstance: jest.fn(),
  deleteProxmoxInstance: jest.fn(),
  getProxmoxTemplateAvailability: jest.fn(),
  getProxmoxVmidAvailability: jest.fn(),
  isProxmoxProvisioningConfigured: jest.fn(() => true),
  resolveProxmoxHostEnv: jest.fn((_host: unknown, env: NodeJS.ProcessEnv = process.env) => ({ ...env })),
  resolveProxmoxTargetConfiguration: jest.fn((env: NodeJS.ProcessEnv = process.env) => ({ id: null, env: { ...env } })),
  resolveProxmoxTargetCandidateIds: jest.fn(() => []),
  resolveProxmoxMaxTenantInstances: jest.fn(() => 15),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  createManagedVeniceProxyKey: jest.fn(),
}));

jest.mock("@/lib/venice/managed-endpoints", () => ({
  getManagedVeniceProxyBaseUrl: jest.fn(
    () => "https://hermesos.cloud/api/managed-venice/v1"
  ),
}));

jest.mock("@/lib/instance-record", () => ({
  buildInstanceInsertPayload: jest.fn((payload: Record<string, unknown>) => payload),
}));

jest.mock("@/lib/instance-settings", () => ({
  buildStoredInstanceConfig: jest.fn(() => ({})),
  extractGlobalHermesSettings: jest.fn(() => ({})),
  getAutoUpdateConfig: jest.fn(() => ({ enabled: true, time: "06:00" })),
}));

jest.mock("@/lib/subscription", () => ({
  getPlan: jest.fn(() => ({ name: "Operator", maxCpuPerAgent: 8, maxRamPerAgent: 16384 })),
}));

jest.mock("@/lib/models", () => ({
  normalizeModelValue: jest.fn((model: string) => model),
  PROVIDERS: [],
}));

const OWNER = "usr_owner_1";
const OTHER = "usr_other_2";
const ARCHIVE_NAME = "0123456789abcdef0123456789abcdef";
const OWNED_PATH = `migrations/${OWNER}/${ARCHIVE_NAME}.zip`;
const FOREIGN_PATH = `migrations/${OTHER}/${ARCHIVE_NAME}.zip`;

describe("isOwnedMigrationStoragePath", () => {
  it("accepts the caller's own upload-migration archive path", () => {
    expect(isOwnedMigrationStoragePath(OWNED_PATH, OWNER)).toBe(true);
  });

  it("rejects another tenant's migration archive", () => {
    expect(isOwnedMigrationStoragePath(FOREIGN_PATH, OWNER)).toBe(false);
    expect(isOwnedMigrationStoragePath(OWNED_PATH, OTHER)).toBe(false);
  });

  it("rejects path traversal inside the caller's own prefix", () => {
    expect(
      isOwnedMigrationStoragePath(
        `migrations/${OWNER}/../${OTHER}/${ARCHIVE_NAME}.zip`,
        OWNER
      )
    ).toBe(false);
    expect(
      isOwnedMigrationStoragePath(`migrations/../${ARCHIVE_NAME}.zip`, OWNER)
    ).toBe(false);
  });

  it("rejects non-zip archives and arbitrary bucket keys", () => {
    expect(
      isOwnedMigrationStoragePath(`migrations/${OWNER}/${ARCHIVE_NAME}.tar`, OWNER)
    ).toBe(false);
    expect(
      isOwnedMigrationStoragePath(`migrations/${OWNER}/${ARCHIVE_NAME}`, OWNER)
    ).toBe(false);
    expect(
      isOwnedMigrationStoragePath(`migrations/${OWNER}/archive.zip`, OWNER)
    ).toBe(false);
    expect(
      isOwnedMigrationStoragePath(`avatars/${OWNER}/${ARCHIVE_NAME}.zip`, OWNER)
    ).toBe(false);
    expect(
      isOwnedMigrationStoragePath(
        `migrations/${OWNER}/nested/${ARCHIVE_NAME}.zip`,
        OWNER
      )
    ).toBe(false);
  });

  it("rejects malformed object names and control characters", () => {
    // Upload writes lowercase hex only — uppercase must not pass.
    expect(
      isOwnedMigrationStoragePath(
        `migrations/${OWNER}/${ARCHIVE_NAME.toUpperCase()}.zip`,
        OWNER
      )
    ).toBe(false);
    expect(isOwnedMigrationStoragePath(`${OWNED_PATH}\n`, OWNER)).toBe(false);
    expect(
      isOwnedMigrationStoragePath(`migrations/${OWNER}/\0${ARCHIVE_NAME}.zip`, OWNER)
    ).toBe(false);
    expect(isOwnedMigrationStoragePath("", OWNER)).toBe(false);
    expect(isOwnedMigrationStoragePath(OWNED_PATH, "")).toBe(false);
  });
});

describe("CreateInstanceSchema migrationPath", () => {
  it("accepts a well-formed storage key (ownership is enforced downstream)", () => {
    const parsed = CreateInstanceSchema.parse({
      name: "Migration Agent",
      provider: "openrouter",
      migrationPath: OWNED_PATH,
    });
    expect(parsed.migrationPath).toBe(OWNED_PATH);
  });

  it.each([
    `migrations/${OWNER}/../${OTHER}/${ARCHIVE_NAME}.zip`,
    `migrations/${OWNER}/${ARCHIVE_NAME}.zip\n`,
    `migrations/${OWNER}/${ARCHIVE_NAME}.zip\r`,
    `migrations/${OWNER}/\0${ARCHIVE_NAME}.zip`,
  ])("rejects %j", (migrationPath) => {
    expect(() =>
      CreateInstanceSchema.parse({
        name: "Migration Agent",
        provider: "openrouter",
        migrationPath,
      })
    ).toThrow();
  });
});

describe("InstanceService.createInstance migrationPath ownership (SEC-01)", () => {
  const createSignedUrl = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin!.storage.from as jest.Mock).mockReturnValue({
      createSignedUrl,
    });
  });

  it("rejects a cross-tenant migrationPath with 403 before any DB write or signing", async () => {
    const result = await InstanceService.createInstance(
      OWNER,
      CreateInstanceSchema.parse({
        name: "Migration Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        migrationPath: FOREIGN_PATH,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 403,
      message: "Invalid or unauthorized migration archive path.",
    });
    // No instance row may be inserted and no signed URL may be minted.
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(supabaseAdmin!.storage.from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary bucket key that is not a migration archive", async () => {
    const result = await InstanceService.createInstance(
      OWNER,
      CreateInstanceSchema.parse({
        name: "Migration Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        migrationPath: `avatars/${OWNER}/${ARCHIVE_NAME}.zip`,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 403,
      message: "Invalid or unauthorized migration archive path.",
    });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects a traversal path even when schema validation is bypassed", async () => {
    const params = {
      ...CreateInstanceSchema.parse({
        name: "Migration Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
      }),
      migrationPath: `migrations/${OWNER}/../${OTHER}/${ARCHIVE_NAME}.zip`,
    };

    const result = await InstanceService.createInstance(OWNER, params);

    expect(result).toEqual({
      success: false,
      status: 403,
      message: "Invalid or unauthorized migration archive path.",
    });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
