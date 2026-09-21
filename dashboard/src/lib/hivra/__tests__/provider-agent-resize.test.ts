/** @jest-environment node */
jest.mock("server-only", () => ({}));

import type { HetznerAction, HetznerCloudProjectClient, HetznerServer } from "@/lib/hetzner/client";
import type { HetznerCloudOfferCatalogDto } from "@/lib/infrastructure/contracts";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  PROVIDER_RESIZE_DOWNTIME_NOTICE,
  type ProviderResizeQuote,
} from "../provider-agent-resize-contract";
import {
  advanceProviderResize,
  applyProviderResize,
  getProviderResizeCatalog,
  ProviderAgentResizeError,
  quoteProviderResize,
  reconcileAbsentProviderResizeForDelete,
} from "../provider-agent-resize";
import {
  ProviderAgentResizeStoreError,
  type ProviderResizeAuthority,
  type StoredProviderResizeOperation,
} from "../provider-agent-resize-store";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ATTEMPT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ALLOCATION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-04T14:00:00.000Z";

function originalQuote() {
  const original = structuredClone(receiverFixture().evidence.quote_snapshot);
  return {
    ...original, id: ORDER_ID, connectionId: CONNECTION_ID, connectionRevision: 7, serverName: "hivra-owned",
    serverType: { ...original.serverType, id: 1, name: "cpx22", description: "CPX22",
      architecture: "x86" as const, cores: 2, memoryGb: 4, diskGb: 80 },
  };
}

function authority(): ProviderResizeAuthority {
  return {
    agent: {
      id: AGENT_ID, user_id: "owner", type: "codex", status: "stopped", desired_state: "stopped",
      operation_id: null, operation_kind: null, operation_started_at: null, cpu: 2, ram: 4,
      computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null,
      proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
      infrastructure_connection_id: CONNECTION_ID, infrastructure_connection_revision: 7,
      deployment_target_id: TARGET_ID, provider_capacity_order_id: ORDER_ID,
      provider_enrollment_attempt_id: ATTEMPT_ID, provider_server_id: "42",
      allocation_operation_id: ALLOCATION_ID, provider_install_outcome: "succeeded",
      provider_install_stopped_at: "2026-09-01T12:00:00.000Z",
    },
    order: {
      id: ORDER_ID, user_id: "owner", connection_id: CONNECTION_ID, active_connection_id: CONNECTION_ID,
      connection_revision: 7, provider: "hetzner-cloud", status: "created_off", server_name: "hivra-owned",
      provider_labels: { "hivra-operation": ALLOCATION_ID, "hivra-managed": "true" },
      quote_fingerprint_sha256: "c".repeat(64), quote_snapshot: originalQuote(), provider_resource_id: "42",
      provider_creation_receipt: {
        version: 1, serverId: "42", primaryIpv4: { id: "43", ip: "203.0.113.10" },
        primaryIpv6: { id: "44", ip: "2001:db8::/64" },
        action: { id: "45", command: "create_server", status: "success", resources: [{ id: "42", type: "server" }] },
        nextActions: [],
      },
      cleanup_started_at: null, cleanup_finished_at: null, detached_at: null,
    },
    target: {
      id: TARGET_ID, user_id: "owner", connection_id: CONNECTION_ID, evidence_connection_revision: 7,
      external_id: "42", status: "ready", capacity: {}, supported_isolation_drivers: ["provider-vm"],
      isolation_class: "provider-vm", provider_capacity_order_id: ORDER_ID, provider_retired_at: null,
      last_preflight_at: "2026-09-01T12:00:00.000Z",
      capabilities: { kind: "provider-vm", provider: "hetzner-cloud", allocation: "exclusive-computer",
        capacityOrderId: ORDER_ID, enrollmentAttemptId: ATTEMPT_ID, launchReady: true,
        provisioner: { configured: true, ready: true } },
    },
  };
}

function plan(input: { id: number; name: string; cores: number; memory: number; disk: number;
  architecture?: "x86" | "arm"; available?: boolean; cpuType?: "shared" | "dedicated"; monthly?: string }) {
  const currency = "EUR";
  return {
    id: input.id, name: input.name, description: input.name.toUpperCase(), cores: input.cores,
    memoryGb: input.memory, diskGb: input.disk, cpuType: input.cpuType ?? "shared",
    architecture: input.architecture ?? "x86", deprecated: false,
    locations: [{ name: "fsn1", available: input.available ?? true, recommended: true, deprecated: false }],
    prices: [{ location: "fsn1", monthly: { currency, net: "1", gross: input.monthly ?? "10" },
      hourly: { currency, net: "0.01", gross: "0.02" }, includedTrafficBytes: 1,
      additionalTrafficPerTb: { currency, net: "1", gross: "1.19" } }],
  };
}

