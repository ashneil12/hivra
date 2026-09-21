jest.mock("server-only", () => ({}));

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockEncryptSecret = jest.fn<string, [string]>(() => "sealed-provider-token");
const mockDecryptSecret = jest.fn<string, [string]>();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/crypto", () => ({
  encryptSecret: (plaintext: string) => mockEncryptSecret(plaintext),
  decryptSecret: (ciphertext: string) => mockDecryptSecret(ciphertext),
}));

import {
  abandonHetznerCleanup,
  claimHetznerCleanup,
  createHetznerCloudCapacityQuoteRecord,
  createHetznerCloudConnectionRecord,
  loadHetznerCloudConnectionSecret,
  hasDispatchedHetznerCapacityRequest,
  recordHetznerCloudCapacityOrderProgress,
  recordHetznerCloudInventoryFailure,
  reconcileHetznerCloudInventory,
  recordHetznerCleanupObservation,
  verifyHetznerCleanupLease,
} from "../hetzner-cloud-store";
import {
  HETZNER_CLOUD_BILLING_SEMANTICS,
  HETZNER_CLOUD_FIREWALL_LIMITATION,
  HETZNER_CLOUD_SIMPLE_MODE_POLICY,
  HETZNER_CLOUD_SPENDING_CONFIRMATION,
  type HetznerCloudCapacityQuoteDto,
} from "../contracts";
import type { HetznerCreationReceipt } from "../hetzner-creation-receipt";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const INVENTORY_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-26T15:00:00.000Z";
const QUOTE_ID = "33333333-3333-4333-8333-333333333333";

describe("owner-bound capacity reconciliation rate classification", () => {
  const lookup = async (data: unknown, error: unknown = null) => {
    const chain = { select: jest.fn(), eq: jest.fn(), not: jest.fn(), maybeSingle: jest.fn().mockResolvedValue({ data, error }) };
    chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.not.mockReturnValue(chain);
    mockFrom.mockReturnValue(chain);
    const result = await hasDispatchedHetznerCapacityRequest("user_a", CONNECTION_ID, QUOTE_ID, INVENTORY_ID);
    return { result, chain };
  };
  it("requires the exact owner, connection, original key and durable server dispatch", async () => {
    const { result, chain } = await lookup({ id: QUOTE_ID, idempotency_key: INVENTORY_ID, server_post_attempted_at: NOW });
    expect(result).toBe(true);
    for (const pair of [["user_id","user_a"],["connection_id",CONNECTION_ID],["active_connection_id",CONNECTION_ID],
      ["provider","hetzner-cloud"],["id",QUOTE_ID],["idempotency_key",INVENTORY_ID]]) expect(chain.eq).toHaveBeenCalledWith(...pair);
    expect(chain.not).toHaveBeenCalledWith("server_post_attempted_at","is",null);
    expect(chain.select).toHaveBeenCalledWith("id,idempotency_key,server_post_attempted_at");
  });
  it.each([null, {}, { id:QUOTE_ID,idempotency_key:INVENTORY_ID,server_post_attempted_at:null },
    { id:QUOTE_ID,idempotency_key:INVENTORY_ID,server_post_attempted_at:"bad" },
    { id:CONNECTION_ID,idempotency_key:INVENTORY_ID,server_post_attempted_at:NOW },
    { id:QUOTE_ID,idempotency_key:CONNECTION_ID,server_post_attempted_at:NOW }])("does not classify an unproven request as reconciliation: %j", async data => {
    expect((await lookup(data)).result).toBe(false);
  });
  it("fails closed for database errors", async () => {
    await expect(lookup(null,{code:"XX000"})).rejects.toMatchObject({code:"database_error"});
  });
});

