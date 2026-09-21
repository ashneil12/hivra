import {
  INFRASTRUCTURE_CONNECTION_STATUSES,
  MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES,
  MAX_PROXMOX_VMID_RANGE_SIZE,
  PROXMOX_PREFLIGHT_ERROR_CODES,
  DeploymentTargetDtoSchema,
  GvisorDeploymentTargetDtoSchema,
  InfrastructurePreflightTargetEvidenceSchema,
  InfrastructureConnectionDtoSchema,
  HostConnectionCreateSchema,
  HetznerCloudConnectionCreateSchema,
  HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
  HetznerCloudForceForgetRequestSchema,
  InfrastructureConnectionCreateSchema,
  ProxmoxConnectionCreateSchema,
  ProxmoxConnectionUpdateSchema,
  ProxmoxPreflightErrorCodeSchema,
  ProxmoxPreflightResultSchema,
  ProxmoxSshHostFingerprintSchema,
  ProxmoxSshHostSchema,
  ProxmoxVmidRangeSchema,
} from "../contracts";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001035";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";
const SHA256_FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const SSH_PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(80),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const gvisorTarget = {
  id: TARGET_ID,
  connectionId: CONNECTION_ID,
  evidenceConnectionRevision: 4,
  externalId: `gvisor-${"b".repeat(24)}`,
  displayName: "Linux host — gVisor",
  status: "ready" as const,
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: null },
    memoryBytes: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 400 * 1024 ** 3 },
  },
  capabilities: {
    kind: "gvisor" as const,
    launchReady: true,
    hostIdentityDigest: "c".repeat(64),
    adapter: { version: "2026.09.15.1" as const, sha256: "d".repeat(64) },
    runtime: { path: "/usr/local/bin/runsc" as const, sha256: "e".repeat(64) },
    runtimeCompatibility: { contractVersion: 1 as const, supportedWorkloadKinds: ["linux-terminal"] as const },
    resourcePolicy: { reservationEqualsMaximum: true as const, aggregateAdmission: "serialized-host-headroom-v1" as const },
    access: { terminal: "owner-gated-command-v1" as const, publicPorts: false as const },
    desktop: false as const,
    windows: false as const,
  },
  supportedIsolationDrivers: ["gvisor-runsc"] as const,
  isolationClass: "application-kernel" as const,
  lastPreflightAt: CHECKED_AT,
  lastErrorCode: null,
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

function simpleCreateInput() {
  return {
    name: "  Personal Proxmox  ",
    provider: "proxmox" as const,
    operatingMode: "self-managed" as const,
    setupMode: "simple" as const,
    endpoint: {
      sshHost: "  pve.example.test ",
      sshPort: 22,
      sshUser: " root ",
      sshHostFingerprintSha256: ` ${SHA256_FINGERPRINT} `,
    },
    credentials: {
      sshPrivateKey: SSH_PRIVATE_KEY,
    },
  };
}

function advancedCreateInput() {
  return {
    ...simpleCreateInput(),
    setupMode: "advanced" as const,
    configuration: {
      node: "pve-01",
      bridge: "vmbr1",
      storage: "local-lvm",
      template: {
        vmid: 9000,
        expectedName: "hivra-base-v1",
      },
      provisioner: {
        directory: "/opt/hivra/provisioner",
        expectedVersion: "2026.08.25+1",
      },
      vmidRange: {
        start: 1000,
        end: 1099,
      },
    },
  };
}

function validDto() {
  const input = advancedCreateInput();
  return {
    id: CONNECTION_ID,
    name: "Personal Proxmox",
    provider: input.provider,
    operatingMode: input.operatingMode,
    setupMode: input.setupMode,
    status: "ready" as const,
    endpoint: input.endpoint,
    configuration: input.configuration,
    credentialsConfigured: true,
    lastCheckedAt: CHECKED_AT,
    lastErrorCode: null,
    createdAt: CHECKED_AT,
    updatedAt: CHECKED_AT,
  };
}