function catalog(): HetznerCloudOfferCatalogDto {
  return {
    fetchedAt: NOW, currency: "EUR", vatRate: "19", serverTypes: [
      plan({ id: 1, name: "cpx22", cores: 2, memory: 4, disk: 80, monthly: "5.95" }),
      plan({ id: 2, name: "cpx32", cores: 4, memory: 8, disk: 160, monthly: "11.90" }),
      plan({ id: 3, name: "arm32", cores: 4, memory: 8, disk: 160, architecture: "arm" }),
      plan({ id: 4, name: "too-small-disk", cores: 4, memory: 8, disk: 40 }),
      plan({ id: 5, name: "too-large", cores: 16, memory: 64, disk: 320 }),
      plan({ id: 6, name: "unavailable", cores: 4, memory: 8, disk: 160, available: false }),
      plan({ id: 7, name: "over-price", cores: 8, memory: 32, disk: 320, monthly: "45.01" }),
    ], locations: [], primaryIpPrices: [], images: [],
    simpleModePolicy: { cpuType: "shared", minCores: 2, minMemoryGb: 4, maxCores: 8, maxMemoryGb: 32,
      maxDiskGb: 320, maxMonthlyGrossByCurrency: [{ currency: "EUR", amount: "45.00" }, { currency: "USD", amount: "50.00" }] },
    billing: { model: "hourly-with-monthly-cap", partialHoursRoundedUp: true, poweredOffStillBilled: true,
      primaryIpLifecycle: "primary_ips_are_separate_billable_resources_until_deleted",
      trafficOverage: "included_traffic_and_overage_depend_on_server_type_and_location" },
    capabilities: { inventory: true, offerCatalog: true, createCapacity: true, deleteCapacity: true,
      supportedIsolationDrivers: ["provider-vm"], supportedIsolationClasses: ["provider-vm"],
      connectionRevisionRequired: true, explicitBillingConfirmationRequired: true },
  } as unknown as HetznerCloudOfferCatalogDto;
}

function server(type: "source" | "target" = "source", status: HetznerServer["status"] = "off"): HetznerServer {
  const target = type === "target";
  const original = originalQuote();
  return {
    id: 42, name: "hivra-owned", status, public_net: {
      ipv4: { id: 43, ip: "203.0.113.10" }, ipv6: { id: 44, ip: "2001:db8::/64" },
      floating_ips: [], firewalls: [{ id: 91, status: "applied" }],
    }, created: NOW,
    labels: { "hivra-operation": ALLOCATION_ID, "hivra-managed": "true" }, locked: false,
    backup_window: null, volumes: [], primary_disk_size: 80, rescue_enabled: false, iso: null,
    private_net: [], protection: { delete: false, rebuild: false }, load_balancers: [], placement_group: null,
    server_type: { id: target ? 2 : 1, name: target ? "cpx32" : "cpx22", description: null,
      cores: target ? 4 : 2, memory: target ? 8 : 4, disk: target ? 160 : 80,
      cpu_type: "shared", architecture: "x86", deprecated: null, locations: [] },
    image: { id: original.image.id, type: original.image.type, status: "available", name: original.image.name,
      description: original.image.description, image_size: 2, disk_size: 10, created: NOW, deleted: null,
      created_from: null, bound_to: null, architecture: original.image.architecture,
      os_flavor: original.image.osFlavor, os_version: original.image.osVersion, deprecated: null },
    location: { id: 1, name: "fsn1", description: "FSN", city: "Falkenstein", country: "DE", latitude: 0,
      longitude: 0, network_zone: "eu-central" },
  } as HetznerServer;
}

function quote(): ProviderResizeQuote {
  return {
    operationId: OPERATION_ID, quoteFingerprint: "d".repeat(64), agentId: AGENT_ID, providerServerId: "42",
    location: "fsn1", existingDiskGb: 80, upgradeDisk: false, observedAt: NOW,
    expiresAt: "2026-09-04T14:05:00.000Z", downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
    source: { serverTypeId: 1, serverType: "cpx22", architecture: "x86", cores: 2, memoryGb: 4, advertisedDiskGb: 80,
      cpuType: "shared", price: { currency: "EUR", hourlyGross: "0.02", monthlyGross: "5.95" } },
    target: { serverTypeId: 2, serverType: "cpx32", architecture: "x86", cores: 4, memoryGb: 8, advertisedDiskGb: 160,
      cpuType: "shared", price: { currency: "EUR", hourlyGross: "0.02", monthlyGross: "11.90" } },
  };
}