describe("private original-resource receipt and cleanup storage", () => {
  const receipt: HetznerCreationReceipt = {
    version: 1, serverId: "42",
    primaryIpv4: { id: "88", ip: "203.0.113.10" },
    primaryIpv6: { id: "89", ip: "2001:db8::/64" },
    action: { id: "500", command: "create_server", status: "running", resources: [{ id: "42", type: "server" }] },
    nextActions: [],
  };
  const input = {
    userId: "user_a", connectionId: CONNECTION_ID, orderId: QUOTE_ID,
    idempotencyKey: INVENTORY_ID, providerServerId: "42", providerActionId: "500",
    providerActionCommand: "create_server", providerActionStatus: "running" as const,
    providerNextActions: [], observedServerStatus: "off" as const, providerObservedAt: NOW,
  };
  const row = () => ({
    id: QUOTE_ID, connection_id: CONNECTION_ID, connection_revision: 1,
    idempotency_key: INVENTORY_ID, status: "creating", provider_resource_id: "42",
    provider_action_id: "500", provider_action_command: "create_server",
    provider_action_status: "running", provider_next_actions: [],
    observed_server_status: "off", provider_observed_at: NOW, last_error_code: null,
    provider_ssh_key_id: "77", quote_snapshot: capacityQuote(), created_at: NOW, updated_at: NOW,
    bootstrap_public_key: "public-key", bootstrap_public_key_fingerprint: "fingerprint",
    provider_labels: { "hivra-operation": QUOTE_ID, "hivra-quote": "a".repeat(32), "hivra-managed": "true" },
    provider_creation_receipt: receipt,
  });

  beforeEach(() => mockRpc.mockReset());

  it("releases the DTO claim only with the persisted external-resolution marker and retains ambiguity", async () => {
    mockRpc.mockResolvedValue({data:{...row(),status:"ambiguous",provider_creation_receipt:null,
      external_cleanup_resolution_id:QUOTE_ID},error:null});
    const result=await recordHetznerCloudCapacityOrderProgress(input);
    expect(result.operation).toMatchObject({status:"ambiguous",canarySlotHeld:false,externalCleanupResolutionId:QUOTE_ID});
    expect(result.creationReceipt).toBeNull();
    mockRpc.mockResolvedValue({data:{...row(),status:"ambiguous",provider_creation_receipt:null},error:null});
    expect((await recordHetznerCloudCapacityOrderProgress(input)).operation.canarySlotHeld).toBe(true);
  });

  it("commits the initial receipt through an owner/revision-bound atomic RPC and omits it from the public DTO", async () => {
    mockRpc.mockResolvedValue({ data: row(), error: null });
    const result = await recordHetznerCloudCapacityOrderProgress({
      ...input, creation: { expectedRevision: 1, receipt },
    });
    expect(mockRpc).toHaveBeenCalledWith("record_hetzner_cloud_capacity_creation_progress", expect.objectContaining({
      p_user_id: "user_a", p_connection_id: CONNECTION_ID, p_order_id: QUOTE_ID,
      p_idempotency_key: INVENTORY_ID, p_expected_revision: 1, p_creation_receipt: receipt,
    }));
    expect(result.creationReceipt).toEqual(receipt);
    expect(result.operation).not.toHaveProperty("creationReceipt");
    expect(result.operation).not.toHaveProperty("provider_creation_receipt");
  });

  it("does not fabricate or backfill receipts for later observations or legacy rows", async () => {
    mockRpc.mockResolvedValue({ data: { ...row(), provider_creation_receipt: null }, error: null });
    const result = await recordHetznerCloudCapacityOrderProgress(input);
    expect(mockRpc).toHaveBeenCalledWith("record_hetzner_cloud_capacity_order_progress", expect.not.objectContaining({
      p_creation_receipt: expect.anything(),
    }));
    expect(result.creationReceipt).toBeNull();
  });

  it("fails closed on a lost lease or failed receipt transaction", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(recordHetznerCloudCapacityOrderProgress({ ...input, creation: { expectedRevision: 1, receipt } }))
      .rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "private SQL diagnostic" } });
    await expect(recordHetznerCloudCapacityOrderProgress({ ...input, creation: { expectedRevision: 1, receipt } }))
      .rejects.toEqual(expect.objectContaining({ code: "database_error" }));
  });

  it("rejects malformed stored receipts instead of dropping their evidence", async () => {
    mockRpc.mockResolvedValue({ data: { ...row(), provider_creation_receipt: {} }, error: null });
    await expect(recordHetznerCloudCapacityOrderProgress(input))
      .rejects.toEqual(expect.objectContaining({ code: "database_error" }));
  });
  const cleanupBinding = {
    userId: "user_a", connectionId: CONNECTION_ID, expectedRevision: 1,
    orderId: QUOTE_ID, leaseId: INVENTORY_ID,
  };
  const cleanupRequest = {
    ...cleanupBinding, idempotencyKey: INVENTORY_ID, fingerprint: "a".repeat(64),
    serverName: "hivra-33333333333343338333",
  };
  const absence = { server: true, ipv4: true, ipv6: true, sshKey: true };
  const cleanupRow = () => ({
    ...row(), status: "deleted", cleanup_idempotency_key: INVENTORY_ID,
    cleanup_resource_fingerprint: cleanupRequest.fingerprint, cleanup_absence: absence,
    cleanup_last_error: null, cleanup_started_at: NOW, cleanup_observed_at: NOW,
    cleanup_finished_at: NOW, cleanup_abandoned_at: null,
    encrypted_bootstrap_bundle: "must-never-leave-private-row", api_token: "must-not-leak",
  });
  it("binds cleanup claims to their owner, revision, order, exact confirmation and lease", async () => {
    mockRpc.mockResolvedValue({ data: { outcome: "complete", order: cleanupRow() }, error: null });
    const result = await claimHetznerCleanup(cleanupRequest);
    expect(mockRpc).toHaveBeenCalledWith("claim_hetzner_cleanup_with_firewall", {
      p_user_id: "user_a", p_connection_id: CONNECTION_ID, p_expected_revision: 1,
      p_order_id: QUOTE_ID, p_lease_id: INVENTORY_ID, p_idempotency_key: INVENTORY_ID,
      p_fingerprint: cleanupRequest.fingerprint, p_server_name: cleanupRequest.serverName,
      p_expected_firewall_receipt: null,
    });
    expect(result).toMatchObject({ outcome: "complete", order: {
      operation: { status: "deleted", canarySlotHeld: false }, cleanup: { absence },
    } });
    expect(JSON.stringify(result)).not.toContain("must-");
  });
  it("passes the exact expected fifth-resource receipt into the locked claim, and returns stale-preview rejection", async () => {
    const firewall = { version: 1, firewallId: 91, scope: { orderId: QUOTE_ID } };
    mockRpc.mockResolvedValue({ data: { outcome: "confirmation_changed" }, error: null });
    expect(await claimHetznerCleanup({ ...cleanupRequest, expectedFirewallReceipt: firewall })).toEqual({ outcome: "confirmation_changed" });
    expect(mockRpc).toHaveBeenCalledWith("claim_hetzner_cleanup_with_firewall", expect.objectContaining({
      p_expected_firewall_receipt: firewall, p_fingerprint: cleanupRequest.fingerprint,
    }));
  });
  it("requires a literal true lease verification, never a truthy database response", async () => {
    for (const data of [false, null, "true", {}]) {
      mockRpc.mockResolvedValueOnce({ data, error: null });
      expect(await verifyHetznerCleanupLease(cleanupBinding)).toBe(false);
    }
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await verifyHetznerCleanupLease(cleanupBinding)).toBe(true);
  });
  it("cannot promote a rejected stale checkpoint to successful cleanup", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(recordHetznerCleanupObservation({ ...cleanupBinding, absence, error: null }))
      .rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    expect(mockRpc).toHaveBeenCalledWith("record_hetzner_cleanup_observation", expect.objectContaining({
      p_user_id: "user_a", p_connection_id: CONNECTION_ID, p_expected_revision: 1,
      p_order_id: QUOTE_ID, p_lease_id: INVENTORY_ID, p_absence: absence, p_error: null,
    }));
  });
  it("does not report credential revocation for a busy, foreign or failed cleanup", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "55006", message: "private detail" } });
    await expect(abandonHetznerCleanup(cleanupRequest)).rejects.toEqual(expect.objectContaining({ code: "capacity_busy" }));
    mockRpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(abandonHetznerCleanup(cleanupRequest)).rejects.toEqual(expect.objectContaining({ code: "not_found" }));
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "private detail" } });
    await expect(abandonHetznerCleanup(cleanupRequest)).rejects.toEqual(expect.objectContaining({ code: "database_error" }));
  });
});