function validPreflightSuccess() {
  return {
    ok: true as const,
    connectionId: CONNECTION_ID,
    checkedAt: CHECKED_AT,
    target: {
      externalId: "pve-01",
      displayName: "Personal Proxmox / pve-01",
      proxmoxVersion: "8.3.5",
      launchReady: true,
      capacity: {
        cpu: { totalCores: 16, utilizationRatio: 0.25 },
        memoryBytes: { total: 68_719_476_736, available: 51_539_607_552 },
        storageBytes: { total: 1_000_000_000_000, available: 750_000_000_000 },
      },
      capabilities: {
        isolationDrivers: ["proxmox-kvm" as const],
        isolationClass: "hardware-vm" as const,
        kvmAvailable: true as const,
        bridges: ["vmbr1"],
        storages: ["local-lvm"],
        template: { vmid: 9000, ready: true },
        provisioner: { ready: true, version: "2026.08.25+1" },
        runtimeCompatibility: {
          contractVersion: 1 as const,
          provisionerVersion: "2026.08.25+1",
          supportedCatalogRuntimeIds: ["codex" as const],
        },
        vmidRange: { start: 1000, end: 1099, freeCount: 90 },
      },
    },
    warnings: [],
    unmetRequirements: [],
  };
}

describe("owner-supplied Proxmox connection contracts", () => {
  it("parses a strict Simple create payload and normalizes safe display fields", () => {
    const parsed = ProxmoxConnectionCreateSchema.parse(simpleCreateInput());

    expect(parsed).toEqual({
      ...simpleCreateInput(),
      name: "Personal Proxmox",
      endpoint: {
        ...simpleCreateInput().endpoint,
        sshHost: "pve.example.test",
        sshUser: "root",
        sshHostFingerprintSha256: SHA256_FINGERPRINT,
      },
    });
  });

  it("creates a generic host only in Simple mode without guessed substrate settings", () => {
    const host = {
      ...simpleCreateInput(),
      name: "  My host  ",
      provider: "host" as const,
    };

    expect(HostConnectionCreateSchema.parse(host)).toEqual({
      ...host,
      name: "My host",
      endpoint: {
        ...host.endpoint,
        sshHost: "pve.example.test",
        sshUser: "root",
        sshHostFingerprintSha256: SHA256_FINGERPRINT,
      },
    });
    expect(InfrastructureConnectionCreateSchema.safeParse(host).success).toBe(true);
    expect(HostConnectionCreateSchema.safeParse({
      ...host,
      setupMode: "advanced",
    }).success).toBe(false);
    expect(HostConnectionCreateSchema.safeParse({
      ...host,
      configuration: { bridge: "vmbr0" },
    }).success).toBe(false);
    expect(HostConnectionCreateSchema.safeParse({
      ...host,
      configuration: { capacityPolicy: {
        mode: "enforce",
        hostMemoryReserveMb: 2048,
        cpuCeilingDensity: 2,
        memoryCeilingDensity: 2,
      } },
    }).success).toBe(false);
  });

  it("accepts a project-scoped Hetzner token without inventing an SSH endpoint", () => {
    const input = {
      name: "  My Hetzner  ",
      provider: "hetzner-cloud" as const,
      operatingMode: "self-managed" as const,
      setupMode: "simple" as const,
      credentials: { apiToken: "project-scoped-owner-token-value" },
    };
    expect(HetznerCloudConnectionCreateSchema.parse(input)).toEqual({
      ...input,
      name: "My Hetzner",
    });
    expect(InfrastructureConnectionCreateSchema.safeParse(input).success).toBe(true);
    expect(HetznerCloudConnectionCreateSchema.safeParse({
      ...input,
      endpoint: simpleCreateInput().endpoint,
    }).success).toBe(false);
    expect(HetznerCloudConnectionCreateSchema.safeParse({
      ...input,
      setupMode: "advanced",
    }).success).toBe(false);
  });

  it("requires the exact destructive Hetzner force-forget confirmation", () => {
    expect(HetznerCloudForceForgetRequestSchema.parse({
      confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
    })).toEqual({
      confirmation: "FORGET HIVRA ACCESS AND KEEP PROVIDER RESOURCES",
    });
    expect(HetznerCloudForceForgetRequestSchema.safeParse({
      confirmation: "forget",
    }).success).toBe(false);
    expect(HetznerCloudForceForgetRequestSchema.safeParse({
      confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION,
      cleanupProvider: true,
    }).success).toBe(false);
  });

  it("accepts supported Advanced placement and prepared-target overrides", () => {
    expect(ProxmoxConnectionCreateSchema.parse(advancedCreateInput()).configuration).toEqual(
      advancedCreateInput().configuration,
    );
  });

  it("requires versioned provisioner evidence and accepts a trailing directory slash", () => {
    const withTrailingSlash = advancedCreateInput();
    withTrailingSlash.configuration.provisioner.directory = "/opt/hivra/provisioner/";
    expect(ProxmoxConnectionCreateSchema.safeParse(withTrailingSlash).success).toBe(true);

    const withoutVersion = advancedCreateInput();
    const provisioner = { ...withoutVersion.configuration.provisioner } as {
      directory: string;
      expectedVersion?: string;
    };
    delete provisioner.expectedVersion;
    expect(ProxmoxConnectionCreateSchema.safeParse({
      ...withoutVersion,
      configuration: { ...withoutVersion.configuration, provisioner },
    }).success).toBe(false);
  });

  it("enforces the Linux interface-name limit for bridge overrides", () => {
    expect(
      ProxmoxConnectionCreateSchema.safeParse({
        ...advancedCreateInput(),
        configuration: { ...advancedCreateInput().configuration, bridge: "v".repeat(16) },
      }).success,
    ).toBe(false);
  });

  it("does not let Simple mode carry manual placement overrides", () => {
    expect(
      ProxmoxConnectionCreateSchema.safeParse({
        ...simpleCreateInput(),
        configuration: { node: "pve-01" },
      }).success,
    ).toBe(false);
  });

  it("requires a bounded private key on create", () => {
    const withoutCredentials: Record<string, unknown> = { ...simpleCreateInput() };
    delete withoutCredentials.credentials;
    expect(ProxmoxConnectionCreateSchema.safeParse(withoutCredentials).success).toBe(false);
    expect(
      ProxmoxConnectionCreateSchema.safeParse({
        ...simpleCreateInput(),
        credentials: { sshPrivateKey: "not a private key" },
      }).success,
    ).toBe(false);

    const oversizedKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "A".repeat(MAX_PROXMOX_SSH_PRIVATE_KEY_BYTES),
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(
      ProxmoxConnectionCreateSchema.safeParse({
        ...simpleCreateInput(),
        credentials: { sshPrivateKey: oversizedKey },
      }).success,
    ).toBe(false);
  });

  it("accepts only host values without schemes, paths, embedded ports, or malformed IPs", () => {
    expect(ProxmoxSshHostSchema.safeParse("pve-01").success).toBe(true);
    expect(ProxmoxSshHostSchema.safeParse("192.0.2.10").success).toBe(true);
    expect(ProxmoxSshHostSchema.safeParse("2001:db8::1").success).toBe(true);

    for (const value of [
      "https://pve.example.test",
      "pve.example.test:22",
      "pve.example.test/path",
      "root@pve.example.test",
      "999.1.1.1",
      "bad_host",
    ]) {
      expect(ProxmoxSshHostSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts canonical OpenSSH and hexadecimal SHA-256 host fingerprints", () => {
    expect(ProxmoxSshHostFingerprintSchema.safeParse(SHA256_FINGERPRINT).success).toBe(true);
    for (const digest of [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 255)]) {
      expect(
        ProxmoxSshHostFingerprintSchema.safeParse(
          `SHA256:${digest.toString("base64").replace(/=+$/g, "")}`,
        ).success,
      ).toBe(true);
    }
    expect(ProxmoxSshHostFingerprintSchema.safeParse("ab".repeat(32)).success).toBe(true);
    expect(
      ProxmoxSshHostFingerprintSchema.safeParse(
        Array.from({ length: 32 }, () => "ab").join(":"),
      ).success,
    ).toBe(true);

    expect(ProxmoxSshHostFingerprintSchema.safeParse("SHA256:not-a-digest").success).toBe(
      false,
    );
    expect(
      ProxmoxSshHostFingerprintSchema.safeParse(`SHA256:${"A".repeat(42)}q`).success,
    ).toBe(false);
    expect(ProxmoxSshHostFingerprintSchema.safeParse("MD5:aa:bb").success).toBe(false);
  });

  it("supports deliberate bounded key rotation while rejecting empty or loose PATCH payloads", () => {
    expect(
      ProxmoxConnectionUpdateSchema.safeParse({
        credentials: { sshPrivateKey: SSH_PRIVATE_KEY },
      }).success,
    ).toBe(true);
    expect(ProxmoxConnectionUpdateSchema.safeParse({ configuration: null }).success).toBe(true);
    expect(ProxmoxConnectionUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      ProxmoxConnectionUpdateSchema.safeParse({ sshPrivateKey: SSH_PRIVATE_KEY }).success,
    ).toBe(false);
    expect(
      ProxmoxConnectionUpdateSchema.safeParse({ provider: "proxmox" }).success,
    ).toBe(false);
    expect(
      ProxmoxConnectionUpdateSchema.safeParse({ endpoint: { sshPort: 2222 } }).success,
    ).toBe(false);
    expect(
      ProxmoxConnectionUpdateSchema.safeParse({
        setupMode: "simple",
        configuration: { bridge: "vmbr1" },
      }).success,
    ).toBe(false);
  });

  it("bounds VMID ranges and keeps them internally consistent", () => {
    expect(ProxmoxVmidRangeSchema.safeParse({ start: 1000, end: 1099 }).success).toBe(true);
    expect(ProxmoxVmidRangeSchema.safeParse({ start: 1000, end: 999 }).success).toBe(false);
    expect(
      ProxmoxVmidRangeSchema.safeParse({
        start: 100,
        end: 100 + MAX_PROXMOX_VMID_RANGE_SIZE,
      }).success,
    ).toBe(false);
  });

  it("keeps connection DTOs strict, non-secret, and status-bound", () => {
    const parsed = InfrastructureConnectionDtoSchema.parse(validDto());

    expect(parsed.credentialsConfigured).toBe(true);
    expect("credentials" in parsed).toBe(false);
    expect("sshPrivateKey" in parsed).toBe(false);
    expect(
      InfrastructureConnectionDtoSchema.safeParse({
        ...validDto(),
        credentials: { sshPrivateKey: SSH_PRIVATE_KEY },
      }).success,
    ).toBe(false);
    expect(
      InfrastructureConnectionDtoSchema.safeParse({ ...validDto(), status: "online" }).success,
    ).toBe(false);
    expect(INFRASTRUCTURE_CONNECTION_STATUSES).toContain(parsed.status);
  });

  it("reads host-first connection metadata without granting launch authority", () => {
    const parsed = InfrastructureConnectionDtoSchema.parse({
      ...validDto(),
      provider: "host",
      name: "My host",
      setupMode: "simple",
      configuration: null,
    });

    expect(parsed.provider).toBe("host");
    expect(parsed.status).toBe("ready");
    expect(parsed).not.toHaveProperty("deploymentTarget");
  });

  it("reads a Hetzner project connection as a non-SSH provider binding", () => {
    const parsed = InfrastructureConnectionDtoSchema.parse({
      id: CONNECTION_ID,
      name: "My Hetzner",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      status: "ready",
      endpoint: null,
      configuration: null,
      capabilities: {
        inventory: true,
        offerCatalog: true,
        createCapacity: true,
        agentLaunch: false,
        reason:
          "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
      },
      credentialsConfigured: true,
      lastCheckedAt: CHECKED_AT,
      lastErrorCode: null,
      createdAt: CHECKED_AT,
      updatedAt: CHECKED_AT,
    });

    expect(parsed.provider).toBe("hetzner-cloud");
    if (parsed.provider !== "hetzner-cloud") throw new Error("Expected Hetzner Cloud");
    expect(parsed.endpoint).toBeNull();
    expect(parsed.capabilities.agentLaunch).toBe(false);
    expect(parsed).not.toHaveProperty("credentials");

    const failedObservation = InfrastructureConnectionDtoSchema.parse({
      ...parsed,
      status: "error",
      lastErrorCode: "invalid_credentials",
    });
    expect(failedObservation.lastErrorCode).toBe("invalid_credentials");
    expect(InfrastructureConnectionDtoSchema.safeParse({
      ...parsed,
      status: "error",
      lastErrorCode: "SSH_AUTHENTICATION_FAILED",
    }).success).toBe(false);
  });
});

describe("Proxmox preflight public contract", () => {
  it("accepts sanitized capacity and capabilities without raw command output", () => {
    const parsed = ProxmoxPreflightResultSchema.parse(validPreflightSuccess());

    expect(parsed.ok).toBe(true);
    expect(
      ProxmoxPreflightResultSchema.safeParse({
        ...validPreflightSuccess(),
        stdout: "root-only command output",
      }).success,
    ).toBe(false);
  });

  it("accepts stable, user-safe failure evidence and rejects raw causes", () => {
    const failure = {
      ok: false as const,
      connectionId: CONNECTION_ID,
      checkedAt: CHECKED_AT,
      error: {
        code: "SSH_HOST_KEY_MISMATCH" as const,
        message: "The server identity did not match the pinned fingerprint.",
        remediation: "Verify the host fingerprint before updating this connection.",
      },
      unmetRequirements: [
        {
          code: "SSH_HOST_KEY_MISMATCH" as const,
          message: "A verified SSH host identity is required.",
        },
      ],
    };

    expect(ProxmoxPreflightResultSchema.parse(failure)).toEqual(failure);
    expect(
      ProxmoxPreflightResultSchema.safeParse({
        ...failure,
        error: { ...failure.error, cause: new Error("socket detail") },
      }).success,
    ).toBe(false);
  });

  it.each(PROXMOX_PREFLIGHT_ERROR_CODES)("recognizes stable error code %s", (code) => {
    expect(ProxmoxPreflightErrorCodeSchema.parse(code)).toBe(code);
  });

  it("rejects impossible utilization and VMID counts", () => {
    const impossibleCpu = validPreflightSuccess();
    impossibleCpu.target.capacity.cpu.utilizationRatio = 1.1;
    expect(ProxmoxPreflightResultSchema.safeParse(impossibleCpu).success).toBe(false);

    const tooManyVmids = validPreflightSuccess();
    tooManyVmids.target.capabilities.vmidRange.freeCount = 101;
    expect(ProxmoxPreflightResultSchema.safeParse(tooManyVmids).success).toBe(false);
  });
});

describe("deployment-target persistence evidence", () => {
  const unavailableEvidence = {
    externalId: "pve-01",
    displayName: "Personal Proxmox / pve-01",
    status: "unavailable" as const,
    capacity: {
      cpu: { totalCores: 16, utilizationRatio: 0.5 },
      memoryBytes: { total: 64_000, available: 0 },
      storageBytes: null,
    },
    capabilities: {
      proxmoxVersion: "pve-manager/8.4.1",
      launchReady: false,
      directRootAccess: false,
      kvmAvailable: false,
      bridges: ["vmbr0"],
      selectedBridge: "vmbr0",
      storages: ["local-lvm"],
      selectedStorage: null,
      template: null,
      provisioner: null,
      runtimeCompatibility: null,
      vmidRange: { start: 200, end: 399, freeCount: 0, firstAvailable: null },
      issues: [{ code: "KVM_UNAVAILABLE" as const, message: "KVM is unavailable" }],
    },
    supportedIsolationDrivers: [] as Array<"proxmox-kvm">,
    isolationClass: null,
    lastErrorCode: "KVM_UNAVAILABLE" as const,
  };

  it("keeps one validated shape for discovered but unavailable nodes", () => {
    expect(InfrastructurePreflightTargetEvidenceSchema.parse(unavailableEvidence)).toEqual(
      unavailableEvidence,
    );
  });

  it("rehydrates strict owner-facing target evidence without internal or secret fields", () => {
    const dto = {
      id: TARGET_ID,
      connectionId: CONNECTION_ID,
      evidenceConnectionRevision: 3,
      ...unavailableEvidence,
      lastPreflightAt: CHECKED_AT,
      createdAt: CHECKED_AT,
      updatedAt: CHECKED_AT,
    };

    expect(DeploymentTargetDtoSchema.parse(dto)).toEqual(dto);
    expect(
      DeploymentTargetDtoSchema.safeParse({
        ...dto,
        userId: "user_a",
      }).success,
    ).toBe(false);
    expect(
      DeploymentTargetDtoSchema.safeParse({
        ...dto,
        encryptedBundle: "sealed-secret",
      }).success,
    ).toBe(false);
    expect(
      DeploymentTargetDtoSchema.safeParse({
        ...dto,
        stdout: "raw root command output",
      }).success,
    ).toBe(false);
  });

  it("requires explicit versioned runtime compatibility evidence", () => {
    const legacyCapabilities = { ...unavailableEvidence.capabilities } as Record<string, unknown>;
    delete legacyCapabilities.runtimeCompatibility;

    expect(
      InfrastructurePreflightTargetEvidenceSchema.safeParse({
        ...unavailableEvidence,
        capabilities: legacyCapabilities,
      }).success,
    ).toBe(false);
    expect(
      InfrastructurePreflightTargetEvidenceSchema.safeParse({
        ...unavailableEvidence,
        capabilities: {
          ...unavailableEvidence.capabilities,
          runtimeCompatibility: {
            contractVersion: 1,
            provisionerVersion: "2026.08.26.5",
            supportedCatalogRuntimeIds: ["codex"],
            preferredRuntime: "codex",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a persisted target that claims readiness without launch evidence", () => {
    expect(
      DeploymentTargetDtoSchema.safeParse({
        id: TARGET_ID,
        connectionId: CONNECTION_ID,
        evidenceConnectionRevision: 3,
        ...unavailableEvidence,
        status: "ready",
        lastErrorCode: null,
        lastPreflightAt: CHECKED_AT,
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive or unsafe evidence revision", () => {
    const dto = {
      id: TARGET_ID,
      connectionId: CONNECTION_ID,
      evidenceConnectionRevision: 1,
      ...unavailableEvidence,
      lastPreflightAt: CHECKED_AT,
      createdAt: CHECKED_AT,
      updatedAt: CHECKED_AT,
    };

    expect(
      DeploymentTargetDtoSchema.safeParse({
        ...dto,
        evidenceConnectionRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      DeploymentTargetDtoSchema.safeParse({
        ...dto,
        evidenceConnectionRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects isolation claims without a proven isolation class", () => {
    expect(
      InfrastructurePreflightTargetEvidenceSchema.safeParse({
        ...unavailableEvidence,
        supportedIsolationDrivers: ["proxmox-kvm"],
      }).success,
    ).toBe(false);
  });

  it("rejects ready target evidence that is not launch-ready", () => {
    expect(
      InfrastructurePreflightTargetEvidenceSchema.safeParse({
        ...unavailableEvidence,
        status: "ready",
        lastErrorCode: null,
      }).success,
    ).toBe(false);
  });
});

describe("direct-host gVisor deployment target contract", () => {
  it("accepts only the reviewed Linux terminal adapter capability", () => {
    expect(DeploymentTargetDtoSchema.parse(gvisorTarget)).toEqual(gvisorTarget);
    expect(GvisorDeploymentTargetDtoSchema.parse(gvisorTarget)).toEqual(gvisorTarget);

    expect(DeploymentTargetDtoSchema.safeParse({
      ...gvisorTarget,
      capabilities: { ...gvisorTarget.capabilities, desktop: true },
    }).success).toBe(false);
    expect(DeploymentTargetDtoSchema.safeParse({
      ...gvisorTarget,
      capabilities: {
        ...gvisorTarget.capabilities,
        runtimeCompatibility: {
          contractVersion: 1,
          supportedWorkloadKinds: ["windows"],
        },
      },
    }).success).toBe(false);
  });

  it("rejects incomplete ready evidence", () => {
    expect(DeploymentTargetDtoSchema.safeParse({
      ...gvisorTarget,
      capabilities: { ...gvisorTarget.capabilities, launchReady: false },
    }).success).toBe(false);
    expect(DeploymentTargetDtoSchema.safeParse({
      ...gvisorTarget,
      isolationClass: null,
    }).success).toBe(false);
  });
});