function operation(stage: StoredProviderResizeOperation["stage"]): StoredProviderResizeOperation {
  const owner = authority();
  if (["dispatch_pending","request_uncertain","action_pending","provider_pending","manual_attention"].includes(stage)) {
    owner.agent.status = "provisioning"; owner.agent.operation_id = OPERATION_ID; owner.agent.operation_kind = "resize";
    owner.agent.operation_started_at = NOW;
  }
  return { input: { userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID }, authority: owner,
    stage, sourceShapeFingerprint: "c".repeat(64), planFingerprint: "e".repeat(64), quote: quote(),
    billingConfirmedAt: stage === "quoted" ? null : NOW,
    dispatchNotAfter: stage === "quoted" ? null : "2026-09-04T14:00:45.000Z",
    providerPostAttemptedAt: ["quoted","dispatch_pending"].includes(stage) ? null : NOW,
    action: null, shutdownAttemptedAt: null, shutdownAction: null, serverAbsentAt: null,
    shutdownWaitStartedAt: null, shutdownReadiness: null,
    observation: null, completedAt: null, failureCode: null };
}

function harness() {
  let current = operation("quoted");
  let elapsed = 0;
  const provider = {
    getServer: jest.fn(async () => server()), getAction: jest.fn(),
    changeServerType: jest.fn(async () => ({ id: 701, command: "change_server_type", status: "running",
      resources: [{ id: 42, type: "server" }] } as HetznerAction)),
  } as unknown as HetznerCloudProjectClient;
  const power = {
    getServer: jest.fn(),
    dispatch: jest.fn(async () => ({ id: 702, command: "shutdown_server" as const, status: "running" as const,
      resources: [{ id: 42, type: "server" as const }] })),
    getAction: jest.fn(async () => ({ id: 702, command: "shutdown_server" as const, status: "success" as const,
      resources: [{ id: 42, type: "server" as const }] })),
  };
  const deps = {
    now: () => new Date(NOW), monotonicNow: () => elapsed,
    authority: jest.fn(async () => authority()), active: jest.fn(async () => null),
    load: jest.fn(async () => current), catalog: jest.fn(async () => catalog()),
    secret: jest.fn(async () => ({ connection: { id: CONNECTION_ID, status: "ready" }, revision: 7, apiToken: "owner-token" } as never)),
    client: jest.fn(() => provider), createQuote: jest.fn(async () => "created" as const),
    powerClient: jest.fn(() => power),
    absenceClient: jest.fn(() => ({ getServer: jest.fn(async (): Promise<HetznerServer | null> => null) })),
    recordAbsent: jest.fn(async () => true),
    beginShutdown: jest.fn(async () => { current.shutdownAttemptedAt = NOW; return "dispatch" as const; }),
    inspectReadiness: jest.fn(async () => ({ observedAt: NOW, hostFingerprintSha256: `SHA256:${"A".repeat(43)}`,
      receipt: { version: 1 as const, ready: true as const, bootId: TARGET_ID, powerHandlerPid: 649 } })),
    recordReadiness: jest.fn(async (_input: unknown, readiness: StoredProviderResizeOperation["shutdownReadiness"]) => {
      current.shutdownWaitStartedAt ??= NOW; current.shutdownReadiness = readiness; return true;
    }),
    recordShutdown: jest.fn(async (_input: unknown, action: HetznerAction) => { current.shutdownAction = action; return true; }),
    claim: jest.fn(async () => "dispatch" as const),
    begin: jest.fn(async () => { current.stage = "request_uncertain"; current.providerPostAttemptedAt = NOW; return "dispatch" as const; }),
    recordAction: jest.fn(async (_input: unknown, action: HetznerAction) => { current.action = action; current.stage = "action_pending"; return true; }),
    recordObservation: jest.fn(async (_input: unknown, observation: StoredProviderResizeOperation["observation"], stage: StoredProviderResizeOperation["stage"]) => {
      current.observation = observation; current.stage = stage; return true;
    }),
    complete: jest.fn(async () => { current.stage = "succeeded"; current.completedAt = NOW; return true; }),
    fail: jest.fn(async () => { current.stage = "failed"; current.completedAt = NOW; return true; }),
    cancel: jest.fn(async () => { current.stage = "cancelled"; current.completedAt = NOW; return true; }),
  };
  return { deps, provider, power, get current() { return current; }, set current(value) { current = value; }, advance(ms: number) { elapsed = ms; } };
}