function capacityQuote(): HetznerCloudCapacityQuoteDto {
  const component = {
    hourly: { net: "0.01", gross: "0.0119" },
    monthly: { net: "5", gross: "5.95" },
  };
  return {
    id: QUOTE_ID,
    connectionId: CONNECTION_ID,
    connectionRevision: 1,
    serverName: "hivra-33333333333343338333",
    serverType: {
      id: 104,
      name: "cpx22",
      description: "CPX 22",
      architecture: "x86" as const,
      cores: 2,
      memoryGb: 4,
      diskGb: 80,
    },
    location: {
      id: 1,
      name: "fsn1",
      city: "Falkenstein",
      country: "DE",
    },
    image: {
      id: 100,
      type: "system" as const,
      name: "ubuntu-24.04",
      description: "Ubuntu 24.04",
      architecture: "x86" as const,
      osFlavor: "ubuntu" as const,
      osVersion: "24.04",
    },
    price: {
      currency: "EUR",
      vatRate: "19",
      server: component,
      primaryIpv4: component,
      primaryIpv6: component,
      total: component,
      traffic: {
        includedBytes: 20_000_000_000_000,
        additionalPerTb: { net: "1", gross: "1.19" },
      },
    },
    publicNetwork: { ipv4: true as const, ipv6: true as const },
    backups: false as const,
    volumes: [] as [],
    startAfterCreate: false as const,
    simpleModePolicy: {
      ...HETZNER_CLOUD_SIMPLE_MODE_POLICY,
      maxMonthlyGrossByCurrency: [
        { ...HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMonthlyGrossByCurrency[0] },
        { ...HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMonthlyGrossByCurrency[1] },
      ],
    },
    billing: HETZNER_CLOUD_BILLING_SEMANTICS,
    access: {
      username: "hivra" as const,
      method: "generated-ed25519" as const,
      inboundTcpPortsAfterFirstBoot: [22] as [22],
      passwordAuthentication: false as const,
      rootSshLogin: false as const,
      providerFirewallAttached: false as const,
      firewallLimitation: HETZNER_CLOUD_FIREWALL_LIMITATION,
    },
    fetchedAt: NOW,
    expiresAt: "2026-08-26T15:10:00.000Z",
    spendingConfirmation: HETZNER_CLOUD_SPENDING_CONFIRMATION,
  };
}

