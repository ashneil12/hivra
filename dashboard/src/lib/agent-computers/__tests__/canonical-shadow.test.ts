import {
  CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION,
  CanonicalResourceShadowSchema,
  legacyComputerAlias,
  projectCanonicalHermesShadow,
  projectCanonicalHivraShadow,
  type CanonicalShadowIds,
} from "../canonical-shadow";

const SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";
const SECRET = "DO_NOT_SERIALIZE_CANONICAL_SHADOW_SECRET";

const agentIds: CanonicalShadowIds = {
  computerId: COMPUTER_ID,
  agentIdentityId: IDENTITY_ID,
  runtimeInstallationId: INSTALLATION_ID,
  primaryBindingId: BINDING_ID,
};

const computerIds: CanonicalShadowIds = {
  computerId: COMPUTER_ID,
  agentIdentityId: null,
  runtimeInstallationId: null,
  primaryBindingId: null,
};

describe("canonical agent-computer V2 shadow", () => {
  it("keeps canonical IDs separate from stable legacy compatibility aliases", () => {
    expect(legacyComputerAlias({ kind: "hermes", id: SOURCE_ID })).toBe(
      `h-${SOURCE_ID}`,
    );
    expect(legacyComputerAlias({ kind: "hivra", id: SOURCE_ID })).toBe(
      `x-${SOURCE_ID}`,
    );

    const shadow = projectCanonicalHermesShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Hermes",
        status: "running",
        lifecycle_state: "active",
        backend: "gateway",
        agent_type: "hermes",
        host_id: "55555555-5555-4555-8555-555555555555",
      },
      agentIds,
      12n,
    );

    expect(shadow.computer.id).toBe(COMPUTER_ID);
    expect(shadow.computer.compatibilityAliases).toEqual([`h-${SOURCE_ID}`]);
    expect(shadow.sourceMapping).toMatchObject({
      source: { kind: "hermes", id: SOURCE_ID },
      compatibilityAlias: `h-${SOURCE_ID}`,
      computerId: COMPUTER_ID,
    });
    expect(CanonicalResourceShadowSchema.parse(shadow)).toEqual(shadow);
  });

  it("maps Ubuntu to a Computer with no agent identity, runtime installation, or binding", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Ubuntu",
        type: "linux-desktop",
        computer_profile: "ubuntu-desktop",
        status: "running",
        desired_state: "running",
        operation_id: null,
        operation_kind: null,
        deployment_mode: "hivra-managed",
        computer_substrate: "proxmox-kvm",
        pool_id: "66666666-6666-4666-8666-666666666666",
        cpu: 2,
        ram: 4,
      },
      computerIds,
      27n,
    );

    expect(shadow.computer).toMatchObject({
      contractVersion: CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION,
      resourceKind: "computer",
      osProfile: "ubuntu-desktop",
      capacity: {
        kind: "pool",
        id: "66666666-6666-4666-8666-666666666666",
      },
      capabilities: {
        surfaces: ["files", "terminal", "desktop"],
        actions: ["stop", "reboot", "delete", "resize", "snapshot", "restore"],
      },
      state: {
        desired: "running",
        observed: "running",
        health: "unknown",
        operation: null,
      },
    });
    expect(shadow.agentIdentity).toBeNull();
    expect(shadow.runtimeInstallation).toBeNull();
    expect(shadow.primaryBinding).toBeNull();
    expect(shadow.sourceMapping).toMatchObject({
      agentIdentityId: null,
      runtimeInstallationId: null,
      primaryBindingId: null,
    });
    expect(CanonicalResourceShadowSchema.parse(shadow)).toEqual(shadow);
  });

  it("keeps provider-VM lifecycle capabilities fail-closed", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Provider Ubuntu",
        type: "linux-desktop",
        computer_profile: "ubuntu-desktop",
        computer_substrate: "provider-vm",
        status: "running",
        desired_state: "running",
      },
      computerIds,
      28n,
    );

    expect(shadow.computer.capabilities).toEqual({
      surfaces: ["files", "terminal", "desktop"],
      actions: ["stop", "reboot", "delete"],
    });
  });

  it("projects a gVisor Computer as terminal-only", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Linux terminal",
        type: "linux-terminal",
        computer_profile: "linux-terminal",
        computer_substrate: "gvisor",
        status: "running",
        desired_state: "running",
      },
      computerIds,
      29n,
    );

    expect(shadow.computer.capabilities).toEqual({
      surfaces: ["terminal"],
      actions: ["stop", "delete", "resize"],
    });
  });

  it("keeps an agent identity, its computer, runtime installation, and binding distinct", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Codex",
        type: "codex",
        computer_profile: null,
        status: "provisioning",
        desired_state: "running",
        operation_id: "77777777-7777-4777-8777-777777777777",
        operation_kind: "resize",
        deployment_mode: "self-managed",
        deployment_target_id: "88888888-8888-4888-8888-888888888888",
        infrastructure_connection_id: "99999999-9999-4999-8999-999999999999",
        infrastructure_connection_revision: 4,
        cpu: 4,
        ram: 8,
      },
      agentIds,
      "42",
    );

    expect(shadow.computer.resourceKind).toBe("agent");
    expect(shadow.agentIdentity).toMatchObject({ id: IDENTITY_ID, name: "Codex" });
    expect(shadow.runtimeInstallation).toMatchObject({
      id: INSTALLATION_ID,
      computerId: COMPUTER_ID,
      runtimeId: "codex",
      status: "installing",
    });
    expect(shadow.primaryBinding).toMatchObject({
      id: BINDING_ID,
      computerId: COMPUTER_ID,
      agentIdentityId: IDENTITY_ID,
      status: "active",
    });
    expect(shadow.computer.state.operation).toEqual({
      state: "resizing",
      id: "77777777-7777-4777-8777-777777777777",
    });
    expect(shadow.computer.capacity).toEqual({
      kind: "deployment-target",
      id: "88888888-8888-4888-8888-888888888888",
      connectionId: "99999999-9999-4999-8999-999999999999",
      connectionRevision: 4,
    });
  });

  it("retains stable mappings and relationships as tombstones for deleted sources", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Deleted Codex",
        type: "codex",
        status: "deleted",
        desired_state: "deleted",
      },
      agentIds,
      50,
    );

    expect(shadow.computer.state).toMatchObject({
      desired: "absent",
      observed: "missing",
    });
    expect(shadow.computer.tombstoned).toBe(true);
    expect(shadow.agentIdentity?.status).toBe("archived");
    expect(shadow.runtimeInstallation?.status).toBe("removed");
    expect(shadow.primaryBinding?.status).toBe("detached");
    expect(shadow.sourceMapping.computerId).toBe(COMPUTER_ID);

    const hardDeletedHermes = projectCanonicalHermesShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Failed Hermes",
        status: "failed",
        lifecycle_state: "error",
        backend: "gateway",
      },
      agentIds,
      51,
      { sourceOperation: "delete" },
    );
    expect(hardDeletedHermes.computer.tombstoned).toBe(true);
    expect(hardDeletedHermes.computer.state.desired).toBe("absent");
    expect(hardDeletedHermes.computer.state.observed).toBe("missing");
    expect(hardDeletedHermes.computer.capabilities).toEqual({
      surfaces: [],
      actions: [],
    });
    expect(hardDeletedHermes.agentIdentity?.status).toBe("archived");
  });

  it("fails closed for an unknown runtime and never projects source secrets", () => {
    const shadow = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Retained preview",
        type: "future-runtime",
        status: "running",
        api_token: SECRET,
        llm_api_key_encrypted: SECRET,
        arbitrary_config: { password: SECRET },
      } as Parameters<typeof projectCanonicalHivraShadow>[0] & Record<string, unknown>,
      agentIds,
      52,
    );

    expect(shadow.computer.capabilities).toEqual({ surfaces: [], actions: [] });
    expect(JSON.stringify(shadow)).not.toContain(SECRET);
  });

  it("rejects a partial or cross-linked agent relationship", () => {
    const valid = projectCanonicalHivraShadow(
      {
        id: SOURCE_ID,
        user_id: "user_123",
        name: "Codex",
        type: "codex",
        status: "running",
      },
      agentIds,
      53,
    );

    expect(
      CanonicalResourceShadowSchema.safeParse({
        ...valid,
        runtimeInstallation: null,
      }).success,
    ).toBe(false);
    expect(
      CanonicalResourceShadowSchema.safeParse({
        ...valid,
        primaryBinding: {
          ...valid.primaryBinding,
          computerId: "00000000-0000-4000-8000-000000000000",
        },
      }).success,
    ).toBe(false);
    expect(
      CanonicalResourceShadowSchema.safeParse({
        ...valid,
        agentIdentity: {
          ...valid.agentIdentity,
          ownerId: "different-owner",
        },
      }).success,
    ).toBe(false);
    expect(
      CanonicalResourceShadowSchema.safeParse({
        ...valid,
        sourceMapping: {
          ...valid.sourceMapping,
          compatibilityAlias: `h-${SOURCE_ID}`,
        },
      }).success,
    ).toBe(false);
  });
});