it("advertises only live, available, same-architecture plans within policy that retain the existing disk", async () => {
  const h = harness();
  const result = await getProviderResizeCatalog("owner", AGENT_ID, h.deps);
  expect(result.offers.map((offer) => offer.serverType)).toEqual(["cpx32"]);
  expect(result).toMatchObject({ providerPowerState: "off", existingDiskGb: 80, upgradeDisk: false,
    requiresPowerOff: true, downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE });
});

it("preserves the busy classification without consulting provider credentials or pricing", async () => {
  const h = harness();
  h.deps.authority.mockRejectedValue(new ProviderAgentResizeStoreError("computer_busy"));
  await expect(getProviderResizeCatalog("owner", AGENT_ID, h.deps))
    .rejects.toMatchObject({ code: "computer_busy" });
  expect(h.deps.secret).not.toHaveBeenCalled();
  expect(h.deps.catalog).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});
it("excludes a 4 GiB resize target for desktop while preserving agent offers",async()=>{
  const h=harness(),a=authority();a.agent.type="linux-desktop";
  h.deps.authority.mockResolvedValue(a);
  const offers=catalog();offers.serverTypes.push(plan({id:8,name:"small-alternative",cores:2,memory:4,disk:80}));
  h.deps.catalog.mockResolvedValue(offers);
  expect((await getProviderResizeCatalog("owner",AGENT_ID,h.deps)).offers.map(o=>o.serverType)).toEqual(["cpx32"]);
  a.agent.type="codex";
  expect((await getProviderResizeCatalog("owner",AGENT_ID,h.deps)).offers.map(o=>o.serverType)).toContain("small-alternative");
});
it("cancels an undersized undispatched desktop quote before provider access",async()=>{
  const h=harness();h.current=operation("dispatch_pending");h.current.authority.agent.type="linux-desktop";
  h.current.quote.target.memoryGb=4;
  h.deps.cancel.mockImplementation(async()=>{h.current.stage="cancelled";return true;});
  expect((await advanceProviderResize({userId:"owner",agentId:AGENT_ID,operationId:OPERATION_ID},"dispatch",h.deps)).stage).toBe("cancelled");
  expect(h.deps.cancel).toHaveBeenCalledWith(expect.any(Object),"target_below_runtime_floor");
  expect(h.deps.secret).not.toHaveBeenCalled();expect(h.deps.begin).not.toHaveBeenCalled();
});

it("creates a fresh billing-and-downtime quote and rejects a powered-on computer", async () => {
  const h = harness();
  h.deps.load.mockRejectedValueOnce(new ProviderAgentResizeStoreError("not_found"));
  const result = await quoteProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    targetServerType: "cpx32" }, h.deps);
  expect(result).toMatchObject({ upgradeDisk: false, existingDiskGb: 80,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION, downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE });
  expect(h.deps.createQuote).toHaveBeenCalledWith(expect.objectContaining({ operationId: OPERATION_ID }));

  h.deps.load.mockRejectedValueOnce(new ProviderAgentResizeStoreError("not_found"));
  (h.provider.getServer as jest.Mock).mockResolvedValueOnce(server("source", "running"));
  await expect(quoteProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    targetServerType: "cpx32" }, h.deps)).rejects.toEqual(expect.objectContaining({ code: "computer_must_be_stopped" }));
});

it("replays the exact durable quote without another provider or catalog request", async () => {
  const h = harness();
  await expect(quoteProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    targetServerType: "cpx32" }, h.deps)).resolves.toEqual(quote());
  expect(h.deps.authority).not.toHaveBeenCalled();
  expect(h.deps.secret).not.toHaveBeenCalled();
  expect(h.provider.getServer).not.toHaveBeenCalled();
});

it("rejects an expired or changed live plan before claiming billing authority", async () => {
  const h = harness();
  await expect(applyProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    quoteFingerprint: quote().quoteFingerprint, billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION }, h.deps))
    .rejects.toEqual(expect.objectContaining({ code: "quote_changed" }));
  expect(h.deps.claim).not.toHaveBeenCalled();

  h.deps.now = () => new Date("2026-09-04T14:05:00.000Z");
  await expect(applyProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    quoteFingerprint: quote().quoteFingerprint, billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION }, h.deps))
    .rejects.toEqual(expect.objectContaining({ code: "quote_expired" }));
});