function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

function connectionRow(patch: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    user_id: "user_a",
    name: "My Hetzner",
    provider: "hetzner-cloud",
    operating_mode: "self-managed",
    setup_mode: "simple",
    status: "ready",
    revision: 1,
    last_checked_at: NOW,
    last_error_code: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

function inventoryRow() {
  return {
    id: INVENTORY_ID,
    connection_id: CONNECTION_ID,
    provider_resource_id: "42",
    name: "ash-dev-box",
    provider_status: "running",
    server_type: {
      name: "cpx22",
      description: "CPX 22",
      cores: 2,
      memoryGb: 4,
      diskGb: 80,
      cpuType: "shared",
      architecture: "x86",
    },
    location: { name: "fsn1", city: "Falkenstein", country: "DE" },
    public_network: { ipv4: "203.0.113.10", ipv6: "2001:db8::10" },
    provider_created_at: NOW,
    discovered_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("Hetzner Cloud connection store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptSecret.mockReturnValue("sealed-provider-token");
  });

  it("surfaces the durable owner quote cap from the atomic quote RPC", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { outcome: "quote_rate_limited" },
      error: null,
    });
    const quote = capacityQuote();

    await expect(createHetznerCloudCapacityQuoteRecord({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 1,
      quote,
      providerLabels: {
        "hivra-operation": QUOTE_ID,
        "hivra-quote": "a".repeat(32),
        "hivra-managed": "true",
      },
      quoteFingerprintSha256: "a".repeat(64),
    })).rejects.toEqual(expect.objectContaining({ code: "quote_limit" }));

    expect(mockRpc).toHaveBeenCalledWith(
      "create_hetzner_cloud_capacity_quote",
      expect.objectContaining({
        p_user_id: "user_a",
        p_quote_id: QUOTE_ID,
        p_quote_expires_at: quote.expiresAt,
        p_now: expect.stringMatching(/Z$/),
      }),
    );
  });

  it("encrypts the provider-discriminated token and never sends plaintext to the RPC", async () => {
    mockRpc.mockImplementationOnce((_name, args) => Promise.resolve({
      data: {
        connection: connectionRow({ id: args.p_connection_id }),
        inventory: [inventoryRow()],
      },
      error: null,
    }));
    const token = "project-scoped-owner-token-value";

    const result = await createHetznerCloudConnectionRecord({
      userId: "user_a",
      name: "My Hetzner",
      apiToken: token,
      discoveredAt: NOW,
      inventory: [{
        providerResourceId: "42",
        name: "ash-dev-box",
        status: "running",
        serverType: inventoryRow().server_type as never,
        location: inventoryRow().location as never,
        publicNetwork: inventoryRow().public_network as never,
        providerCreatedAt: NOW,
        discoveredAt: NOW,
        launchReady: false,
        launchBlockedReason: "Provider VM bootstrap is not implemented yet.",
      }],
    });

    const encryptedPlaintext = JSON.parse(mockEncryptSecret.mock.calls[0][0]);
    expect(encryptedPlaintext).toEqual({
      version: 2,
      provider: "hetzner-cloud",
      userId: "user_a",
      connectionId: expect.any(String),
      connectionRevision: 1,
      apiToken: token,
    });
    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(mockRpc.mock.calls[0][0]).toBe(
      "create_hetzner_cloud_infrastructure_connection_v2",
    );
    expect(rpcArgs.p_connection_id).toBe(encryptedPlaintext.connectionId);
    expect(rpcArgs.p_key_version).toBe(2);
    expect(JSON.stringify(rpcArgs)).not.toContain(token);
    expect(rpcArgs.p_encrypted_bundle).toBe("sealed-provider-token");
    expect(result.connection).not.toHaveProperty("credentials");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.inventory[0].publicNetwork.ipv4).toBe("203.0.113.10");
  });

  it("loads a token only after exact owner and provider checks", async () => {
    const connectionQuery = query({ data: connectionRow(), error: null });
    const secretQuery = query({
      data: { encrypted_bundle: "sealed-provider-token", key_version: 1 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(connectionQuery).mockReturnValueOnce(secretQuery);
    mockDecryptSecret.mockReturnValue(JSON.stringify({
      version: 1,
      provider: "hetzner-cloud",
      apiToken: "project-scoped-owner-token-value",
    }));

    const result = await loadHetznerCloudConnectionSecret("user_a", CONNECTION_ID);

    expect(connectionQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(secretQuery.eq).toHaveBeenCalledWith("user_id", "user_a");
    expect(result.apiToken).toBe("project-scoped-owner-token-value");
    expect(result.connection).not.toHaveProperty("apiToken");
  });

  it("requires an exactly row-bound v2 token envelope for billable capacity", async () => {
    const connectionQuery = query({ data: connectionRow(), error: null });
    const secretQuery = query({
      data: { encrypted_bundle: "sealed-provider-token", key_version: 2 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(connectionQuery).mockReturnValueOnce(secretQuery);
    mockDecryptSecret.mockReturnValue(JSON.stringify({
      version: 2,
      provider: "hetzner-cloud",
      userId: "user_a",
      connectionId: CONNECTION_ID,
      connectionRevision: 1,
      apiToken: "project-scoped-owner-token-value",
    }));

    await expect(loadHetznerCloudConnectionSecret(
      "user_a",
      CONNECTION_ID,
      { requireBoundToken: true },
    )).resolves.toEqual(expect.objectContaining({
      apiToken: "project-scoped-owner-token-value",
      revision: 1,
    }));
  });

  it("rejects a v2 ciphertext swapped from a different connection row", async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: connectionRow(), error: null }))
      .mockReturnValueOnce(query({
        data: { encrypted_bundle: "swapped-provider-token", key_version: 2 },
        error: null,
      }));
    mockDecryptSecret.mockReturnValue(JSON.stringify({
      version: 2,
      provider: "hetzner-cloud",
      userId: "user_a",
      connectionId: "99999999-9999-4999-8999-999999999999",
      connectionRevision: 1,
      apiToken: "wrong-project-token-value",
    }));

    await expect(loadHetznerCloudConnectionSecret(
      "user_a",
      CONNECTION_ID,
      { requireBoundToken: true },
    )).rejects.toEqual(expect.objectContaining({ code: "credential_error" }));
  });

  it("keeps legacy v1 tokens read-only and requires reconnect before billing", async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: connectionRow(), error: null }))
      .mockReturnValueOnce(query({
        data: { encrypted_bundle: "legacy-provider-token", key_version: 1 },
        error: null,
      }));
    mockDecryptSecret.mockReturnValue(JSON.stringify({
      version: 1,
      provider: "hetzner-cloud",
      apiToken: "legacy-project-token-value",
    }));

    await expect(loadHetznerCloudConnectionSecret(
      "user_a",
      CONNECTION_ID,
      { requireBoundToken: true },
    )).rejects.toEqual(expect.objectContaining({
      code: "credential_reconnect_required",
    }));
  });

  it("fails closed before touching secrets for a cross-owner lookup", async () => {
    const connectionQuery = query({ data: null, error: null });
    mockFrom.mockReturnValueOnce(connectionQuery);

    await expect(
      loadHetznerCloudConnectionSecret("user_b", CONNECTION_ID),
    ).rejects.toEqual(expect.objectContaining({ code: "not_found" }));
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a newer inventory generation supersedes this refresh", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(reconcileHetznerCloudInventory({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 1,
      discoveredAt: NOW,
      inventory: [],
    })).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
  });

  it("records a sanitized failed provider observation against the exact owner revision", async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    await expect(recordHetznerCloudInventoryFailure({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 3,
      checkedAt: NOW,
      lastErrorCode: "invalid_credentials",
    })).resolves.toBe(true);

    expect(mockRpc).toHaveBeenCalledWith(
      "record_hetzner_cloud_inventory_failure",
      {
        p_user_id: "user_a",
        p_connection_id: CONNECTION_ID,
        p_expected_revision: 3,
        p_checked_at: NOW,
        p_last_error_code: "invalid_credentials",
      },
    );
  });
});