it("marks an ambiguous provider POST once and never repeats that mutation on replay", async () => {
  const h = harness(); h.current = operation("dispatch_pending");
  (h.provider.changeServerType as jest.Mock).mockRejectedValueOnce(new Error("private-provider-detail"));
  const request = { userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    quoteFingerprint: quote().quoteFingerprint, billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION };
  await expect(applyProviderResize(request, h.deps)).resolves.toMatchObject({ stage: "request_uncertain" });
  await expect(applyProviderResize(request, h.deps)).resolves.toMatchObject({ stage: "request_uncertain" });
  expect(h.deps.begin).toHaveBeenCalledTimes(1);
  expect(h.provider.changeServerType).toHaveBeenCalledTimes(1);
  expect(h.deps.begin.mock.invocationCallOrder[0]).toBeLessThan((h.provider.changeServerType as jest.Mock).mock.invocationCallOrder[0]);
  expect(h.deps.complete).not.toHaveBeenCalled();
});

it.each(["primary IP", "image"])("rejects changed original %s identity before dispatch and terminal completion", async changedField => {
  const alter = (value: HetznerServer) => {
    if (changedField === "primary IP") {
      value.public_net.ipv4 = { id: 999, ip: "203.0.113.99" };
    } else {
      value.image!.id = 999;
    }
    return value;
  };

  const before = harness(); before.current = operation("dispatch_pending");
  (before.provider.getServer as jest.Mock).mockResolvedValue(alter(server("source")));
  await expect(advanceProviderResize(before.current.input, "dispatch", before.deps))
    .rejects.toEqual(expect.objectContaining({ code: "operation_conflict" }));
  expect(before.deps.begin).not.toHaveBeenCalled();
  expect(before.provider.changeServerType).not.toHaveBeenCalled();

  const after = harness(); after.current = operation("request_uncertain");
  (after.provider.getServer as jest.Mock).mockResolvedValue(alter(server("target")));
  await expect(advanceProviderResize(after.current.input, "observe", after.deps))
    .rejects.toEqual(expect.objectContaining({ code: "operation_conflict" }));
  expect(after.deps.complete).not.toHaveBeenCalled();
  expect(after.provider.changeServerType).not.toHaveBeenCalled();
});

it("cancels a saved pre-dispatch resize when deletion wins without calling Hetzner", async () => {
  const h = harness(); h.current = operation("dispatch_pending"); h.current.authority.agent.desired_state = "deleted";
  await expect(advanceProviderResize(h.current.input, "cancel_if_undispatched", h.deps))
    .resolves.toMatchObject({ stage: "cancelled" });
  expect(h.deps.cancel).toHaveBeenCalledWith(h.current.input, "delete_requested");
  expect(h.deps.secret).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("publishes success only after the exact action and actual server type, capacity, power, and retained disk agree", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "running", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockResolvedValue({ ...h.current.action, status: "success" });
  (h.provider.getServer as jest.Mock).mockResolvedValue(server("target"));
  await expect(advanceProviderResize(h.current.input, "observe", h.deps)).resolves.toMatchObject({ stage: "succeeded" });
  expect(h.deps.recordObservation).toHaveBeenCalledWith(h.current.input,
    expect.objectContaining({ serverTypeId: 2, serverType: "cpx32", architecture: "x86", cores: 4,
      memoryGb: 8, advertisedDiskGb: 160, cpuType: "shared", diskGb: 80, providerStatus: "off" }),
    "provider_pending");
  expect(h.deps.complete).toHaveBeenCalledTimes(1);
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("keeps an observed change_server_type action pending during provider migration without another dispatch", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "running", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockResolvedValue(h.current.action);
  (h.provider.getServer as jest.Mock).mockResolvedValue({ ...server("source"), status: "migrating" });
  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "action_pending", providerActionId: 701 });
  expect(h.deps.recordAction).toHaveBeenCalledWith(h.current.input, h.current.action);
  expect(h.provider.getServer).not.toHaveBeenCalled();
  expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("does not claim the promised stopped result when Hetzner returns the resized server running", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "running", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockResolvedValue({ ...h.current.action, status: "success" });
  (h.provider.getServer as jest.Mock).mockResolvedValue({ ...server("target"), status: "running" });
  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "provider_pending", providerActionId: 701, shutdownRequired: true });
  expect(h.deps.beginShutdown).not.toHaveBeenCalled();
  expect(h.deps.powerClient).not.toHaveBeenCalled();
  expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

function resizedRunning() {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "success", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockResolvedValue(h.current.action);
  (h.provider.getServer as jest.Mock).mockResolvedValue({ ...server("target"), status: "running" });
  return h;
}

it("releases only a dispatched resize with explicit delete intent and fresh original server absence", async () => {
  const h = resizedRunning(); h.current.authority.agent.desired_state = "deleted";
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).resolves.toBe(true);
  expect(h.deps.absenceClient).toHaveBeenCalledWith("owner-token");
  expect(h.deps.recordAbsent).toHaveBeenCalledWith(h.current.input, "42", NOW);
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
  expect(h.power.dispatch).not.toHaveBeenCalled();
});

it("cannot use absent-server recovery without delete intent or before dispatch", async () => {
  const h = resizedRunning();
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).resolves.toBe(false);
  h.current.authority.agent.desired_state = "deleted"; h.current.providerPostAttemptedAt = null;
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).resolves.toBe(false);
  expect(h.deps.secret).not.toHaveBeenCalled(); expect(h.deps.recordAbsent).not.toHaveBeenCalled();
});

it("retains resize ownership for present servers, unreadable absence, rotated credentials and rejected persistence", async () => {
  const h = resizedRunning(); h.current.authority.agent.desired_state = "deleted";
  h.deps.absenceClient.mockReturnValueOnce({ getServer: jest.fn(async () => server("target")) });
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).resolves.toBe(false);
  h.deps.absenceClient.mockReturnValueOnce({ getServer: jest.fn(async () => { throw new Error("unavailable"); }) });
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).rejects.toThrow();
  expect(h.deps.recordAbsent).not.toHaveBeenCalled();
  h.deps.secret.mockResolvedValueOnce({ connection: { id: CONNECTION_ID, status: "ready" }, revision: 8, apiToken: "rotated" } as never);
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).rejects.toMatchObject({ code: "operation_conflict" });
  h.deps.recordAbsent.mockResolvedValueOnce(false);
  await expect(reconcileAbsentProviderResizeForDelete(h.current.input, h.deps)).rejects.toMatchObject({ code: "operation_unverified" });
});

it("continues the saved resize with one shutdown and completes only after its receipt and stopped state agree", async () => {
  const h = resizedRunning();
  await expect(advanceProviderResize(h.current.input, "dispatch", h.deps))
    .resolves.toMatchObject({ stage: "provider_pending", shutdownRequired: false });
  expect(h.deps.beginShutdown).toHaveBeenCalledTimes(1);
  expect(h.power.dispatch).toHaveBeenCalledWith({ serverId: 42, kind: "stop" });
  expect(h.deps.recordShutdown).toHaveBeenCalledWith(h.current.input,
    expect.objectContaining({ id: 702, command: "shutdown_server" }));
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  expect(h.deps.complete).not.toHaveBeenCalled();
  (h.provider.getServer as jest.Mock).mockResolvedValue(server("target"));
  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "succeeded" });
  expect(h.power.dispatch).toHaveBeenCalledTimes(1);
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("does not consume shutdown while the guest is booting and continues only after fresh readiness", async () => {
  const h = resizedRunning();
  h.deps.inspectReadiness.mockResolvedValueOnce({ observedAt: NOW, hostFingerprintSha256: `SHA256:${"A".repeat(43)}`,
    receipt: { version: 1, ready: false } } as never);
  await expect(advanceProviderResize(h.current.input, "dispatch", h.deps)).resolves.toMatchObject({
    shutdownRequired: false, shutdownReadinessWaiting: true });
  expect(h.current.shutdownAttemptedAt).toBeNull(); expect(h.power.dispatch).not.toHaveBeenCalled();
  expect(h.current.shutdownWaitStartedAt).toBe(NOW);
  await expect(advanceProviderResize(h.current.input, "observe", h.deps)).resolves.toMatchObject({ shutdownRequired: true });
  expect(h.power.dispatch).not.toHaveBeenCalled();
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  expect(h.deps.beginShutdown).toHaveBeenCalledWith(h.current.input, expect.objectContaining({
    bootId: TARGET_ID, powerHandlerPid: 649, observedAt: NOW }));
  expect(h.power.dispatch).toHaveBeenCalledTimes(1);
});

it("clears unavailable readiness without sending power and stops probing at the durable deadline", async () => {
  const h = resizedRunning(); h.deps.inspectReadiness.mockRejectedValue(new Error("early SSH unavailable"));
  await expect(advanceProviderResize(h.current.input, "dispatch", h.deps)).resolves.toMatchObject({ shutdownReadinessWaiting: true });
  expect(h.current.shutdownReadiness).toBeNull(); expect(h.deps.beginShutdown).not.toHaveBeenCalled();
  h.deps.now = () => new Date(Date.parse(NOW) + 120_000);
  h.deps.recordReadiness.mockImplementationOnce(async () => { h.current.stage = "manual_attention"; return false; });
  await expect(advanceProviderResize(h.current.input, "observe", h.deps)).resolves.toMatchObject({ stage: "manual_attention" });
  expect(h.deps.inspectReadiness).toHaveBeenCalledTimes(1);
  expect(h.power.dispatch).not.toHaveBeenCalled(); expect(h.current.shutdownWaitStartedAt).toBe(NOW);
});

it("cannot use readiness after the journal refuses it", async () => {
  const h = resizedRunning(); h.current.shutdownWaitStartedAt = NOW;
  h.deps.recordReadiness.mockResolvedValueOnce(false);
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  expect(h.deps.beginShutdown).not.toHaveBeenCalled(); expect(h.power.dispatch).not.toHaveBeenCalled();
});

it("retains the one-use marker but sends no power when readiness ages out during the final provider read", async () => {
  const h = resizedRunning();
  let wallTime = Date.parse(NOW); h.deps.now = () => new Date(wallTime);
  (h.provider.getServer as jest.Mock).mockResolvedValueOnce({ ...server("target"), status: "running" })
    .mockImplementationOnce(async () => {
      wallTime += 15_000;
      return { ...server("target"), status: "running" };
    });
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  expect(h.current.shutdownAttemptedAt).toBe(NOW); expect(h.power.dispatch).not.toHaveBeenCalled();
});

it("does not repeat an uncertain shutdown or unlock a stopped computer without its original receipt", async () => {
  const h = resizedRunning(); h.power.dispatch.mockRejectedValue(new Error("response lost"));
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  (h.provider.getServer as jest.Mock).mockResolvedValue(server("target"));
  await advanceProviderResize(h.current.input, "dispatch", h.deps);
  expect(h.power.dispatch).toHaveBeenCalledTimes(1);
  expect(h.deps.complete).not.toHaveBeenCalled();
  h.deps.now = () => new Date(Date.parse(NOW) + 120_000);
  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "manual_attention" });
});

it("compares stable provider state rather than timestamps generated during the final shutdown read", async () => {
  const h = resizedRunning();
  const original = Date.prototype.toISOString;
  let tick = 0;
  const clock = jest.spyOn(Date.prototype, "toISOString").mockImplementation(() =>
    original.call(new Date(Date.parse(NOW) + tick++)));
  try {
    await advanceProviderResize(h.current.input, "dispatch", h.deps);
    expect(h.power.dispatch).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});

it("will not shut down after deletion intent wins or the atomic grant is declined", async () => {
  const deleted = resizedRunning(); deleted.current.authority.agent.desired_state = "deleted";
  await advanceProviderResize(deleted.current.input, "dispatch", deleted.deps);
  expect(deleted.deps.beginShutdown).not.toHaveBeenCalled();
  expect(deleted.power.dispatch).not.toHaveBeenCalled();
  const declined = resizedRunning(); declined.deps.beginShutdown.mockResolvedValueOnce("rejected" as never);
  await advanceProviderResize(declined.current.input, "dispatch", declined.deps);
  expect(declined.power.dispatch).not.toHaveBeenCalled();
});

it("retains the marker without dispatch when the final provider read changes or the local fence expires", async () => {
  const changed = resizedRunning();
  (changed.provider.getServer as jest.Mock)
    .mockResolvedValueOnce({ ...server("target"), status: "running" })
    .mockResolvedValueOnce({ ...server("target"), primary_disk_size: 160, status: "running" });
  await advanceProviderResize(changed.current.input, "dispatch", changed.deps);
  expect(changed.current.shutdownAttemptedAt).toBe(NOW);
  expect(changed.power.dispatch).not.toHaveBeenCalled();
  const expired = resizedRunning();
  expired.deps.beginShutdown.mockImplementationOnce(async () => {
    expired.current.shutdownAttemptedAt = NOW; expired.advance(30_000); return "dispatch";
  });
  await expect(advanceProviderResize(expired.current.input, "dispatch", expired.deps))
    .rejects.toMatchObject({ code: "operation_unverified" });
  expect(expired.power.dispatch).not.toHaveBeenCalled();
});

it("reconciles the exact bound target when an existing action receipt can no longer be read", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "running", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockRejectedValue(new Error("action aged out"));
  (h.provider.getServer as jest.Mock).mockResolvedValue(server("target"));

  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "succeeded", providerActionId: 701 });
  expect(h.deps.complete).toHaveBeenCalledTimes(1);
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("preserves an explicit action error and fails only when the original server is exactly restored", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "error", resources: [{ id: 42, type: "server" }] };
  (h.provider.getServer as jest.Mock).mockResolvedValue(server("source"));

  await expect(advanceProviderResize(h.current.input, "observe", h.deps))
    .resolves.toMatchObject({ stage: "failed", providerActionStatus: "error" });
  expect(h.provider.getAction).not.toHaveBeenCalled();
  expect(h.deps.fail).toHaveBeenCalledWith(h.current.input, "provider_action_failed");
  expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("retains manual attention when a successful action and actual capacity disagree", async () => {
  const h = harness(); h.current = operation("action_pending");
  h.current.action = { id: 701, command: "change_server_type", status: "running", resources: [{ id: 42, type: "server" }] };
  (h.provider.getAction as jest.Mock).mockResolvedValue({ ...h.current.action, status: "success" });
  (h.provider.getServer as jest.Mock).mockResolvedValue({ ...server("target"), primary_disk_size: 160 });
  await expect(advanceProviderResize(h.current.input, "observe", h.deps)).resolves.toMatchObject({ stage: "manual_attention" });
  expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.deps.fail).not.toHaveBeenCalled();
});

it("fails closed on a cross-owner journal lookup instead of discovering or mutating a server", async () => {
  const h = harness(); h.deps.load.mockRejectedValue(new ProviderAgentResizeStoreError("not_found"));
  h.deps.authority.mockRejectedValue(new ProviderAgentResizeStoreError("not_found"));
  await expect(quoteProviderResize({ userId: "foreign", agentId: AGENT_ID, operationId: OPERATION_ID,
    targetServerType: "cpx32" }, h.deps)).rejects.toEqual(expect.objectContaining({ code: "not_found" }));
  expect(h.deps.secret).not.toHaveBeenCalled();
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("never dispatches after the bounded local fence expires", async () => {
  const h = harness(); h.current = operation("dispatch_pending");
  h.deps.begin.mockImplementation(async () => { h.current.stage = "request_uncertain"; h.advance(30_000); return "dispatch"; });
  await expect(advanceProviderResize(h.current.input, "dispatch", h.deps))
    .rejects.toEqual(expect.objectContaining({ code: "operation_unverified" }));
  expect(h.provider.changeServerType).not.toHaveBeenCalled();
});

it("uses one revision-bound owner token client for both catalog and server reads", async () => {
  const h = harness();
  process.env.HETZNER_API_TOKEN = "ambient-token";
  await getProviderResizeCatalog("owner", AGENT_ID, h.deps);
  expect(h.deps.secret).toHaveBeenCalledTimes(1);
  expect(h.deps.secret).toHaveBeenCalledWith("owner", CONNECTION_ID, { requireBoundToken: true });
  expect(h.deps.client).toHaveBeenCalledWith("owner-token");
  expect(h.deps.client).toHaveBeenCalledTimes(1);
  expect(h.deps.client).not.toHaveBeenCalledWith("ambient-token");
  expect(h.deps.catalog).toHaveBeenCalledWith(h.provider, NOW);
  expect(h.provider.getServer).toHaveBeenCalledWith(42);
  delete process.env.HETZNER_API_TOKEN;
});

it("rejects a rotated connection revision before constructing a catalog or server client", async () => {
  const h = harness();
  h.deps.secret.mockResolvedValue({
    connection: { id: CONNECTION_ID, status: "ready" }, revision: 8, apiToken: "rotated-token",
  } as never);

  await expect(getProviderResizeCatalog("owner", AGENT_ID, h.deps))
    .rejects.toEqual(expect.objectContaining({ code: "operation_conflict" }));
  expect(h.deps.client).not.toHaveBeenCalled();
  expect(h.deps.catalog).not.toHaveBeenCalled();
  expect(h.provider.getServer).not.toHaveBeenCalled();
});

it("requires the exact explicit billing confirmation", async () => {
  const h = harness();
  await expect(applyProviderResize({ userId: "owner", agentId: AGENT_ID, operationId: OPERATION_ID,
    quoteFingerprint: quote().quoteFingerprint, billingConfirmation: "yes" }, h.deps))
    .rejects.toEqual(expect.objectContaining<Partial<ProviderAgentResizeError>>({ code: "operation_conflict" }));
  expect(h.deps.load).not.toHaveBeenCalled();
});
