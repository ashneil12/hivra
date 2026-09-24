import { createHash } from "node:crypto";
import { utils as ssh2Utils } from "ssh2";

import { HetznerCloudApiError, type HetznerPricing } from "@/lib/hetzner/client";

import { InfrastructureConnectionStoreError } from "../connection-store";
import { HetznerCloudCapacityQuoteDtoSchema } from "../contracts";
import type { StoredHetznerCloudCapacityOrder } from "../hetzner-cloud-store";
import { createHetznerCreationReceipt } from "../hetzner-creation-receipt";
import {
  connectHetznerCloudProject,
  createHetznerCloudCapacity,
  createPreparedHetznerCloudCapacity,
  generateHetznerBootstrapBundle,
  generateHetznerWriteCheckKey,
  getHetznerCloudOfferCatalog,
  HetznerCloudConnectionError,
  HetznerCloudCapacityError,
  HetznerCloudTokenCheckError,
  quoteHetznerCloudCapacity,
  refreshHetznerCloudInventory,
  replaceHetznerCloudToken,
} from "../hetzner-cloud";

const NOW = new Date("2026-08-26T15:00:00.000Z");
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "project-scoped-owner-token-value";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_BOOTSTRAP_KEY = generateHetznerBootstrapBundle({
  userId: "user_a",
  connectionId: CONNECTION_ID,
  connectionRevision: 7,
  orderId: QUOTE_ID,
  quoteFingerprintSha256: "a".repeat(64),
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const server = {
  id: 42,
  name: "ash-dev-box",
  status: "running" as const,
  public_net: {
    ipv4: { id: 88, ip: "203.0.113.10" },
    ipv6: { id: 89, ip: "2001:db8::/64" },
    floating_ips: [],
  },
  created: "2026-08-20T12:00:00+00:00",
  volumes: [],
  primary_disk_size: 80,
  rescue_enabled: false,
  iso: null,
  private_net: [],
  locked: false,
  protection: { delete: false, rebuild: false },
  load_balancers: [],
  placement_group: null,
  server_type: {
    id: 104,
    name: "cpx22",
    description: "CPX 22",
    cores: 2,
    memory: 4,
    disk: 80,
    cpu_type: "shared" as const,
    architecture: "x86" as const,
  },
  location: {
    id: 1,
    name: "fsn1",
    city: "Falkenstein",
    country: "de",
    network_zone: "eu-central",
  },
};

function projectClient(overrides: Record<string, unknown> = {}) {
  return {
    listServers: jest.fn().mockResolvedValue([server]),
    findServersByName: jest.fn().mockResolvedValue([]),
    listServerTypes: jest.fn().mockResolvedValue([]),
    listLocations: jest.fn().mockResolvedValue([]),
    listSystemImages: jest.fn().mockResolvedValue([]),
    listSshKeys: jest.fn().mockResolvedValue([]),
    findSshKeysByName: jest.fn().mockResolvedValue([]),
    getPricing: jest.fn().mockResolvedValue({
      currency: "EUR",
      vat_rate: "19.00",
      primary_ips: [],
      server_types: [],
    }),
    createSshKey: jest.fn(),
    deleteSshKey: jest.fn(),
    createServer: jest.fn(),
    getAction: jest.fn(),
    getServer: jest.fn(),
    changeServerType: jest.fn(),
    ...overrides,
  };
}

const WRITE_CHECK_PROBE = {
  name: "hivra-check-0123456789ab",
  publicKey: `ssh-ed25519 ${"A".repeat(68)} hivra-check`,
};

/** A fake project whose token can write: the probe key is created with id 901
 * and can be deleted again. */
function writeCheckClient(overrides: Record<string, unknown> = {}) {
  return projectClient({
    createSshKey: jest.fn().mockImplementation(async (input: { name: string; publicKey: string; labels: Record<string, string> }) => ({
      id: 901,
      name: input.name,
      fingerprint: "00:11",
      public_key: input.publicKey,
      labels: input.labels,
      created: NOW.toISOString(),
    })),
    deleteSshKey: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

type FixtureGuestImage = { osVersion: string | null; architecture: "x86" | "arm" };
const capacityOnlyImage: FixtureGuestImage = { osVersion: "24.04", architecture: "x86" };

function capacityClient(overrides: Record<string, unknown> = {}, image: FixtureGuestImage = capacityOnlyImage) {
  return projectClient({
    listServers: jest.fn().mockResolvedValue([]),
    listServerTypes: jest.fn().mockResolvedValue([{
      id: 104,
      name: "cpx22",
      description: "CPX 22",
      cores: 2,
      memory: 4,
      disk: 80,
      cpu_type: "shared",
      architecture: image.architecture,
      deprecated: null,
      locations: [{
        id: 1,
        name: "fsn1",
        available: true,
        recommended: true,
        deprecation: null,
      }],
    }]),
    listLocations: jest.fn().mockResolvedValue([{
      id: 1,
      name: "fsn1",
      city: "Falkenstein",
      country: "de",
      network_zone: "eu-central",
    }]),
    listSystemImages: jest.fn().mockResolvedValue([{
      id: 100,
      type: "system",
      status: "available",
      name: `ubuntu-${image.osVersion ?? "unknown"}`,
      description: `Ubuntu ${image.osVersion ?? "unknown"}`,
      deleted: null,
      created_from: null,
      bound_to: null,
      architecture: image.architecture,
      os_flavor: "ubuntu",
      os_version: image.osVersion,
      deprecated: null,
    }]),
    getPricing: jest.fn().mockResolvedValue({
      currency: "EUR",
      vat_rate: "19.00",
      primary_ips: [
        {
          type: "ipv4",
          prices: [{
            location: "fsn1",
            price_hourly: { net: "0.001", gross: "0.00119" },
            price_monthly: { net: "0.50", gross: "0.595" },
          }],
        },
        {
          type: "ipv6",
          prices: [{
            location: "fsn1",
            price_hourly: { net: "0", gross: "0" },
            price_monthly: { net: "0", gross: "0" },
          }],
        },
      ],
      server_types: [{
        id: 104,
        name: "cpx22",
        prices: [{
          location: "fsn1",
          price_hourly: { net: "0.01", gross: "0.0119" },
          price_monthly: { net: "5.00", gross: "5.95" },
          included_traffic: 21990232555520,
          price_per_tb_traffic: { net: "1.00", gross: "1.19" },
        }],
      }],
    }),
    ...overrides,
  });
}

async function capacityFixture(image: FixtureGuestImage = capacityOnlyImage) {
  let stored: {
    quote: Awaited<ReturnType<typeof quoteHetznerCloudCapacity>>;
    providerLabels: Record<string, string>;
    quoteFingerprintSha256: string;
  } | null = null;
  const quote = await quoteHetznerCloudCapacity(
    "user_a",
    CONNECTION_ID,
    { serverTypeId: 104, locationId: 1, imageId: 100 },
    {
      now: () => NOW,
      newId: () => QUOTE_ID,
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => capacityClient({}, image),
      createQuote: jest.fn(async (input) => {
        stored = {
          quote: input.quote,
          providerLabels: input.providerLabels,
          quoteFingerprintSha256: input.quoteFingerprintSha256,
        };
        return input.quote;
      }),
    },
  );
  const captured = stored!;
  const idempotencyKey = "33333333-3333-4333-8333-333333333333";
  const attemptedAt = "2026-08-26T15:01:00.000Z";
  const bootstrap = {
    version: 2 as const,
    provider: "hetzner-cloud" as const,
    userId: "user_a",
    connectionId: CONNECTION_ID,
    connectionRevision: 7,
    orderId: quote.id,
    quoteFingerprintSha256: captured.quoteFingerprintSha256,
    privateKeyOpenSsh: TEST_BOOTSTRAP_KEY.privateKeyOpenSsh,
    publicKeyOpenSsh: TEST_BOOTSTRAP_KEY.publicKeyOpenSsh,
    publicKeyFingerprint: TEST_BOOTSTRAP_KEY.publicKeyFingerprint,
  };
  const operation = {
    id: quote.id,
    connectionId: CONNECTION_ID,
    idempotencyKey,
    status: "creating" as const,
    providerServerId: null,
    providerActionId: null,
    providerActionCommand: null,
    providerActionStatus: null,
    providerNextActions: [],
    observedServerStatus: null,
    providerObservedAt: null,
    errorCode: null,
    canarySlotHeld: true,
    replayed: false,
    quote,
    createdPoweredOff: false,
    launchReady: false as const,
    launchBlockedReason:
      "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
    createdAt: attemptedAt,
    updatedAt: attemptedAt,
  };
  const order = {
    operation,
    connectionRevision: 7,
    providerLabels: captured.providerLabels,
    quoteFingerprintSha256: captured.quoteFingerprintSha256,
    sshKeyPostAttemptedAt: null,
    providerSshKeyStatus: null,
    providerSshKeyId: null,
    serverPostAttemptedAt: null,
    providerServerStatus: null,
    bootstrapPublicKey: bootstrap.publicKeyOpenSsh,
    bootstrapPublicKeyFingerprint: bootstrap.publicKeyFingerprint,
    creationReceipt: null,
  };
  const exactServer = {
    ...server,
    server_type: { ...server.server_type, architecture: image.architecture },
    name: quote.serverName,
    status: "off" as const,
    labels: captured.providerLabels,
    backup_window: null,
    image: {
      id: 100,
      type: "system" as const,
      status: "available" as const,
      name: `ubuntu-${image.osVersion ?? "unknown"}`,
      description: `Ubuntu ${image.osVersion ?? "unknown"}`,
      image_size: 2,
      disk_size: 10,
      created: "2026-08-20T12:00:00+00:00",
      deleted: null,
      created_from: null,
      bound_to: null,
      os_flavor: "ubuntu",
      os_version: image.osVersion,
      architecture: image.architecture,
    },
  };
  const mainAction = {
    id: 500,
    command: "create_server",
    status: "success" as const,
    resources: [{ id: 42, type: "server" }],
  };
  const nextAction = {
    id: 501,
    command: "create_primary_ip",
    status: "success" as const,
    resources: [{ id: 88, type: "primary_ip" }],
  };
  return {
    quote,
    captured,
    idempotencyKey,
    attemptedAt,
    bootstrap,
    order,
    exactServer,
    mainAction,
    nextAction,
  };
}

describe("capacity provider dispatch deadlines", () => {
  it.each([
    ["ssh", 30_000, false], ["server", 30_000, false],
    ["ssh", 120_001, false], ["server", 120_001, false],
    ["ssh", 1, true], ["server", 1, true],
  ] as const)("does not dispatch %s creation after a delayed marker (elapsed: %s, quote expired: %s)", async (kind, delay, expireQuote) => {
    const f = await capacityFixture();
    const order: StoredHetznerCloudCapacityOrder = kind === "server" ? {
      ...f.order, sshKeyPostAttemptedAt: f.attemptedAt, providerSshKeyStatus: "accepted", providerSshKeyId: "77",
    } : f.order;
    const provider = capacityClient({ createSshKey: jest.fn(), createServer: jest.fn() });
    let elapsed = 0;
    let wallClock = new Date(f.attemptedAt);
    const mark = jest.fn(async () => {
      elapsed = delay;
      if (expireQuote) wallClock = new Date(f.quote.expiresAt);
      return true;
    });
    const recordSshKeyResult = jest.fn().mockResolvedValue(order);
    const recordOrderResult = jest.fn().mockResolvedValue(order);
    let failure: unknown;
    try {
      await createHetznerCloudCapacity("user_a", CONNECTION_ID, {
        quoteId: f.quote.id, idempotencyKey: f.idempotencyKey, spendingConfirmation: "Create server and start billing",
      }, {
        now: () => wallClock, monotonicNow: () => elapsed,
        generateBootstrap: () => f.bootstrap,
        loadQuote: jest.fn().mockResolvedValue({ ...f.captured, connectionRevision: 7 }),
        claimOrder: jest.fn().mockResolvedValue({ outcome: "claimed", execute: true, order }),
        loadSecret: jest.fn().mockResolvedValue({ connection: { id: CONNECTION_ID, status: "ready" }, revision: 7, apiToken: TOKEN }),
        client: () => provider, markSshKeyPostAttempted: mark, markServerPostAttempted: mark,
        recordSshKeyResult, recordOrderResult,
        recordOrderProgress: jest.fn().mockResolvedValue(order), listInventory: jest.fn().mockResolvedValue([]),
      });
    } catch (error) { failure = error; }
    expect(mark).toHaveBeenCalledTimes(1);
    expect(provider.createSshKey).not.toHaveBeenCalled();
    expect(provider.createServer).not.toHaveBeenCalled();
    expect(recordSshKeyResult).not.toHaveBeenCalled();
    expect(recordOrderResult).not.toHaveBeenCalled();
    expect(failure).toMatchObject({ code: expireQuote ? "quote_expired" : "connection_changed" });
  });
});

describe("private prepared capacity creation",()=>{
  const preparation={confirmation:"Prepare this computer for agent launch" as const,callbackOrigin:"https://canary.hermesos.cloud"};
  async function fixture(image: FixtureGuestImage = { osVersion: "22.04", architecture: "x86" }) {
    const f=await capacityFixture(image);
    const order:StoredHetznerCloudCapacityOrder={...f.order,sshKeyPostAttemptedAt:f.attemptedAt,
      providerSshKeyStatus:"accepted",providerSshKeyId:"77"};
    const receipt=createHetznerCreationReceipt(f.exactServer,f.mainAction,[f.nextAction]);
    const accepted={...order,creationReceipt:receipt,serverPostAttemptedAt:f.attemptedAt,providerServerStatus:"accepted" as const,
      operation:{...order.operation,providerServerId:"42",providerActionId:"500",providerActionCommand:"create_server",
        providerActionStatus:"success" as const,providerNextActions:[{id:"501",command:"create_primary_ip",status:"success" as const}],
        observedServerStatus:"off" as const,providerObservedAt:f.attemptedAt}};
    const provider=capacityClient({createServer:jest.fn().mockResolvedValue({server:f.exactServer,action:f.mainAction,nextActions:[f.nextAction]}),
      getServer:jest.fn().mockResolvedValue(f.exactServer),getAction:jest.fn(async id=>id===500?f.mainAction:f.nextAction)}, image);
    const recipe={userData:"fixture prepared user-data",enrollmentExpiresAt:f.quote.expiresAt,
      expectedEnrollment:{attemptId:"44444444-4444-4444-8444-444444444444",verifierSha256:"b".repeat(64),recipeVersion:"2026.08.27.1" as const}};
    const deps={now:()=>new Date(f.attemptedAt),monotonicNow:()=>0,generateBootstrap:()=>f.bootstrap,
      loadBootstrap:jest.fn().mockResolvedValue(f.bootstrap),loadQuote:jest.fn().mockResolvedValue({...f.captured,connectionRevision:7}),
      claimOrder:jest.fn().mockResolvedValue({outcome:"claimed",execute:true,order}),
      loadSecret:jest.fn().mockResolvedValue({connection:{id:CONNECTION_ID,status:"ready"},revision:7,apiToken:TOKEN}),
      client:()=>provider,firstBootRecipe:jest.fn().mockResolvedValue(recipe),firstBootEnrollment:jest.fn().mockResolvedValue(null),
      markSshKeyPostAttempted:jest.fn(async()=>{throw new Error("unexpected new SSH-key admission in prepared-image fixture");}),
      markServerPostAttempted:jest.fn(),markFirstBootServerPost:jest.fn().mockResolvedValue(true),
      recordOrderProgress:jest.fn().mockResolvedValue(accepted),
      recordOrderResult:jest.fn().mockResolvedValue({...accepted,operation:{...accepted.operation,status:"created_off",createdPoweredOff:true}}),
      upsertInventoryServer:jest.fn().mockResolvedValue({}),listInventory:jest.fn().mockResolvedValue([{providerResourceId:"42"}])};
    const request={quoteId:f.quote.id,idempotencyKey:f.idempotencyKey,spendingConfirmation:"Create server and start billing" as const};
    return {...f,order,accepted,provider,recipe,deps,request};
  }
  it.each<FixtureGuestImage>([
    { osVersion: "24.04", architecture: "x86" },
    { osVersion: "26.04", architecture: "x86" },
    { osVersion: "20.04", architecture: "x86" },
    { osVersion: null, architecture: "x86" },
    { osVersion: "22.04.1", architecture: "x86" },
    { osVersion: "22.04", architecture: "arm" },
  ])("rejects unsupported prepared images before any new key, recipe or server: %j", async image => {
    const f = await fixture(image);
    f.deps.claimOrder.mockResolvedValue({ outcome: "claimed", execute: true,
      order: { ...f.order, sshKeyPostAttemptedAt: null, providerSshKeyStatus: null, providerSshKeyId: null } });
    f.deps.recordOrderResult.mockResolvedValue({ ...f.order,
      operation: { ...f.order.operation, status: "provider_rejected", errorCode: "access_setup_failed", canarySlotHeld: false } });
    const result = await createPreparedHetznerCloudCapacity("user_a", CONNECTION_ID, f.request, preparation, f.deps);
    expect(f.deps.recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "provider_rejected", errorCode: "access_setup_failed",
    }));
    expect(result.operation).toMatchObject({ status: "provider_rejected", launchReady: false });
    expect(f.provider.createSshKey).not.toHaveBeenCalled();
    expect(f.provider.createServer).not.toHaveBeenCalled();
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();
    expect(f.deps.markFirstBootServerPost).not.toHaveBeenCalled();
  });
  it("retains capacity-only creation for an image outside the guest installer contract", async () => {
    const f = await fixture(capacityOnlyImage);
    f.deps.markServerPostAttempted.mockResolvedValue(true);
    const result = await createHetznerCloudCapacity("user_a", CONNECTION_ID, f.request, f.deps);
    expect(f.provider.createServer).toHaveBeenCalledTimes(1);
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();
    expect(result.operation).toMatchObject({ status: "created_off", launchReady: false });
  });
  it("does not apply new image admission to a completed original prepared order", async () => {
    const f = await fixture(capacityOnlyImage);
    const original = { ...f.accepted,
      operation: { ...f.accepted.operation, status: "created_off" as const, createdPoweredOff: true } };
    f.deps.claimOrder.mockResolvedValue({ outcome: "replay", execute: false, order: original });
    f.deps.firstBootEnrollment.mockResolvedValue({ phase: "enrolled" } as never);
    const result = await createPreparedHetznerCloudCapacity("user_a", CONNECTION_ID, f.request, preparation, f.deps);
    expect(result.operation.status).toBe("created_off");
    expect(f.deps.recordOrderResult).not.toHaveBeenCalled();
    expect(f.deps.loadSecret).not.toHaveBeenCalled();
    expect(f.provider.createSshKey).not.toHaveBeenCalled();
    expect(f.provider.createServer).not.toHaveBeenCalled();
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();
  });
  it("reconciles an earlier prepared server even after its quote expires and its image is unsupported", async () => {
    const f = await fixture(capacityOnlyImage);
    f.deps.now = () => new Date(Date.parse(f.quote.expiresAt) + 1_000);
    f.deps.claimOrder.mockResolvedValue({ outcome: "replay", execute: false, order: f.accepted });
    f.deps.firstBootEnrollment.mockResolvedValue({ phase: "enrolled" } as never);
    const result = await createPreparedHetznerCloudCapacity("user_a", CONNECTION_ID, f.request, preparation, f.deps);
    expect(result.operation.status).toBe("created_off");
    expect(f.provider.getServer).toHaveBeenCalledWith(42);
    expect(f.provider.createServer).not.toHaveBeenCalled();
    expect(f.provider.createSshKey).not.toHaveBeenCalled();
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();
    expect(f.deps.markFirstBootServerPost).not.toHaveBeenCalled();
  });
  it("uses the separately confirmed original recipe and exact admission, while still creating powered off",async()=>{
    const f=await fixture();const result=await createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,preparation,f.deps);
    expect(f.deps.firstBootRecipe).toHaveBeenCalledWith({...preparation,binding:{userId:"user_a",connectionId:CONNECTION_ID,
      connectionRevision:7,orderId:f.quote.id,quoteFingerprint:f.captured.quoteFingerprintSha256,recipeVersion:"2026.08.27.1"},
      capacityIdempotencyKey:f.idempotencyKey,publicKeyOpenSsh:f.bootstrap.publicKeyOpenSsh});
    expect(f.deps.markFirstBootServerPost).toHaveBeenCalledWith(expect.objectContaining({expectedEnrollment:f.recipe.expectedEnrollment,
      providerSshKeyId:"77",orderId:f.quote.id,idempotencyKey:f.idempotencyKey}));
    expect(f.deps.markServerPostAttempted).not.toHaveBeenCalled();
    expect(f.provider.createServer).toHaveBeenCalledTimes(1);
    expect(f.provider.createServer).toHaveBeenCalledWith(expect.objectContaining({user_data:f.recipe.userData,start_after_create:false}));
    expect(result.operation).toMatchObject({status:"created_off",launchReady:false});
    expect(JSON.stringify(result)).not.toContain(f.recipe.userData);
    expect(JSON.stringify(result)).not.toContain(f.recipe.expectedEnrollment.verifierSha256);
  });
  it.each([false, true])("accepts the exact source image in creation actions without owning it (replay: %s)", async replay => {
    const f = await fixture();
    const action = { ...f.mainAction,
      resources: [{ id: f.quote.image.id, type: "image" }, ...f.mainAction.resources] };
    f.provider.createServer.mockResolvedValue({ server: f.exactServer, action, nextActions: [f.nextAction] });
    f.provider.getAction.mockImplementation(async (id: number) => id === action.id ? action : f.nextAction);
    if (replay) {
      f.deps.now = () => new Date(Date.parse(f.attemptedAt) + 120_001);
      f.deps.claimOrder.mockResolvedValue({ outcome: "replay", execute: false, order: f.accepted });
      f.deps.firstBootEnrollment.mockResolvedValue({ phase: "enrolled" } as never);
    }
    await createPreparedHetznerCloudCapacity("user_a", CONNECTION_ID, f.request, preparation, f.deps);
    expect(f.deps.recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({ status: "created_off" }));
    expect(f.provider.createServer).toHaveBeenCalledTimes(replay ? 0 : 1);
    if (!replay) {
      expect(f.deps.recordOrderProgress).toHaveBeenCalledWith(expect.objectContaining({ creation: {
        expectedRevision: 7,
        receipt: createHetznerCreationReceipt(f.exactServer, f.mainAction, [f.nextAction]),
      } }));
    }
    expect(f.accepted.creationReceipt.action.resources).toEqual([{ id: "42", type: "server" }]);
  });
  it.each(["rejected","delayed","expired"])("never dispatches a server when prepared admission is %s",async failure=>{
    const f=await fixture();
    if(failure==="rejected") f.deps.markFirstBootServerPost.mockResolvedValue(false);
    if(failure==="expired") f.deps.firstBootRecipe.mockResolvedValue({...f.recipe,enrollmentExpiresAt:f.attemptedAt});
    // Dependencies are snapshotted at entry; use a shared elapsed clock.
    let elapsed=0;f.deps.monotonicNow=()=>elapsed;
    if(failure==="delayed") f.deps.markFirstBootServerPost.mockImplementation(async()=>{elapsed=30_000;return true;});
    await expect(createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,preparation,f.deps)).rejects.toMatchObject({
      code:failure==="expired"?"access_setup_failed":"connection_changed"});
    expect(f.provider.createServer).not.toHaveBeenCalled();expect(f.deps.markServerPostAttempted).not.toHaveBeenCalled();
    expect(f.deps.recordOrderResult).not.toHaveBeenCalled();
  });
  it("does not stage, rewrite or re-POST a server from a capacity-only order that already dispatched",async()=>{
    const f=await fixture();f.deps.claimOrder.mockResolvedValue({outcome:"replay",execute:false,
      order:{...f.order,serverPostAttemptedAt:f.attemptedAt}});
    await expect(createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,preparation,f.deps))
      .rejects.toMatchObject({code:"access_setup_failed"});
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();expect(f.deps.loadSecret).not.toHaveBeenCalled();
    expect(f.provider.createServer).not.toHaveBeenCalled();
  });
  it("requires preparation consent before any order or provider access",async()=>{
    const f=await fixture();
    expect(()=>createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,{...preparation,confirmation:"wrong" as never},f.deps))
      .toThrow("access_setup_failed");
    expect(f.deps.claimOrder).not.toHaveBeenCalled();expect(f.deps.loadSecret).not.toHaveBeenCalled();
  });
  it("closes an expired pre-POST quote before opening an expired preparation capability",async()=>{
    const f=await fixture();f.deps.now=()=>new Date(f.quote.expiresAt);
    f.deps.firstBootRecipe.mockRejectedValue(new Error("expired capability must not be opened"));
    await createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,preparation,f.deps);
    expect(f.deps.recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({status:"provider_rejected",errorCode:"quote_expired"}));
    expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();expect(f.provider.createServer).not.toHaveBeenCalled();
  });
  it("reconciles a lost SSH-key acknowledgement before attempting any preparation",async()=>{
    const f=await fixture(capacityOnlyImage);const attemptedAt=new Date(Date.parse(f.attemptedAt)-120_000).toISOString();
    const unresolved={...f.order,sshKeyPostAttemptedAt:attemptedAt,providerSshKeyStatus:"ambiguous",providerSshKeyId:null,
      operation:{...f.order.operation,status:"ambiguous"}};
    f.deps.claimOrder.mockResolvedValue({outcome:"replay",execute:false,order:unresolved});
    f.deps.firstBootRecipe.mockRejectedValue(new Error("a revoked capability must not prevent read-only key reconciliation"));
    const recordSshKeyResult=jest.fn().mockResolvedValue(unresolved);
    await createPreparedHetznerCloudCapacity("user_a",CONNECTION_ID,f.request,preparation,{...f.deps,recordSshKeyResult});
    expect(f.provider.findSshKeysByName).toHaveBeenCalledTimes(1);
    expect(recordSshKeyResult).toHaveBeenCalledWith(expect.objectContaining({status:"ambiguous"}));
    expect(f.deps.firstBootEnrollment).not.toHaveBeenCalled();expect(f.deps.firstBootRecipe).not.toHaveBeenCalled();
    expect(f.provider.createServer).not.toHaveBeenCalled();
  });
});

describe("initial Hetzner receipt recovery", () => {
  it("returns externally resolved ambiguity without first-boot, credential or provider access", async () => {
    const fixture = await capacityFixture();
    const order = { ...fixture.order, serverPostAttemptedAt: fixture.attemptedAt,
      operation: { ...fixture.order.operation, status: "ambiguous" as const, canarySlotHeld: false,
        externalCleanupResolutionId: QUOTE_ID, providerServerId: "42" } };
    const loadSecret=jest.fn(), loadBootstrap=jest.fn(), firstBootEnrollment=jest.fn(), client=jest.fn();
    const result=await createHetznerCloudCapacity("user_a",CONNECTION_ID,{
      quoteId:QUOTE_ID,idempotencyKey:fixture.idempotencyKey,spendingConfirmation:"Create server and start billing",
    }, {loadQuote:jest.fn().mockResolvedValue({quote:fixture.quote,connectionRevision:7,providerLabels:order.providerLabels,quoteFingerprintSha256:order.quoteFingerprintSha256}),
      claimOrder:jest.fn().mockResolvedValue({outcome:"replay",execute:false,order}),listInventory:jest.fn().mockResolvedValue([]),
      loadSecret,loadBootstrap,firstBootEnrollment,client});
    expect(result.operation.status).toBe("ambiguous");expect(result.operation.canarySlotHeld).toBe(false);
    for(const blocked of [loadSecret,loadBootstrap,firstBootEnrollment,client]) expect(blocked).not.toHaveBeenCalled();
  });
  it.each([false, true])("resumes a committed receipt after a lost DB acknowledgement without buying twice (IP drift: %s)", async (drift) => {
    const fixture = await capacityFixture();
    let stored: StoredHetznerCloudCapacityOrder = {
      ...fixture.order, sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted", providerSshKeyId: "77",
    };
    let clock = new Date(fixture.attemptedAt);
    const createServer = jest.fn().mockResolvedValue({
      server: fixture.exactServer, action: fixture.mainAction, nextActions: [fixture.nextAction],
    });
    const observedServer = drift ? {
      ...fixture.exactServer,
      public_net: { ...fixture.exactServer.public_net, ipv6: { id: 90, ip: "2001:db8:1::/64" } },
    } : fixture.exactServer;
    const provider = capacityClient({
      createServer,
      getServer: jest.fn().mockResolvedValue(observedServer),
      getAction: jest.fn(async (id: number) => id === 500 ? fixture.mainAction : fixture.nextAction),
    });
    const recordOrderProgress = jest.fn(async (input) => {
      stored = {
        ...stored,
        creationReceipt: input.creation?.receipt ?? stored.creationReceipt,
        providerServerStatus: "accepted",
        operation: {
          ...stored.operation,
          providerServerId: input.providerServerId, providerActionId: input.providerActionId,
          providerActionCommand: input.providerActionCommand, providerActionStatus: input.providerActionStatus,
          providerNextActions: input.providerNextActions, providerObservedAt: input.providerObservedAt,
          observedServerStatus: input.observedServerStatus,
        },
      };
      if (input.creation) throw new InfrastructureConnectionStoreError("database_error");
      return stored;
    });
    const recordOrderResult = jest.fn(async (input) => {
      stored = { ...stored, operation: {
        ...stored.operation, status: input.status,
        errorCode: input.errorCode ?? null, createdPoweredOff: input.status === "created_off",
      } };
      return stored;
    });
    const dependencies = {
      now: () => clock,
      generateBootstrap: () => fixture.bootstrap,
      loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
      loadQuote: jest.fn().mockResolvedValue({ ...fixture.captured, connectionRevision: 7 }),
      claimOrder: jest.fn(async () => ({ outcome: "replay" as const, execute: false, order: stored })),
      loadSecret: jest.fn().mockResolvedValue({ connection: { id: CONNECTION_ID, status: "ready" }, revision: 7, apiToken: TOKEN }),
      client: () => provider,
      markServerPostAttempted: jest.fn(async () => {
        stored = { ...stored, serverPostAttemptedAt: clock.toISOString(), providerServerStatus: "pending" };
        return true;
      }),
      recordOrderProgress, recordOrderResult,
      listInventory: jest.fn().mockResolvedValue([{ providerResourceId: "42" }]),
      upsertInventoryServer: jest.fn().mockResolvedValue({}),
    };
    const request = { quoteId: fixture.quote.id, idempotencyKey: fixture.idempotencyKey,
      spendingConfirmation: "Create server and start billing" as const };
    await expect(createHetznerCloudCapacity("user_a", CONNECTION_ID, request, dependencies))
      .rejects.toEqual(expect.objectContaining({ code: "database_error" }));
    expect(stored.creationReceipt).toEqual(createHetznerCreationReceipt(
      fixture.exactServer, fixture.mainAction, [fixture.nextAction],
    ));
    clock = new Date("2026-08-26T15:03:00Z");
    const result = await createHetznerCloudCapacity("user_a", CONNECTION_ID, request, dependencies);
    expect(result.operation.status).toBe(drift ? "ambiguous" : "created_off");
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(stored.creationReceipt?.primaryIpv6.id).toBe("89");
    expect(recordOrderProgress.mock.calls.filter(([input]) => input.creation)).toHaveLength(1);
    expect(result.operation).not.toHaveProperty("creationReceipt");
  });
});

describe("self-managed Hetzner Cloud connection service", () => {
  it("generates an OpenSSH Ed25519 bootstrap key whose public key and fingerprint match", () => {
    const bundle = generateHetznerBootstrapBundle({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      connectionRevision: 7,
      orderId: QUOTE_ID,
      quoteFingerprintSha256: "a".repeat(64),
    });
    const parsedPrivate = ssh2Utils.parseKey(bundle.privateKeyOpenSsh);
    const parsedPublic = ssh2Utils.parseKey(bundle.publicKeyOpenSsh);

    expect(bundle.version).toBe(2);
    expect(bundle.privateKeyOpenSsh).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(parsedPrivate).not.toBeInstanceOf(Error);
    expect(parsedPublic).not.toBeInstanceOf(Error);
    if (parsedPrivate instanceof Error || parsedPublic instanceof Error) {
      throw new Error("generated key did not parse");
    }
    expect(parsedPrivate.isPrivateKey()).toBe(true);
    expect(parsedPublic.isPrivateKey()).toBe(false);
    expect(parsedPrivate.getPublicSSH().equals(parsedPublic.getPublicSSH())).toBe(true);
    expect(bundle.publicKeyFingerprint).toBe(
      `SHA256:${createHash("sha256")
        .update(parsedPrivate.getPublicSSH())
        .digest("base64")
        .replace(/=+$/, "")}`,
    );
  });

  it("rejects a malformed ssh2 Ed25519 serialization and samples a verified pair before any provider work", () => {
    const originalGenerate = ssh2Utils.generateKeyPairSync;
    const generate = jest.spyOn(ssh2Utils, "generateKeyPairSync")
      .mockReturnValueOnce({
        private: "malformed private key",
        public: "ssh-ed25519 malformed hivra-capacity",
      })
      .mockImplementation(originalGenerate);

    try {
      const bundle = generateHetznerBootstrapBundle({
        userId: "user_a",
        connectionId: CONNECTION_ID,
        connectionRevision: 7,
        orderId: QUOTE_ID,
        quoteFingerprintSha256: "a".repeat(64),
      });

      expect(generate).toHaveBeenCalledTimes(2);
      expect(ssh2Utils.parseKey(bundle.privateKeyOpenSsh)).not.toBeInstanceOf(Error);
      expect(ssh2Utils.parseKey(bundle.publicKeyOpenSsh)).not.toBeInstanceOf(Error);
    } finally {
      generate.mockRestore();
    }
  });

  it("fails closed before a durable claim or provider call after bounded invalid Ed25519 samples", async () => {
    const fixture = await capacityFixture();
    const claimOrder = jest.fn();
    const provider = jest.fn();
    const generate = jest.spyOn(ssh2Utils, "generateKeyPairSync").mockReturnValue({
      private: "malformed private key",
      public: "ssh-ed25519 malformed hivra-capacity",
    });

    try {
      await expect(createHetznerCloudCapacity(
        "user_a",
        CONNECTION_ID,
        {
          quoteId: fixture.quote.id,
          idempotencyKey: fixture.idempotencyKey,
          spendingConfirmation: "Create server and start billing",
        },
        {
          loadQuote: jest.fn().mockResolvedValue({
            quote: fixture.quote,
            connectionRevision: 7,
            providerLabels: fixture.captured.providerLabels,
            quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
          }),
          claimOrder,
          client: provider,
        },
      )).rejects.toThrow("Hetzner Cloud capacity request failed: access_setup_failed");
      expect(generate).toHaveBeenCalledTimes(16);
      expect(claimOrder).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      generate.mockRestore();
    }
  });

  it("does not retry a generator-thrown crypto failure", () => {
    const generate = jest.spyOn(ssh2Utils, "generateKeyPairSync")
      .mockImplementation(() => {
        throw new Error("crypto subsystem unavailable");
      });

    try {
      expect(() => generateHetznerBootstrapBundle({
        userId: "user_a",
        connectionId: CONNECTION_ID,
        connectionRevision: 7,
        orderId: QUOTE_ID,
        quoteFingerprintSha256: "a".repeat(64),
      })).toThrow("Hetzner Cloud capacity request failed: access_setup_failed");
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      generate.mockRestore();
    }
  });

  it("validates with project inventory and persists only sanitized non-launch authority", async () => {
    const createRecord = jest.fn().mockResolvedValue({
      connection: { id: CONNECTION_ID },
      inventory: [],
    });

    await connectHetznerCloudProject(
      { userId: "user_a", name: "My Hetzner", apiToken: TOKEN },
      {
        now: () => NOW,
        client: () => writeCheckClient(),
        writeCheckKey: () => WRITE_CHECK_PROBE,
        createRecord,
      },
    );

    expect(createRecord).toHaveBeenCalledWith({
      userId: "user_a",
      name: "My Hetzner",
      apiToken: TOKEN,
      discoveredAt: NOW.toISOString(),
      inventory: [
        expect.objectContaining({
          providerResourceId: "42",
          name: "ash-dev-box",
          publicNetwork: {
            ipv4: "203.0.113.10",
            ipv6: "2001:db8::/64",
          },
          launchReady: false,
          launchBlockedReason: expect.stringContaining("not prepared"),
        }),
      ],
    });
  });

  it("maps rejected tokens without calling persistence", async () => {
    const createRecord = jest.fn();
    await expect(
      connectHetznerCloudProject(
        { userId: "user_a", name: "My Hetzner", apiToken: TOKEN },
        {
          now: () => NOW,
          client: () =>
            projectClient({
              listServers: jest
                .fn()
                .mockRejectedValue(
                  new HetznerCloudApiError(401, "GET", "/servers", "request_failed"),
                ),
            }),
          createRecord,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudConnectionError>>({
        code: "invalid_credentials",
      }),
    );
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("preserves encryption/database failures instead of misclassifying them as provider failures", async () => {
    const storeError = new InfrastructureConnectionStoreError("database_unavailable");
    await expect(
      connectHetznerCloudProject(
        { userId: "user_a", name: "My Hetzner", apiToken: TOKEN },
        {
          now: () => NOW,
          client: () => writeCheckClient(),
          writeCheckKey: () => WRITE_CHECK_PROBE,
          createRecord: jest.fn().mockRejectedValue(storeError),
        },
      ),
    ).rejects.toBe(storeError);
  });

  it("preserves reconcile database failures after a successful provider refresh", async () => {
    const storeError = new InfrastructureConnectionStoreError("conflict");
    await expect(
      refreshHetznerCloudInventory("user_a", CONNECTION_ID, {
        now: () => NOW,
        client: () => projectClient(),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID },
          revision: 3,
          apiToken: TOKEN,
        }),
        reconcileInventory: jest.fn().mockRejectedValue(storeError),
      }),
    ).rejects.toBe(storeError);
  });

  it("persists a failed refresh observation before returning the provider error", async () => {
    const recordFailure = jest.fn().mockResolvedValue(true);

    await expect(
      refreshHetznerCloudInventory("user_a", CONNECTION_ID, {
        now: () => NOW,
        client: () => projectClient({
          listServers: jest.fn().mockRejectedValue(
            new HetznerCloudApiError(401, "GET", "/servers", "request_failed"),
          ),
        }),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID },
          revision: 3,
          apiToken: TOKEN,
        }),
        recordFailure,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudConnectionError>>({
        code: "invalid_credentials",
      }),
    );

    expect(recordFailure).toHaveBeenCalledWith({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 3,
      checkedAt: NOW.toISOString(),
      lastErrorCode: "invalid_credentials",
    });
  });

  it("returns live prices with per-type location availability and recommendations", async () => {
    const catalog = await getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, {
      now: () => NOW,
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID },
        revision: 1,
        apiToken: TOKEN,
      }),
      client: () =>
        projectClient({
          listServerTypes: jest.fn().mockResolvedValue([
            {
              id: 104,
              name: "cpx22",
              description: "CPX 22",
              cores: 2,
              memory: 4,
              disk: 80,
              cpu_type: "shared",
              architecture: "x86",
              deprecated: null,
              locations: [
                { id: 1, name: "fsn1", available: true, recommended: true, deprecation: null },
                { id: 2, name: "nbg1", available: false, recommended: false, deprecation: null },
              ],
            },
          ]),
          listLocations: jest.fn().mockResolvedValue([
            {
              id: 1,
              name: "fsn1",
              city: "Falkenstein",
              country: "de",
              network_zone: "eu-central",
            },
          ]),
          listSystemImages: jest.fn().mockResolvedValue([
            {
              id: 100,
              type: "system",
              status: "available",
              name: "ubuntu-24.04",
              description: "Ubuntu 24.04",
              deleted: null,
              created_from: null,
              bound_to: null,
              architecture: "x86",
              os_flavor: "ubuntu",
              os_version: "24.04",
              deprecated: null,
            },
          ]),
          getPricing: jest.fn().mockResolvedValue({
            currency: "EUR",
            vat_rate: "19.00",
            primary_ips: [
              {
                type: "ipv4",
                prices: [{
                  location: "fsn1",
                  price_hourly: { net: "0.001", gross: "0.00119" },
                  price_monthly: { net: "0.50", gross: "0.595" },
                }],
              },
              {
                type: "ipv6",
                prices: [{
                  location: "fsn1",
                  price_hourly: { net: "0", gross: "0" },
                  price_monthly: { net: "0", gross: "0" },
                }],
              },
            ],
            server_types: [
              {
                id: 104,
                name: "cpx22",
                prices: [
                  {
                    location: "fsn1",
                    price_hourly: { net: "0.01", gross: "0.0119" },
                    price_monthly: { net: "5.00", gross: "5.95" },
                    included_traffic: 21990232555520,
                    price_per_tb_traffic: { net: "1.00", gross: "1.19" },
                  },
                ],
              },
            ],
          }),
        }),
    });

    expect(catalog.serverTypes[0]).toEqual(
      expect.objectContaining({
        locations: [
          { name: "fsn1", available: true, recommended: true, deprecated: false },
          { name: "nbg1", available: false, recommended: false, deprecated: false },
        ],
        prices: [
          expect.objectContaining({
            location: "fsn1",
            monthly: { currency: "EUR", net: "5.00", gross: "5.95" },
          }),
        ],
      }),
    );
    expect(catalog.images).toEqual([
      expect.objectContaining({ id: 100, type: "system" }),
    ]);
  });

  describe("Primary IP pricing wire contract", () => {
    function dependencies(provider: ReturnType<typeof capacityClient>) {
      return {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
        createQuote: jest.fn(async (input) => input.quote),
      };
    }

    it("accepts the omitted free IPv6 entry without inventing a paid IPv4 rate", async () => {
      const provider = capacityClient();
      const pricing: HetznerPricing = await provider.getPricing();
      pricing.primary_ips = pricing.primary_ips.filter((entry) => entry.type === "ipv4");
      const deps = dependencies(provider);
      const catalog = await getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, deps);
      const quote = await quoteHetznerCloudCapacity(
        "user_a", CONNECTION_ID, { serverTypeId: 104, locationId: 1, imageId: 100 }, deps,
      );
      const freeIpv6 = {
        hourly: { net: "0", gross: "0" },
        monthly: { net: "0", gross: "0" },
      };
      expect(catalog.primaryIpPrices[0].ipv6).toEqual(freeIpv6);
      expect(quote.price.primaryIpv6).toEqual(freeIpv6);
      expect(quote.price.primaryIpv4.monthly.gross).toBe("0.595");
      expect(quote.price.total.monthly.gross).toBe("6.545");
      expect(provider.createServer).not.toHaveBeenCalled();
      expect(provider.createSshKey).not.toHaveBeenCalled();
    });

    it("preserves the provider's sixteen-place gross decimals and exact totals", async () => {
      const provider = capacityClient();
      const pricing: HetznerPricing = await provider.getPricing();
      pricing.primary_ips[0].prices[0] = {
        location: "fsn1",
        price_hourly: { net: "0.0010000000", gross: "0.0011900000000000" },
        price_monthly: { net: "0.5000000000", gross: "0.5950000000000000" },
      };
      const deps = dependencies(provider);
      const catalog = await getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, deps);
      const quote = await quoteHetznerCloudCapacity(
        "user_a", CONNECTION_ID, { serverTypeId: 104, locationId: 1, imageId: 100 }, deps,
      );
      expect(catalog.primaryIpPrices[0].ipv4.monthly.gross).toBe("0.5950000000000000");
      expect(quote.price.primaryIpv4.hourly.gross).toBe("0.0011900000000000");
      expect(quote.price.total).toEqual({
        hourly: { net: "0.011", gross: "0.01309" },
        monthly: { net: "5.5", gross: "6.545" },
      });
    });

    it("honors an explicit IPv6 price down to the final decimal place", async () => {
      const provider = capacityClient();
      const pricing: HetznerPricing = await provider.getPricing();
      pricing.primary_ips[1].prices[0].price_monthly = {
        net: "0.0000000000000001", gross: "0.0000000000000001",
      };
      const quote = await quoteHetznerCloudCapacity(
        "user_a", CONNECTION_ID, { serverTypeId: 104, locationId: 1, imageId: 100 },
        dependencies(provider),
      );
      expect(quote.price.primaryIpv6.monthly.gross).toBe("0.0000000000000001");
      expect(quote.price.total.monthly).toEqual({
        net: "5.5000000000000001", gross: "6.5450000000000001",
      });
    });

    const invalidPrices: Array<[string, (pricing: HetznerPricing) => void]> = [
      ["missing collection", (pricing) => { Reflect.deleteProperty(pricing, "primary_ips"); }],
      ["empty collection", (pricing) => { pricing.primary_ips = []; }],
      ["missing paid IPv4", (pricing) => { pricing.primary_ips.shift(); }],
      ["duplicate IPv4", (pricing) => { pricing.primary_ips.push(pricing.primary_ips[0]); }],
      ["missing IPv4 location", (pricing) => { pricing.primary_ips[0].prices = []; }],
      ["invalid IPv4 amount", (pricing) => { pricing.primary_ips[0].prices[0].price_monthly.gross = "NaN"; }],
      ["excessive decimal precision", (pricing) => { pricing.primary_ips[0].prices[0].price_monthly.gross = "0.12345678901234567"; }],
      ["duplicate IPv6", (pricing) => { pricing.primary_ips.push(pricing.primary_ips[1]); }],
      ["explicit IPv6 without location", (pricing) => { pricing.primary_ips[1].prices = []; }],
      ["invalid explicit IPv6 amount", (pricing) => { pricing.primary_ips[1].prices[0].price_monthly.gross = "-1"; }],
    ];
    it.each(invalidPrices)("still rejects %s before saving a quote", async (_label, change) => {
      const provider = capacityClient();
      const pricing: HetznerPricing = await provider.getPricing();
      change(pricing);
      const deps = dependencies(provider);
      await expect(getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, deps))
        .rejects.toEqual(expect.objectContaining({ code: "provider_response_invalid" }));
      await expect(quoteHetznerCloudCapacity(
        "user_a", CONNECTION_ID, { serverTypeId: 104, locationId: 1, imageId: 100 }, deps,
      )).rejects.toEqual(expect.objectContaining({ code: "provider_response_invalid" }));
      expect(deps.createQuote).not.toHaveBeenCalled();
      expect(provider.createServer).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["snapshot", { type: "snapshot" }],
    ["backup", { type: "backup" }],
    ["app", { type: "app" }],
    ["creating system", { status: "creating" }],
    ["unavailable system", { status: "unavailable" }],
    ["deleted system", { deleted: "2026-08-26T15:00:00Z" }],
    ["server-derived system", { created_from: { id: 42, name: "old-server" } }],
    ["bound system", { bound_to: 42 }],
  ] as const)(
    "does not admit an Ubuntu-looking %s image into a quote",
    async (_label, imageOverride) => {
      const base = capacityClient();
      const images = await base.listSystemImages();
      const provider = capacityClient({
        listSystemImages: jest.fn().mockResolvedValue([
          { ...images[0], ...imageOverride },
        ]),
      });
      const catalog = await getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, {
        now: () => NOW,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
      });
      expect(catalog.images).toEqual([]);

      const createQuote = jest.fn();
      await expect(quoteHetznerCloudCapacity(
        "user_a",
        CONNECTION_ID,
        { serverTypeId: 104, locationId: 1, imageId: 100 },
        {
          now: () => NOW,
          newId: () => QUOTE_ID,
          loadSecret: jest.fn().mockResolvedValue({
            connection: { id: CONNECTION_ID, status: "ready" },
            revision: 7,
            apiToken: TOKEN,
          }),
          client: () => provider,
          createQuote,
        },
      )).rejects.toEqual(expect.objectContaining({ code: "selection_invalid" }));
      expect(createQuote).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mismatched identity", { id: 104, name: "wrong-name", prices: [] }],
    ["missing prices", { id: 104, name: "cpx22", prices: [] }],
    [
      "unsupported price location",
      {
        id: 104,
        name: "cpx22",
        prices: [{
          location: "hel1",
          price_hourly: { net: "0.01", gross: "0.0119" },
          price_monthly: { net: "5.00", gross: "5.95" },
        }],
      },
    ],
  ])("fails closed for %s in a spending catalog", async (_label, pricingEntry) => {
    await expect(getHetznerCloudOfferCatalog("user_a", CONNECTION_ID, {
      now: () => NOW,
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID },
        revision: 1,
        apiToken: TOKEN,
      }),
      client: () => projectClient({
        listServerTypes: jest.fn().mockResolvedValue([{
          id: 104,
          name: "cpx22",
          description: "CPX 22",
          cores: 2,
          memory: 4,
          disk: 80,
          cpu_type: "shared",
          architecture: "x86",
          deprecated: false,
          locations: [{
            id: 1,
            name: "fsn1",
            available: true,
            recommended: true,
            deprecation: null,
          }],
        }]),
        getPricing: jest.fn().mockResolvedValue({
          currency: "EUR",
          vat_rate: "19.00",
          primary_ips: [],
          server_types: [pricingEntry],
        }),
      }),
    })).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudConnectionError>>({
        code: "provider_response_invalid",
      }),
    );
  });

  it.each(["50.388", "59.50"])("checks available 8 GiB USD offers including IP costs: %s", async monthly => {
    const base = capacityClient();
    const types = await base.listServerTypes();
    const pricing = await base.getPricing();
    pricing.currency = "USD";
    pricing.server_types[0].prices[0].price_monthly = {net:monthly,gross:monthly};
    const createQuote = jest.fn(async input => input.quote);
    const provider = capacityClient({
      listServerTypes: jest.fn().mockResolvedValue([{...types[0],cores:4,memory:8}]),
      getPricing: jest.fn().mockResolvedValue(pricing),
    });
    const result = quoteHetznerCloudCapacity("user_a",CONNECTION_ID,
      {serverTypeId:104,locationId:1,imageId:100},{now:()=>NOW,newId:()=>QUOTE_ID,
        loadSecret:jest.fn().mockResolvedValue({connection:{id:CONNECTION_ID,status:"ready"},revision:7,apiToken:TOKEN}),
        client:()=>provider,createQuote});
    if(monthly === "59.50") {
      await expect(result).rejects.toMatchObject({code:"selection_invalid"});
      expect(createQuote).not.toHaveBeenCalled();
    } else {
      const quote = await result;
      expect(quote.serverType.memoryGb).toBe(8);
      expect(quote.price.total.monthly.gross).toBe("50.983");
      expect(provider.createServer).not.toHaveBeenCalled();
      const historical = JSON.parse(JSON.stringify(quote));
      historical.simpleModePolicy.maxMonthlyGrossByCurrency[1].amount = "50.00";
      expect(HetznerCloudCapacityQuoteDtoSchema.safeParse(historical).success).toBe(true);
    }
  });

  it("binds a fresh exact quote to connection revision, both Primary IPs, traffic, and the Canary policy", async () => {
    const createQuote = jest.fn(async (input) => input.quote);
    const quote = await quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient(),
        createQuote,
      },
    );

    expect(quote).toEqual(expect.objectContaining({
      id: QUOTE_ID,
      connectionRevision: 7,
      serverName: "hivra-22222222222242228222",
      startAfterCreate: false,
      backups: false,
      volumes: [],
      price: expect.objectContaining({
        currency: "EUR",
        primaryIpv4: expect.any(Object),
        primaryIpv6: expect.any(Object),
        total: expect.objectContaining({
          monthly: { net: "5.5", gross: "6.545" },
        }),
        traffic: {
          includedBytes: 21990232555520,
          additionalPerTb: { net: "1.00", gross: "1.19" },
        },
      }),
      simpleModePolicy: expect.objectContaining({ cpuType: "shared", minCores: 2 }),
      billing: expect.objectContaining({ poweredOffStillBilled: true }),
    }));
    expect(createQuote).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 7,
      providerLabels: expect.objectContaining({
        "hivra-operation": QUOTE_ID,
        "hivra-managed": "true",
      }),
      quoteFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("maps the durable owner quote cap to the public quote rate-limit code", async () => {
    await expect(quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient(),
        createQuote: jest.fn().mockRejectedValue(
          new InfrastructureConnectionStoreError("quote_limit"),
        ),
      },
    )).rejects.toEqual(expect.objectContaining({ code: "quote_rate_limited" }));
  });

  it("creates exactly one powered-off server and records complete provider evidence", async () => {
    let quoteRecord: {
      quote: Awaited<ReturnType<typeof quoteHetznerCloudCapacity>>;
      providerLabels: Record<string, string>;
      quoteFingerprintSha256: string;
    } | null = null;
    const quote = await quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient(),
        createQuote: jest.fn(async (input) => {
          quoteRecord = {
            quote: input.quote,
            providerLabels: input.providerLabels,
            quoteFingerprintSha256: input.quoteFingerprintSha256,
          };
          return input.quote;
        }),
      },
    );
    const captured = quoteRecord!;
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    const bootstrap = {
      version: 2 as const,
      provider: "hetzner-cloud" as const,
      userId: "user_a",
      connectionId: CONNECTION_ID,
      connectionRevision: 7,
      orderId: quote.id,
      quoteFingerprintSha256: captured.quoteFingerprintSha256,
      privateKeyOpenSsh: TEST_BOOTSTRAP_KEY.privateKeyOpenSsh,
      publicKeyOpenSsh: TEST_BOOTSTRAP_KEY.publicKeyOpenSsh,
      publicKeyFingerprint: TEST_BOOTSTRAP_KEY.publicKeyFingerprint,
    };
    const createdAt = "2026-08-26T15:01:00.000Z";
    const initialOrder = {
      operation: {
        id: quote.id,
        connectionId: CONNECTION_ID,
        idempotencyKey,
        status: "creating" as const,
        providerServerId: null,
        providerActionId: null,
        providerActionCommand: null,
        providerActionStatus: null,
        providerNextActions: [],
        observedServerStatus: null,
        providerObservedAt: null,
        errorCode: null,
        canarySlotHeld: true,
        replayed: false,
        quote,
        createdPoweredOff: false,
        launchReady: false as const,
        launchBlockedReason:
          "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
        createdAt,
        updatedAt: createdAt,
      },
      connectionRevision: 7,
      providerLabels: captured.providerLabels,
      quoteFingerprintSha256: captured.quoteFingerprintSha256,
      sshKeyPostAttemptedAt: null,
      providerSshKeyStatus: null,
      providerSshKeyId: null,
      serverPostAttemptedAt: null,
      providerServerStatus: null,
      bootstrapPublicKey: bootstrap.publicKeyOpenSsh,
      bootstrapPublicKeyFingerprint: bootstrap.publicKeyFingerprint,
      creationReceipt: null,
    };
    const acceptedSshOrder = {
      ...initialOrder,
      sshKeyPostAttemptedAt: createdAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
    };
    const finalServer = {
      ...server,
      name: quote.serverName,
      status: "off" as const,
      labels: captured.providerLabels,
      backup_window: null,
      image: {
        id: 100,
        type: "system" as const,
        status: "available" as const,
        name: "ubuntu-24.04",
        description: "Ubuntu 24.04",
        image_size: 2,
        disk_size: 10,
        created: "2026-08-20T12:00:00+00:00",
        deleted: null,
        created_from: null,
        bound_to: null,
        os_flavor: "ubuntu",
        os_version: "24.04",
        architecture: "x86" as const,
      },
    };
    const mainAction = {
      id: 500,
      command: "create_server",
      status: "success" as const,
      resources: [{ id: 42, type: "server" }],
    };
    const nextAction = {
      id: 501,
      command: "create_primary_ip",
      status: "success" as const,
      resources: [{ id: 88, type: "primary_ip" }],
    };
    const createSshKey = jest.fn().mockResolvedValue({
      id: 77,
      name: `hivra-key-${quote.id.replaceAll("-", "").slice(0, 20)}`,
      fingerprint: bootstrap.publicKeyFingerprint,
      public_key: bootstrap.publicKeyOpenSsh,
      labels: captured.providerLabels,
      created: createdAt,
    });
    const createServer = jest.fn().mockResolvedValue({
      server: finalServer,
      action: mainAction,
      nextActions: [nextAction],
    });
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      createSshKey,
      createServer,
      getAction: jest.fn(async (id: number) => id === 500 ? mainAction : nextAction),
      getServer: jest.fn().mockResolvedValue(finalServer),
    });
    const recordOrderProgress = jest.fn(async (input) => ({
      ...acceptedSshOrder,
      creationReceipt: input.creation?.receipt ?? null,
      serverPostAttemptedAt: createdAt,
      providerServerStatus: "accepted" as const,
      operation: {
        ...acceptedSshOrder.operation,
        providerServerId: input.providerServerId,
        providerActionId: input.providerActionId,
        providerActionCommand: input.providerActionCommand,
        providerActionStatus: input.providerActionStatus,
        providerNextActions: input.providerNextActions,
        providerObservedAt: input.providerObservedAt ?? null,
        observedServerStatus: input.observedServerStatus ?? null,
      },
    }));
    const recordOrderResult = jest.fn(async (input) => ({
      ...acceptedSshOrder,
      serverPostAttemptedAt: createdAt,
      providerServerStatus: "accepted" as const,
      operation: {
        ...acceptedSshOrder.operation,
        status: "created_off" as const,
        providerServerId: input.providerServerId,
        providerActionId: input.providerActionId,
        providerActionCommand: input.providerActionCommand,
        providerActionStatus: input.providerActionStatus,
        providerNextActions: input.providerNextActions,
        providerObservedAt: input.providerObservedAt,
        observedServerStatus: input.observedServerStatus,
        createdPoweredOff: true,
        errorCode: null,
      },
    }));
    const inventory = [{ providerResourceId: "42" }];
    const markSshKeyPostAttempted = jest.fn().mockResolvedValue(true);
    const markServerPostAttempted = jest.fn().mockResolvedValue(true);

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: quote.id,
        idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date(createdAt),
        generateBootstrap: () => bootstrap,
        loadQuote: jest.fn().mockResolvedValue({
          quote,
          connectionRevision: 7,
          providerLabels: captured.providerLabels,
          quoteFingerprintSha256: captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: initialOrder,
        }),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
        markSshKeyPostAttempted,
        recordSshKeyResult: jest.fn().mockResolvedValue(acceptedSshOrder),
        markServerPostAttempted,
        recordOrderProgress,
        recordOrderResult,
        upsertInventoryServer: jest.fn().mockResolvedValue({}),
        listInventory: jest.fn().mockResolvedValue(inventory),
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "created_off",
      createdPoweredOff: true,
      providerServerId: "42",
      providerActionId: "500",
      providerNextActions: [{
        id: "501",
        command: "create_primary_ip",
        status: "success",
      }],
      observedServerStatus: "off",
      canarySlotHeld: true,
      launchReady: false,
    }));
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(recordOrderProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      creation: {
        expectedRevision: 7,
        receipt: expect.objectContaining({
          serverId: "42",
          primaryIpv4: { id: "88", ip: "203.0.113.10" },
          primaryIpv6: { id: "89", ip: "2001:db8::/64" },
          nextActions: [expect.objectContaining({ resources: [{ id: "88", type: "primary_ip" }] })],
        }),
      },
    }));
    expect(recordOrderProgress.mock.calls[1][0]).not.toHaveProperty("creation");
    expect(result.operation).not.toHaveProperty("creationReceipt");
    expect(markSshKeyPostAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      createSshKey.mock.invocationCallOrder[0],
    );
    expect(markServerPostAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      createServer.mock.invocationCallOrder[0],
    );
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      server_type: "104",
      image: "100",
      location: "1",
      ssh_keys: ["77"],
      start_after_create: false,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      volumes: [],
    }));
    const payload = createServer.mock.calls[0][0];
    expect(payload).not.toHaveProperty("backups");
    expect(payload.user_data).toContain("name: hivra");
    expect(payload.user_data).not.toContain("- default");
    expect(payload.user_data).not.toContain(TOKEN);
    expect(payload.user_data).not.toContain(bootstrap.privateKeyOpenSsh);
    expect(recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "created_off",
      providerActionStatus: "success",
      providerObservedAt: createdAt,
      observedServerStatus: "off",
    }));
  });

  it("keeps an immediate running create response sticky across a later off replay", async () => {
    const fixture = await capacityFixture();
    const acceptedOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
    };
    const runningServer = {
      ...fixture.exactServer,
      status: "running" as const,
    };
    const runningAction = {
      ...fixture.mainAction,
      status: "running" as const,
    };
    const createServer = jest.fn().mockResolvedValue({
      server: runningServer,
      action: runningAction,
      nextActions: [],
    });
    const createSshKey = jest.fn();
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      createSshKey,
      createServer,
      getAction: jest.fn().mockResolvedValue(fixture.mainAction),
      getServer: jest.fn().mockResolvedValue(fixture.exactServer),
    });
    const runningOrder: StoredHetznerCloudCapacityOrder = {
      ...acceptedOrder,
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "accepted",
      operation: {
        ...acceptedOrder.operation,
        providerServerId: "42",
        providerActionId: "500",
        providerActionCommand: "create_server",
        providerActionStatus: "running",
        providerObservedAt: fixture.attemptedAt,
        observedServerStatus: "running",
      },
    };
    const ambiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...runningOrder,
      operation: {
        ...runningOrder.operation,
        status: "ambiguous",
        errorCode: "provider_response_invalid",
        replayed: true,
      },
    };
    const recordOrderProgress = jest
      .fn()
      .mockImplementationOnce(async (input) => ({
        ...runningOrder,
        operation: {
          ...runningOrder.operation,
          providerObservedAt: input.providerObservedAt,
          observedServerStatus: input.observedServerStatus,
        },
      }))
      .mockRejectedValueOnce(new InfrastructureConnectionStoreError("conflict"));
    const recordOrderResult = jest.fn().mockResolvedValue(ambiguousOrder);
    const common = {
      now: () => new Date(fixture.attemptedAt),
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      markServerPostAttempted: jest.fn().mockResolvedValue(true),
      recordOrderProgress,
      recordOrderResult,
      upsertInventoryServer: jest.fn().mockResolvedValue({}),
      listInventory: jest.fn().mockResolvedValue([{ providerResourceId: "42" }]),
    };

    const first = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: acceptedOrder,
        }),
      },
    );

    expect(first.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      providerActionStatus: "running",
      observedServerStatus: "running",
      createdPoweredOff: false,
    }));
    expect(recordOrderProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      providerObservedAt: fixture.attemptedAt,
      observedServerStatus: "running",
    }));

    const replay = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: ambiguousOrder,
        }),
      },
    );

    expect(replay.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      providerActionStatus: "running",
      observedServerStatus: "running",
      createdPoweredOff: false,
    }));
    expect(recordOrderResult).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "created_off",
    }));
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createSshKey).not.toHaveBeenCalled();
  });

  it("normalizes an unrecognized paid create status to durable ambiguous evidence without retrying", async () => {
    const fixture = await capacityFixture();
    const acceptedOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
    };
    const unknownStatusServer = {
      ...fixture.exactServer,
      status: "provider_new_state" as never,
    };
    const createServer = jest.fn().mockResolvedValue({
      server: unknownStatusServer,
      action: fixture.mainAction,
      nextActions: [],
    });
    const provider = capacityClient({
      createServer,
      getAction: jest.fn(),
      getServer: jest.fn(),
    });
    const observedOrder: StoredHetznerCloudCapacityOrder = {
      ...acceptedOrder,
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "accepted",
      operation: {
        ...acceptedOrder.operation,
        providerServerId: "42",
        providerActionId: "500",
        providerActionCommand: "create_server",
        providerActionStatus: "success",
        providerObservedAt: fixture.attemptedAt,
        observedServerStatus: "unknown",
      },
    };
    const ambiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...observedOrder,
      operation: {
        ...observedOrder.operation,
        status: "ambiguous",
        errorCode: "provider_response_invalid",
      },
    };
    const recordOrderProgress = jest.fn().mockResolvedValue(observedOrder);
    const recordOrderResult = jest.fn().mockResolvedValue(ambiguousOrder);

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date(fixture.attemptedAt),
        generateBootstrap: () => fixture.bootstrap,
        loadQuote: jest.fn().mockResolvedValue({
          quote: fixture.quote,
          connectionRevision: 7,
          providerLabels: fixture.captured.providerLabels,
          quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: acceptedOrder,
        }),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
        markServerPostAttempted: jest.fn().mockResolvedValue(true),
        recordOrderProgress,
        recordOrderResult,
        listInventory: jest.fn().mockResolvedValue([]),
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      providerServerId: "42",
      observedServerStatus: "unknown",
      providerObservedAt: fixture.attemptedAt,
      createdPoweredOff: false,
    }));
    expect(recordOrderProgress).toHaveBeenCalledWith(expect.objectContaining({
      providerServerId: "42",
      observedServerStatus: "unknown",
      providerObservedAt: fixture.attemptedAt,
    }));
    expect(recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "ambiguous",
      providerServerId: "42",
      errorCode: "provider_response_invalid",
    }));
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(provider.getAction).not.toHaveBeenCalled();
    expect(provider.getServer).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an unexpected volume action",
      mainResources: null,
      serverPatch: null,
      nextActions: [{
        id: 501,
        command: "create_volume",
        status: "success" as const,
        resources: [{ id: 99, type: "volume" }],
      }],
    },
    {
      label: "a Primary IP action that does not match the final server",
      mainResources: null,
      serverPatch: null,
      nextActions: [{
        id: 501,
        command: "create_primary_ip",
        status: "success" as const,
        resources: [{ id: 999, type: "primary_ip" }],
      }],
    },
    {
      label: "a next action targeting the exact server",
      mainResources: null,
      serverPatch: null,
      nextActions: [{
        id: 501,
        command: "change_alias_ips",
        status: "success" as const,
        resources: [{ id: 42, type: "server" }],
      }],
    },
    {
      label: "duplicate exact server resources on the main action",
      mainResources: [
        { id: 42, type: "server" },
        { id: 42, type: "server" },
      ],
      serverPatch: { status: "running" as const },
      nextActions: [],
    },
    {
      label: "a different server on the main action",
      mainResources: [{ id: 43, type: "server" }],
      serverPatch: null,
      nextActions: [],
    },
    ...(["primary_ip", "volume", "network", "firewall", "image"] as const).map(
      (type) => ({
        label: `a ${type} resource instead of the server on the main action`,
        mainResources: [{ id: 42, type }],
        serverPatch: null,
        nextActions: [],
      }),
    ),
    ...([
      ["a different primary disk size", { primary_disk_size: 81 }],
      ["missing primary disk evidence", { primary_disk_size: undefined }],
      ["rescue mode enabled", { rescue_enabled: true }],
      ["an attached ISO", { iso: { id: 9 } }],
      ["a private network attachment", { private_net: [{ network: 7 }] }],
      ["a locked server", { locked: true }],
      ["delete protection", { protection: { delete: true, rebuild: false } }],
      ["rebuild protection", { protection: { delete: false, rebuild: true } }],
      ["a floating IP", { public_net: { ...server.public_net, floating_ips: [7] } }],
      ["missing floating IP evidence", { public_net: { ...server.public_net, floating_ips: undefined } }],
      ["a load balancer", { load_balancers: [8] }],
      ["a placement group", { placement_group: { id: 9 } }],
      ["missing rescue evidence", { rescue_enabled: undefined }],
    ] as const).map(([label, serverPatch]) => ({
      label,
      mainResources: null,
      serverPatch,
      nextActions: [],
    })),
  ])("keeps $label ambiguous after the paid POST", async ({
    mainResources,
    serverPatch,
    nextActions,
  }) => {
    const fixture = await capacityFixture();
    const acceptedOrder: StoredHetznerCloudCapacityOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted",
      providerSshKeyId: "77",
    };
    const mainAction = {
      ...fixture.mainAction,
      ...(mainResources ? { resources: mainResources } : {}),
    };
    const candidateServer = {
      ...fixture.exactServer,
      ...(serverPatch ?? {}),
    };
    const createServer = jest.fn().mockResolvedValue({
      server: candidateServer,
      action: mainAction,
      nextActions,
    });
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      createServer,
      getAction: jest.fn(async (id: number) => (
        id === mainAction.id
          ? mainAction
          : nextActions.find((action) => action.id === id)
      )),
      getServer: jest.fn().mockResolvedValue(candidateServer),
    });
    let persistedOrder = acceptedOrder;
    const recordOrderProgress = jest.fn(async (input) => {
      persistedOrder = {
        ...acceptedOrder,
        serverPostAttemptedAt: fixture.attemptedAt,
        providerServerStatus: "accepted" as const,
        operation: {
          ...acceptedOrder.operation,
          providerServerId: input.providerServerId,
          providerActionId: input.providerActionId,
          providerActionCommand: input.providerActionCommand,
          providerActionStatus: input.providerActionStatus,
          providerNextActions: input.providerNextActions,
          providerObservedAt: input.providerObservedAt ?? null,
          observedServerStatus: input.observedServerStatus ?? null,
        },
      };
      return persistedOrder;
    });
    const recordOrderResult = jest.fn(async (input) => {
      persistedOrder = {
        ...persistedOrder,
        serverPostAttemptedAt: fixture.attemptedAt,
        providerServerStatus: input.providerServerId
          ? "accepted" as const
          : "ambiguous" as const,
        operation: {
          ...persistedOrder.operation,
          status: "ambiguous",
          providerServerId: input.providerServerId
            ?? persistedOrder.operation.providerServerId,
          errorCode: input.errorCode,
          providerObservedAt: input.providerObservedAt
            ?? persistedOrder.operation.providerObservedAt,
          observedServerStatus: input.observedServerStatus
            ?? persistedOrder.operation.observedServerStatus,
          replayed: true,
        },
      };
      return persistedOrder;
    });

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date(fixture.attemptedAt),
        generateBootstrap: () => fixture.bootstrap,
        loadQuote: jest.fn().mockResolvedValue({
          quote: fixture.quote,
          connectionRevision: 7,
          providerLabels: fixture.captured.providerLabels,
          quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: acceptedOrder,
        }),
        loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
        markServerPostAttempted: jest.fn().mockResolvedValue(true),
        recordOrderProgress,
        recordOrderResult,
        upsertInventoryServer: jest.fn().mockResolvedValue({}),
        listInventory: jest.fn().mockResolvedValue([{ providerResourceId: "42" }]),
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      errorCode: "provider_response_invalid",
      createdPoweredOff: false,
    }));
    expect(recordOrderResult).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "created_off",
    }));
    expect(createServer).toHaveBeenCalledTimes(1);
    if (candidateServer.status === "running") {
      expect(result.operation).toEqual(expect.objectContaining({
        providerObservedAt: fixture.attemptedAt,
        observedServerStatus: "running",
      }));
      expect(recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
        providerServerId: "42",
        providerObservedAt: fixture.attemptedAt,
        observedServerStatus: "running",
      }));
    }
  });

  it("rejects a later main-action observation unless it has exactly one matching server resource", async () => {
    const fixture = await capacityFixture();
    const observingOrder: StoredHetznerCloudCapacityOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted",
      providerSshKeyId: "77",
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "accepted",
      operation: {
        ...fixture.order.operation,
        providerServerId: "42",
        providerActionId: "500",
        providerActionCommand: "create_server",
        providerActionStatus: "running",
      },
    };
    const invalidMainAction = {
      ...fixture.mainAction,
      resources: [
        { id: 42, type: "server" },
        { id: 42, type: "server" },
      ],
    };
    const runningServer = {
      ...fixture.exactServer,
      status: "running" as const,
    };
    const getServer = jest.fn().mockResolvedValue(runningServer);
    const provider = capacityClient({
      getAction: jest.fn().mockResolvedValue(invalidMainAction),
      getServer,
    });
    const ambiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...observingOrder,
      operation: {
        ...observingOrder.operation,
        status: "ambiguous",
        errorCode: "provider_response_invalid",
        replayed: true,
      },
    };
    const recordOrderProgress = jest.fn();
    const recordOrderResult = jest.fn(async (input) => ({
      ...ambiguousOrder,
      operation: {
        ...ambiguousOrder.operation,
        providerObservedAt: input.providerObservedAt ?? null,
        observedServerStatus: input.observedServerStatus ?? null,
      },
    }));
    const upsertInventoryServer = jest.fn().mockResolvedValue({});

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date(Date.parse(fixture.attemptedAt) + 61_000),
        generateBootstrap: () => fixture.bootstrap,
        loadQuote: jest.fn().mockResolvedValue({
          quote: fixture.quote,
          connectionRevision: 7,
          providerLabels: fixture.captured.providerLabels,
          quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: observingOrder,
        }),
        loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => provider,
        recordOrderProgress,
        recordOrderResult,
        upsertInventoryServer,
        listInventory: jest.fn().mockResolvedValue([{ providerResourceId: "42" }]),
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      errorCode: "provider_response_invalid",
      providerObservedAt: "2026-08-26T15:02:01.000Z",
      observedServerStatus: "running",
      createdPoweredOff: false,
    }));
    expect(recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "ambiguous",
      errorCode: "provider_response_invalid",
      providerServerId: "42",
      providerObservedAt: "2026-08-26T15:02:01.000Z",
      observedServerStatus: "running",
    }));
    expect(recordOrderProgress).not.toHaveBeenCalled();
    expect(getServer).toHaveBeenCalledWith(42);
    expect(upsertInventoryServer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["dedicated CPU", { cpu_type: "dedicated" }],
    ["too many cores", { cores: 16 }],
  ])("rejects %s outside the server-side simple-mode policy", async (_label, patch) => {
    const base = capacityClient();
    const types = await base.listServerTypes();
    const createQuote = jest.fn();
    await expect(quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient({
          listServerTypes: jest.fn().mockResolvedValue([{ ...types[0], ...patch }]),
        }),
        createQuote,
      },
    )).rejects.toEqual(expect.objectContaining<Partial<HetznerCloudCapacityError>>({
      code: "selection_invalid",
    }));
    expect(createQuote).not.toHaveBeenCalled();
  });

  it("never retries an SSH-key POST after an ambiguous provider timeout", async () => {
    const fixture = await capacityFixture();
    const createSshKey = jest.fn().mockRejectedValue(
      new HetznerCloudApiError(
        null,
        "POST",
        "/ssh_keys",
        "timeout",
      ),
    );
    const createServer = jest.fn();
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      findSshKeysByName: jest.fn().mockResolvedValue([]),
      createSshKey,
      createServer,
    });
    const markSshKeyPostAttempted = jest.fn().mockResolvedValue(true);
    const markServerPostAttempted = jest.fn().mockResolvedValue(true);
    const ambiguousOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "ambiguous" as const,
      operation: {
        ...fixture.order.operation,
        status: "ambiguous" as const,
        errorCode: "provider_unavailable" as const,
      },
    };
    const recordSshKeyResult = jest.fn().mockResolvedValue(ambiguousOrder);
    const recordOrderResult = jest.fn().mockResolvedValue({
      ...ambiguousOrder,
      operation: { ...ambiguousOrder.operation, replayed: true },
    });
    let observedNow = new Date(fixture.attemptedAt);
    const common = {
      now: () => observedNow,
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
      markSshKeyPostAttempted,
      markServerPostAttempted,
      recordSshKeyResult,
      recordOrderResult,
      listInventory: jest.fn().mockResolvedValue([]),
    };

    const first = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: fixture.order,
        }),
      },
    );

    expect(first.operation.status).toBe("ambiguous");
    expect(markSshKeyPostAttempted).toHaveBeenCalledTimes(1);
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(markSshKeyPostAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      createSshKey.mock.invocationCallOrder[0],
    );
    expect(createServer).not.toHaveBeenCalled();

    const sshListCallsDuringProviderLease = (
      provider.findSshKeysByName as jest.Mock
    ).mock.calls.length;
    const replayOrder = {
      ...ambiguousOrder,
      operation: { ...ambiguousOrder.operation, replayed: true },
    };
    const replay = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: replayOrder,
        }),
      },
    );

    expect(replay.operation.status).toBe("ambiguous");
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(createServer).not.toHaveBeenCalled();
    expect(provider.findSshKeysByName).toHaveBeenCalledTimes(
      sshListCallsDuringProviderLease,
    );

    observedNow = new Date(Date.parse(fixture.attemptedAt) + 61_000);
    const delayedInvisible = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: replayOrder,
        }),
      },
    );
    expect(delayedInvisible.operation.status).toBe("ambiguous");
    expect(recordSshKeyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "ambiguous",
      errorCode: "provider_conflict",
    }));
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(createServer).not.toHaveBeenCalled();

    (provider.findSshKeysByName as jest.Mock).mockResolvedValueOnce([{
      id: 77,
      name: `hivra-key-${fixture.quote.id.replaceAll("-", "").slice(0, 20)}`,
      fingerprint: fixture.bootstrap.publicKeyFingerprint,
      public_key: fixture.bootstrap.publicKeyOpenSsh,
      labels: fixture.captured.providerLabels,
      created: fixture.attemptedAt,
    }]);
    recordSshKeyResult.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("conflict"),
    );
    await expect(createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: replayOrder,
        }),
      },
    )).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    expect(createServer).not.toHaveBeenCalled();

    const acceptedSshOrder: StoredHetznerCloudCapacityOrder = {
      ...replayOrder,
      providerSshKeyStatus: "accepted",
      providerSshKeyId: "77",
      operation: {
        ...replayOrder.operation,
        status: "creating",
        errorCode: null,
        replayed: true,
      },
    };
    const serverAmbiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...acceptedSshOrder,
      serverPostAttemptedAt: observedNow.toISOString(),
      providerServerStatus: "ambiguous",
      operation: {
        ...acceptedSshOrder.operation,
        status: "ambiguous",
        errorCode: "provider_unavailable",
      },
    };
    (provider.findSshKeysByName as jest.Mock).mockResolvedValueOnce([{
      id: 77,
      name: `hivra-key-${fixture.quote.id.replaceAll("-", "").slice(0, 20)}`,
      fingerprint: fixture.bootstrap.publicKeyFingerprint,
      public_key: fixture.bootstrap.publicKeyOpenSsh,
      labels: fixture.captured.providerLabels,
      created: fixture.attemptedAt,
    }]);
    recordSshKeyResult.mockResolvedValueOnce(acceptedSshOrder);
    createServer.mockRejectedValueOnce(
      new HetznerCloudApiError(null, "POST", "/servers", "timeout"),
    );
    recordOrderResult.mockResolvedValueOnce(serverAmbiguousOrder);
    const eventuallyVisible = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: replayOrder,
        }),
      },
    );

    expect(eventuallyVisible.operation.status).toBe("ambiguous");
    expect(recordSshKeyResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "accepted",
      providerSshKeyId: "77",
    }));
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(markServerPostAttempted).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it("keeps a concurrent SSH-key replay inside the mutation lease while the first POST is unresolved", async () => {
    const fixture = await capacityFixture();
    const mutation = deferred<never>();
    const started = deferred<void>();
    const createSshKey = jest.fn(() => {
      started.resolve();
      return mutation.promise;
    });
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      findSshKeysByName: jest.fn().mockResolvedValue([]),
      createSshKey,
      createServer: jest.fn(),
    });
    const inFlightOrder: StoredHetznerCloudCapacityOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "pending",
    };
    const ambiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...inFlightOrder,
      providerSshKeyStatus: "ambiguous",
      operation: {
        ...inFlightOrder.operation,
        status: "ambiguous",
        errorCode: "provider_unavailable",
      },
    };
    const listInventory = jest.fn().mockResolvedValue([]);
    const common = {
      now: () => new Date(fixture.attemptedAt),
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      markSshKeyPostAttempted: jest.fn().mockResolvedValue(true),
      recordSshKeyResult: jest.fn().mockResolvedValue(ambiguousOrder),
      listInventory,
    };
    const first = createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: fixture.order,
        }),
      },
    );

    await started.promise;
    const providerListCallsAtLease = (
      provider.findSshKeysByName as jest.Mock
    ).mock.calls.length;
    const replay = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: inFlightOrder,
        }),
      },
    );

    expect(replay.operation.status).toBe("creating");
    expect(createSshKey).toHaveBeenCalledTimes(1);
    expect(provider.findSshKeysByName).toHaveBeenCalledTimes(providerListCallsAtLease);
    mutation.reject(new HetznerCloudApiError(null, "POST", "/ssh_keys", "timeout"));
    await expect(first).resolves.toEqual(expect.objectContaining({
      operation: expect.objectContaining({ status: "ambiguous" }),
    }));
    expect(createSshKey).toHaveBeenCalledTimes(1);
  });

  it("never retries a server POST after its durable marker and an ambiguous timeout", async () => {
    const fixture = await capacityFixture();
    const acceptedOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
    };
    const ambiguousOrder = {
      ...acceptedOrder,
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "ambiguous" as const,
      operation: {
        ...acceptedOrder.operation,
        status: "ambiguous" as const,
        errorCode: "provider_unavailable" as const,
      },
    };
    const createServer = jest.fn().mockRejectedValue(
      new HetznerCloudApiError(null, "POST", "/servers", "timeout"),
    );
    const createSshKey = jest.fn();
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      createSshKey,
      createServer,
    });
    const markServerPostAttempted = jest.fn().mockResolvedValue(true);
    const recordOrderResult = jest.fn().mockResolvedValue(ambiguousOrder);
    const common = {
      now: () => new Date(fixture.attemptedAt),
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
      markServerPostAttempted,
      recordOrderResult,
      listInventory: jest.fn().mockResolvedValue([]),
    };

    const first = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: acceptedOrder,
        }),
      },
    );

    expect(first.operation.status).toBe("ambiguous");
    expect(markServerPostAttempted).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(markServerPostAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      createServer.mock.invocationCallOrder[0],
    );
    expect(createSshKey).not.toHaveBeenCalled();

    const serverListCallsDuringProviderLease = (
      provider.findServersByName as jest.Mock
    ).mock.calls.length;
    const replayOrder = {
      ...ambiguousOrder,
      operation: { ...ambiguousOrder.operation, replayed: true },
    };
    recordOrderResult.mockResolvedValueOnce(replayOrder);
    const replay = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: replayOrder,
        }),
      },
    );

    expect(replay.operation.status).toBe("ambiguous");
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(markServerPostAttempted).toHaveBeenCalledTimes(1);
    expect(provider.findServersByName).toHaveBeenCalledTimes(
      serverListCallsDuringProviderLease,
    );
  });

  it("keeps a concurrent server replay inside the mutation lease while the billable POST is unresolved", async () => {
    const fixture = await capacityFixture();
    const mutation = deferred<never>();
    const started = deferred<void>();
    const createServer = jest.fn(() => {
      started.resolve();
      return mutation.promise;
    });
    const provider = capacityClient({
      listServers: jest.fn().mockResolvedValue([]),
      createSshKey: jest.fn(),
      createServer,
    });
    const acceptedOrder: StoredHetznerCloudCapacityOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted",
      providerSshKeyId: "77",
    };
    const inFlightOrder: StoredHetznerCloudCapacityOrder = {
      ...acceptedOrder,
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "pending",
    };
    const ambiguousOrder: StoredHetznerCloudCapacityOrder = {
      ...inFlightOrder,
      providerServerStatus: "ambiguous",
      operation: {
        ...inFlightOrder.operation,
        status: "ambiguous",
        errorCode: "provider_unavailable",
      },
    };
    const common = {
      now: () => new Date(fixture.attemptedAt),
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      markServerPostAttempted: jest.fn().mockResolvedValue(true),
      recordOrderResult: jest.fn().mockResolvedValue(ambiguousOrder),
      listInventory: jest.fn().mockResolvedValue([]),
    };
    const first = createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "claimed",
          execute: true,
          order: acceptedOrder,
        }),
      },
    );

    await started.promise;
    const providerListCallsAtLease = (
      provider.findServersByName as jest.Mock
    ).mock.calls.length;
    const replay = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: inFlightOrder,
        }),
      },
    );

    expect(replay.operation.status).toBe("creating");
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(provider.findServersByName).toHaveBeenCalledTimes(providerListCallsAtLease);
    mutation.reject(new HetznerCloudApiError(null, "POST", "/servers", "timeout"));
    await expect(first).resolves.toEqual(expect.objectContaining({
      operation: expect.objectContaining({ status: "ambiguous" }),
    }));
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "an action error",
      firstActionStatus: "error" as const,
      firstServerStatus: "off" as const,
      expectedErrorCode: "provider_action_failed" as const,
    },
    {
      label: "an unexpected running server",
      firstActionStatus: "success" as const,
      firstServerStatus: "running" as const,
      expectedErrorCode: "provider_response_invalid" as const,
    },
  ])("keeps $label sticky and never turns it into created-off on replay", async ({
    firstActionStatus,
    firstServerStatus,
    expectedErrorCode,
  }) => {
    const fixture = await capacityFixture();
    const observingOrder = {
      ...fixture.order,
      sshKeyPostAttemptedAt: fixture.attemptedAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
      serverPostAttemptedAt: fixture.attemptedAt,
      providerServerStatus: "accepted" as const,
      operation: {
        ...fixture.order.operation,
        providerServerId: "42",
        providerActionId: "500",
        providerActionCommand: "create_server",
        providerActionStatus: "running" as const,
      },
    };
    const firstAction = {
      ...fixture.mainAction,
      status: firstActionStatus,
    };
    const firstServer = {
      ...fixture.exactServer,
      status: firstServerStatus,
    };
    const getAction = jest
      .fn()
      .mockResolvedValueOnce(firstAction)
      .mockResolvedValueOnce(fixture.mainAction);
    const getServer = jest
      .fn()
      .mockResolvedValueOnce(firstServer)
      .mockResolvedValueOnce(fixture.exactServer);
    const createSshKey = jest.fn();
    const createServer = jest.fn();
    const provider = capacityClient({
      getAction,
      getServer,
      createSshKey,
      createServer,
    });
    let stickyOrder: StoredHetznerCloudCapacityOrder | null = null;
    const recordOrderProgress = jest
      .fn()
      .mockImplementationOnce(async (input) => {
        const progressOrder = {
          ...observingOrder,
          operation: {
            ...observingOrder.operation,
            providerActionStatus: input.providerActionStatus,
            providerNextActions: input.providerNextActions,
            providerObservedAt: input.providerObservedAt,
            observedServerStatus: input.observedServerStatus,
          },
        };
        return progressOrder;
      })
      .mockRejectedValueOnce(new InfrastructureConnectionStoreError("conflict"));
    const recordOrderResult = jest.fn(async (input): Promise<StoredHetznerCloudCapacityOrder> => {
      const nextOrder: StoredHetznerCloudCapacityOrder = {
        ...observingOrder,
        operation: {
          ...observingOrder.operation,
          status: "ambiguous" as const,
          providerActionStatus: firstActionStatus,
          providerObservedAt: fixture.attemptedAt,
          observedServerStatus: firstServerStatus,
          errorCode: input.errorCode,
          replayed: true,
        },
      };
      stickyOrder = nextOrder;
      return nextOrder;
    });
    const common = {
      now: () => new Date(Date.parse(fixture.attemptedAt) + 61_000),
      generateBootstrap: () => fixture.bootstrap,
      loadQuote: jest.fn().mockResolvedValue({
        quote: fixture.quote,
        connectionRevision: 7,
        providerLabels: fixture.captured.providerLabels,
        quoteFingerprintSha256: fixture.captured.quoteFingerprintSha256,
      }),
      loadBootstrap: jest.fn().mockResolvedValue(fixture.bootstrap),
      loadSecret: jest.fn().mockResolvedValue({
        connection: { id: CONNECTION_ID, status: "ready" },
        revision: 7,
        apiToken: TOKEN,
      }),
      client: () => provider,
      recordOrderProgress,
      recordOrderResult,
      upsertInventoryServer: jest.fn().mockResolvedValue({}),
      listInventory: jest.fn().mockResolvedValue([{ providerResourceId: "42" }]),
    };

    const first = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: observingOrder,
        }),
      },
    );

    expect(first.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      errorCode: expectedErrorCode,
      createdPoweredOff: false,
      providerActionStatus: firstActionStatus,
      observedServerStatus: firstServerStatus,
    }));
    expect(stickyOrder).not.toBeNull();
    if (!stickyOrder) throw new Error("sticky provider evidence was not recorded");

    await expect(createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: fixture.quote.id,
        idempotencyKey: fixture.idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        ...common,
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: stickyOrder,
        }),
      },
    )).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    expect(recordOrderProgress).toHaveBeenCalledTimes(2);
    expect(recordOrderResult).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "created_off",
    }));
    expect(createSshKey).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it("maps only the official token_readonly provider code to the Read & Write error", async () => {
    await expect(quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient({
          listServerTypes: jest.fn().mockRejectedValue(
            new HetznerCloudApiError(
              401,
              "GET",
              "/server_types",
              "request_failed",
              "token_readonly",
            ),
          ),
        }),
      },
    )).rejects.toEqual(expect.objectContaining<Partial<HetznerCloudCapacityError>>({
      code: "token_read_only",
    }));
  });

  it("returns a persisted same-key terminal replay after quote expiry without a second provider call", async () => {
    let quoteRecord: {
      quote: Awaited<ReturnType<typeof quoteHetznerCloudCapacity>>;
      providerLabels: Record<string, string>;
      quoteFingerprintSha256: string;
    } | null = null;
    const quote = await quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient(),
        createQuote: jest.fn(async (input) => {
          quoteRecord = {
            quote: input.quote,
            providerLabels: input.providerLabels,
            quoteFingerprintSha256: input.quoteFingerprintSha256,
          };
          return input.quote;
        }),
      },
    );
    expect(quoteRecord).not.toBeNull();
    const captured = quoteRecord!;
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    const loadSecret = jest.fn();
    const client = jest.fn();
    const createdAt = "2026-08-26T15:01:00.000Z";
    const terminalOrder = {
      operation: {
        id: quote.id,
        connectionId: CONNECTION_ID,
        idempotencyKey,
        status: "created_off" as const,
        providerServerId: "42",
        providerActionId: "500",
        providerActionCommand: "create_server",
        providerActionStatus: "success" as const,
        providerNextActions: [],
        observedServerStatus: "off" as const,
        providerObservedAt: createdAt,
        errorCode: null,
        canarySlotHeld: true,
        replayed: true,
        quote,
        createdPoweredOff: true,
        launchReady: false as const,
        launchBlockedReason:
          "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
        createdAt,
        updatedAt: createdAt,
      },
      connectionRevision: 7,
      providerLabels: captured.providerLabels,
      quoteFingerprintSha256: captured.quoteFingerprintSha256,
      sshKeyPostAttemptedAt: createdAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
      serverPostAttemptedAt: createdAt,
      providerServerStatus: "accepted" as const,
      bootstrapPublicKey: "ssh-ed25519 AAAA hivra-capacity",
      bootstrapPublicKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      creationReceipt: null,
    };

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: quote.id,
        idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date("2026-08-26T17:00:00.000Z"),
        loadQuote: jest.fn().mockResolvedValue({
          quote,
          connectionRevision: 7,
          providerLabels: captured.providerLabels,
          quoteFingerprintSha256: captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: terminalOrder,
        }),
        loadSecret,
        client,
        listInventory: jest.fn().mockResolvedValue([]),
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "created_off",
      replayed: true,
    }));
    expect(loadSecret).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it("enriches an ambiguous same-key replay when the exact server becomes visible without another POST", async () => {
    let quoteRecord: {
      quote: Awaited<ReturnType<typeof quoteHetznerCloudCapacity>>;
      providerLabels: Record<string, string>;
      quoteFingerprintSha256: string;
    } | null = null;
    const quote = await quoteHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      { serverTypeId: 104, locationId: 1, imageId: 100 },
      {
        now: () => NOW,
        newId: () => QUOTE_ID,
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient(),
        createQuote: jest.fn(async (input) => {
          quoteRecord = {
            quote: input.quote,
            providerLabels: input.providerLabels,
            quoteFingerprintSha256: input.quoteFingerprintSha256,
          };
          return input.quote;
        }),
      },
    );
    const captured = quoteRecord!;
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    const attemptedAt = "2026-08-26T15:01:00.000Z";
    const ambiguousOrder = {
      operation: {
        id: quote.id,
        connectionId: CONNECTION_ID,
        idempotencyKey,
        status: "ambiguous" as const,
        providerServerId: null,
        providerActionId: null,
        providerActionCommand: null,
        providerActionStatus: null,
        providerNextActions: [],
        observedServerStatus: null,
        providerObservedAt: null,
        errorCode: "provider_conflict" as const,
        canarySlotHeld: true,
        replayed: true,
        quote,
        createdPoweredOff: false,
        launchReady: false as const,
        launchBlockedReason:
          "Hetzner Cloud servers can be created powered off, but they are not prepared or authorized for agent launch.",
        createdAt: attemptedAt,
        updatedAt: attemptedAt,
      },
      connectionRevision: 7,
      providerLabels: captured.providerLabels,
      quoteFingerprintSha256: captured.quoteFingerprintSha256,
      sshKeyPostAttemptedAt: attemptedAt,
      providerSshKeyStatus: "accepted" as const,
      providerSshKeyId: "77",
      serverPostAttemptedAt: attemptedAt,
      providerServerStatus: "ambiguous" as const,
      bootstrapPublicKey: "ssh-ed25519 AAAA hivra-capacity",
      bootstrapPublicKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      creationReceipt: null,
    };
    const exactServer = {
      ...server,
      name: quote.serverName,
      status: "starting" as const,
      labels: captured.providerLabels,
      backup_window: null,
      image: {
        id: 100,
        type: "system" as const,
        status: "available" as const,
        name: "ubuntu-24.04",
        description: "Ubuntu 24.04",
        image_size: 2,
        disk_size: 10,
        created: "2026-08-20T12:00:00+00:00",
        deleted: null,
        created_from: null,
        bound_to: null,
        os_flavor: "ubuntu",
        os_version: "24.04",
        architecture: "x86" as const,
      },
    };
    const createServer = jest.fn();
    const createSshKey = jest.fn();
    const recordOrderResult = jest.fn(async (input) => ({
      ...ambiguousOrder,
      operation: {
        ...ambiguousOrder.operation,
        providerServerId: input.providerServerId,
        providerObservedAt: input.providerObservedAt ?? null,
        observedServerStatus: input.observedServerStatus ?? null,
      },
    }));

    const result = await createHetznerCloudCapacity(
      "user_a",
      CONNECTION_ID,
      {
        quoteId: quote.id,
        idempotencyKey,
        spendingConfirmation: "Create server and start billing",
      },
      {
        now: () => new Date("2026-08-26T15:02:00.000Z"),
        loadQuote: jest.fn().mockResolvedValue({
          quote,
          connectionRevision: 7,
          providerLabels: captured.providerLabels,
          quoteFingerprintSha256: captured.quoteFingerprintSha256,
        }),
        claimOrder: jest.fn().mockResolvedValue({
          outcome: "replay",
          execute: false,
          order: ambiguousOrder,
        }),
        loadBootstrap: jest.fn().mockResolvedValue({}),
        loadSecret: jest.fn().mockResolvedValue({
          connection: { id: CONNECTION_ID, status: "ready" },
          revision: 7,
          apiToken: TOKEN,
        }),
        client: () => capacityClient({
          findServersByName: jest.fn().mockResolvedValue([exactServer]),
          createServer,
          createSshKey,
        }),
        upsertInventoryServer: jest.fn().mockResolvedValue({}),
        listInventory: jest.fn().mockResolvedValue([{
          providerResourceId: "42",
        }]),
        recordOrderResult,
      },
    );

    expect(result.operation).toEqual(expect.objectContaining({
      status: "ambiguous",
      providerServerId: "42",
      providerObservedAt: "2026-08-26T15:02:00.000Z",
      observedServerStatus: "starting",
      replayed: true,
    }));
    expect(recordOrderResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "ambiguous",
      providerServerId: "42",
      providerObservedAt: "2026-08-26T15:02:00.000Z",
      observedServerStatus: "starting",
    }));
    expect(createServer).not.toHaveBeenCalled();
    expect(createSshKey).not.toHaveBeenCalled();

    async function replayNonExactServer(
      candidate: Record<string, unknown>,
      observedAt: string,
    ) {
      const upsert = jest.fn();
      const record = jest.fn(async (input) => ({
        ...ambiguousOrder,
        operation: {
          ...ambiguousOrder.operation,
          providerServerId: input.providerServerId ?? null,
        },
      }));
      const replayResult = await createHetznerCloudCapacity(
        "user_a",
        CONNECTION_ID,
        {
          quoteId: quote.id,
          idempotencyKey,
          spendingConfirmation: "Create server and start billing",
        },
        {
          now: () => new Date(observedAt),
          loadQuote: jest.fn().mockResolvedValue({
            quote,
            connectionRevision: 7,
            providerLabels: captured.providerLabels,
            quoteFingerprintSha256: captured.quoteFingerprintSha256,
          }),
          claimOrder: jest.fn().mockResolvedValue({
            outcome: "replay",
            execute: false,
            order: ambiguousOrder,
          }),
          loadBootstrap: jest.fn().mockResolvedValue({}),
          loadSecret: jest.fn().mockResolvedValue({
            connection: { id: CONNECTION_ID, status: "ready" },
            revision: 7,
            apiToken: TOKEN,
          }),
          client: () => capacityClient({
            findServersByName: jest.fn().mockResolvedValue([candidate]),
            createServer,
            createSshKey,
          }),
          upsertInventoryServer: upsert,
          listInventory: jest.fn().mockResolvedValue([]),
          recordOrderResult: record,
        },
      );
      expect(replayResult.operation.providerServerId).toBeNull();
      expect(upsert).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        status: "ambiguous",
        providerServerId: undefined,
      }));
    }

    await replayNonExactServer({
      ...exactServer,
      location: undefined,
      datacenter: {
        id: 1,
        name: "fsn1-dc14",
        description: "legacy location wrapper",
        location: exactServer.location,
      },
    }, "2026-08-26T15:03:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      volumes: [99],
    }, "2026-08-26T15:04:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      volumes: "99",
    }, "2026-08-26T15:05:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      backup_window: undefined,
    }, "2026-08-26T15:06:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      image: { ...exactServer.image, type: "snapshot" },
    }, "2026-08-26T15:06:30.000Z");
    await replayNonExactServer({
      ...exactServer,
      image: { ...exactServer.image, status: "unavailable" },
    }, "2026-08-26T15:06:35.000Z");
    await replayNonExactServer({
      ...exactServer,
      image: { ...exactServer.image, deleted: "2026-08-26T15:00:00Z" },
    }, "2026-08-26T15:06:40.000Z");
    await replayNonExactServer({
      ...exactServer,
      image: { ...exactServer.image, created_from: { id: 43 } },
    }, "2026-08-26T15:06:45.000Z");
    await replayNonExactServer({
      ...exactServer,
      image: { ...exactServer.image, bound_to: 43 },
    }, "2026-08-26T15:06:50.000Z");
    await replayNonExactServer({
      ...exactServer,
      primary_disk_size: 81,
    }, "2026-08-26T15:07:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      rescue_enabled: true,
    }, "2026-08-26T15:08:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      iso: { id: 9 },
    }, "2026-08-26T15:09:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      private_net: [{ network: 7 }],
    }, "2026-08-26T15:10:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      locked: true,
    }, "2026-08-26T15:11:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      protection: { delete: true, rebuild: false },
    }, "2026-08-26T15:12:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      protection: { delete: false, rebuild: true },
    }, "2026-08-26T15:13:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      public_net: { ...exactServer.public_net, floating_ips: [7] },
    }, "2026-08-26T15:14:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      load_balancers: [8],
    }, "2026-08-26T15:15:00.000Z");
    await replayNonExactServer({
      ...exactServer,
      placement_group: { id: 9 },
    }, "2026-08-26T15:16:00.000Z");
  });
});

describe("disclosed connect-time write check", () => {
  function connect(client: ReturnType<typeof projectClient>, createRecord = jest.fn().mockResolvedValue({
    connection: { id: CONNECTION_ID },
    inventory: [],
  })) {
    return {
      createRecord,
      result: connectHetznerCloudProject(
        { userId: "user_a", name: "My Hetzner", apiToken: TOKEN },
        { now: () => NOW, client: () => client, writeCheckKey: () => WRITE_CHECK_PROBE, createRecord },
      ),
    };
  }

  it("adds one labelled test key, deletes exactly that key, then saves the connection", async () => {
    const client = writeCheckClient();
    const { createRecord, result } = connect(client);
    await expect(result).resolves.toEqual({
      connection: { id: CONNECTION_ID },
      inventory: [],
      writeCheck: { strayKeyName: null },
    });
    expect(client.createSshKey).toHaveBeenCalledTimes(1);
    expect(client.createSshKey).toHaveBeenCalledWith({
      name: WRITE_CHECK_PROBE.name,
      publicKey: WRITE_CHECK_PROBE.publicKey,
      labels: { "hivra-check": "true" },
    });
    expect(client.deleteSshKey).toHaveBeenCalledWith(901);
    const order = [client.listServers, client.createSshKey, client.deleteSshKey, createRecord]
      .map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Nothing else in the project is touched.
    expect(client.createServer).not.toHaveBeenCalled();
    expect(client.changeServerType).not.toHaveBeenCalled();
  });

  it("fails a read-only token at connect with a same-screen fix and saves nothing", async () => {
    const client = writeCheckClient({
      createSshKey: jest.fn().mockRejectedValue(
        new HetznerCloudApiError(403, "POST", "/ssh_keys", "request_failed", "token_readonly"),
      ),
    });
    const { createRecord, result } = connect(client);
    const failure = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HetznerCloudTokenCheckError);
    expect(failure).toMatchObject({
      code: "token_read_only",
      message: "This token is read-only. Generate a Read & Write token in the same project and paste it here.",
    });
    expect(client.deleteSshKey).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("still connects when the test key cannot be deleted, and names the stray key", async () => {
    const client = writeCheckClient({
      deleteSshKey: jest.fn().mockRejectedValue(
        new HetznerCloudApiError(503, "DELETE", "/ssh_keys/{id}", "request_failed", "unavailable"),
      ),
    });
    const { createRecord, result } = connect(client);
    await expect(result).resolves.toMatchObject({ writeCheck: { strayKeyName: WRITE_CHECK_PROBE.name } });
    expect(createRecord).toHaveBeenCalledTimes(1);
  });

  it("finds and removes a key whose create response timed out", async () => {
    const client = writeCheckClient({
      createSshKey: jest.fn().mockRejectedValue(new HetznerCloudApiError(null, "POST", "/ssh_keys", "timeout")),
      findSshKeysByName: jest.fn().mockResolvedValue([
        { id: 902, name: WRITE_CHECK_PROBE.name, fingerprint: "x", public_key: WRITE_CHECK_PROBE.publicKey, labels: { "hivra-check": "true" }, created: NOW.toISOString() },
      ]),
    });
    const { result } = connect(client);
    await expect(result).resolves.toMatchObject({ writeCheck: { strayKeyName: null } });
    expect(client.findSshKeysByName).toHaveBeenCalledWith(WRITE_CHECK_PROBE.name);
    expect(client.deleteSshKey).toHaveBeenCalledWith(902);
  });

  it("does not claim write access when a timed-out create left nothing behind", async () => {
    const client = writeCheckClient({
      createSshKey: jest.fn().mockRejectedValue(new HetznerCloudApiError(null, "POST", "/ssh_keys", "timeout")),
      findSshKeysByName: jest.fn().mockResolvedValue([]),
    });
    const { createRecord, result } = connect(client);
    await expect(result).rejects.toMatchObject({ code: "write_check_unconfirmed" });
    expect(client.deleteSshKey).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("names the possible stray key when an uncertain create cannot be looked up", async () => {
    const client = writeCheckClient({
      createSshKey: jest.fn().mockRejectedValue(new HetznerCloudApiError(201, "POST", "/ssh_keys", "response_invalid")),
      findSshKeysByName: jest.fn().mockRejectedValue(new HetznerCloudApiError(null, "GET", "/ssh_keys", "timeout")),
    });
    const { createRecord, result } = connect(client);
    const failure = await result.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "write_check_unconfirmed", strayKeyName: WRITE_CHECK_PROBE.name });
    expect(String((failure as Error).message)).toContain(WRITE_CHECK_PROBE.name);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it.each([
    [new HetznerCloudApiError(403, "POST", "/ssh_keys", "request_failed", "resource_limit_exceeded"), "write_check_blocked"],
    [new HetznerCloudApiError(401, "POST", "/ssh_keys", "request_failed", "unauthorized"), "invalid_credentials"],
    [new HetznerCloudApiError(503, "POST", "/ssh_keys", "request_failed", "unavailable"), "provider_unavailable"],
  ])("maps a refused test key (%s) without saving", async (error, code) => {
    const client = writeCheckClient({ createSshKey: jest.fn().mockRejectedValue(error) });
    const { createRecord, result } = connect(client);
    await expect(result).rejects.toMatchObject({ code });
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("generates a parseable public-only Ed25519 test key with a random hivra-check name", () => {
    const first = generateHetznerWriteCheckKey();
    const second = generateHetznerWriteCheckKey();
    expect(Object.keys(first).sort()).toEqual(["name", "publicKey"]);
    expect(first.name).toMatch(/^hivra-check-[0-9a-f]{12}$/);
    expect(first.name).not.toBe(second.name);
    expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68} hivra-check$/);
    const parsed = ssh2Utils.parseKey(first.publicKey);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    expect(parsed.isPrivateKey()).toBe(false);
  });
});

describe("Hetzner token replacement", () => {
  const scope = {
    revision: 7,
    encryptedEnvelope: "sealed-old-envelope",
    heldServerIds: ["42"],
    heldSshKeyIds: ["777"],
  };
  const NEW_TOKEN = "replacement-project-token-value";
  const savedConnection = { id: CONNECTION_ID, status: "ready" };

  function harness(client: ReturnType<typeof projectClient>, overrides: Record<string, unknown> = {}) {
    const deps = {
      now: () => NOW,
      client: jest.fn(() => client),
      writeCheckKey: () => WRITE_CHECK_PROBE,
      loadTokenReplacementScope: jest.fn().mockResolvedValue(scope),
      replaceToken: jest.fn().mockResolvedValue(undefined),
      reconcileInventory: jest.fn().mockResolvedValue([{ id: "inventory-row" }]),
      listInventory: jest.fn().mockResolvedValue([{ id: "saved-row" }]),
      loadSecret: jest.fn().mockResolvedValue({ connection: savedConnection, revision: 7, apiToken: NEW_TOKEN }),
      ...overrides,
    };
    return {
      deps,
      run: () => replaceHetznerCloudToken(
        { userId: "user_a", connectionId: CONNECTION_ID, apiToken: NEW_TOKEN },
        deps as never,
      ),
    };
  }

  it("swaps the envelope at the same revision after proving the same project and write access", async () => {
    const client = writeCheckClient();
    const { deps, run } = harness(client);
    await expect(run()).resolves.toEqual({
      connection: savedConnection,
      inventory: [{ id: "inventory-row" }],
      writeCheck: { strayKeyName: null },
    });
    expect(deps.client).toHaveBeenCalledWith(NEW_TOKEN);
    expect(client.createSshKey).toHaveBeenCalledTimes(1);
    expect(client.deleteSshKey).toHaveBeenCalledWith(901);
    expect(deps.replaceToken).toHaveBeenCalledWith({
      userId: "user_a",
      connectionId: CONNECTION_ID,
      expectedRevision: 7,
      expectedEnvelope: "sealed-old-envelope",
      apiToken: NEW_TOKEN,
    });
    expect(deps.reconcileInventory).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_a", connectionId: CONNECTION_ID, expectedRevision: 7, discoveredAt: NOW.toISOString(),
      inventory: [expect.objectContaining({ providerResourceId: "42" })],
    }));
    expect(deps.loadSecret).toHaveBeenCalledWith("user_a", CONNECTION_ID, { requireBoundToken: true });
    // The swap happens only after every provider check.
    expect(deps.replaceToken.mock.invocationCallOrder[0])
      .toBeGreaterThan(client.deleteSshKey.mock.invocationCallOrder[0]);
  });

  it("refuses a token for another project before any write or swap", async () => {
    const client = writeCheckClient({
      listServers: jest.fn().mockResolvedValue([{ ...server, id: 4242 }]),
      listSshKeys: jest.fn().mockResolvedValue([{ id: 888, name: "other", fingerprint: "x", public_key: "x", labels: {}, created: NOW.toISOString() }]),
    });
    const { deps, run } = harness(client);
    await expect(run()).rejects.toMatchObject({ code: "token_project_mismatch" });
    expect(client.createSshKey).not.toHaveBeenCalled();
    expect(deps.replaceToken).not.toHaveBeenCalled();
    expect(deps.reconcileInventory).not.toHaveBeenCalled();
  });

  it("accepts the same project when only the generated SSH key is still visible", async () => {
    const client = writeCheckClient({
      listServers: jest.fn().mockResolvedValue([]),
      listSshKeys: jest.fn().mockResolvedValue([{ id: 777, name: "hivra-key-abc", fingerprint: "x", public_key: "x", labels: {}, created: NOW.toISOString() }]),
    });
    const { deps, run } = harness(client);
    await run();
    expect(deps.replaceToken).toHaveBeenCalledTimes(1);
  });

  it("does not list keys or require overlap when Hivra holds nothing in the project", async () => {
    const client = writeCheckClient({ listServers: jest.fn().mockResolvedValue([]) });
    const { deps, run } = harness(client, {
      loadTokenReplacementScope: jest.fn().mockResolvedValue({ ...scope, heldServerIds: [], heldSshKeyIds: [] }),
    });
    await run();
    expect(client.listSshKeys).not.toHaveBeenCalled();
    expect(deps.replaceToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the old token when the new one is read-only", async () => {
    const client = writeCheckClient({
      createSshKey: jest.fn().mockRejectedValue(
        new HetznerCloudApiError(403, "POST", "/ssh_keys", "request_failed", "token_readonly"),
      ),
    });
    const { deps, run } = harness(client);
    await expect(run()).rejects.toMatchObject({ code: "token_read_only" });
    expect(deps.replaceToken).not.toHaveBeenCalled();
  });

  it("keeps the old token when Hetzner rejects the new one", async () => {
    const client = writeCheckClient({
      listServers: jest.fn().mockRejectedValue(new HetznerCloudApiError(401, "GET", "/servers", "request_failed")),
    });
    const { deps, run } = harness(client);
    await expect(run()).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(deps.replaceToken).not.toHaveBeenCalled();
  });

  it("shows the saved inventory when a newer sync won the write after the swap", async () => {
    const client = writeCheckClient();
    const { deps, run } = harness(client, {
      reconcileInventory: jest.fn().mockRejectedValue(new InfrastructureConnectionStoreError("conflict")),
    });
    await expect(run()).resolves.toMatchObject({ inventory: [{ id: "saved-row" }] });
    expect(deps.listInventory).toHaveBeenCalledWith("user_a", CONNECTION_ID);
  });

  it("fails closed when the saved envelope does not read back as the new token", async () => {
    const client = writeCheckClient();
    const { run } = harness(client, {
      loadSecret: jest.fn().mockResolvedValue({ connection: savedConnection, revision: 7, apiToken: "someone-else" }),
    });
    await expect(run()).rejects.toMatchObject({ code: "conflict" });
  });

  it("propagates a busy credential (cleanup or a running setup step) without retrying", async () => {
    const client = writeCheckClient();
    const busy = new InfrastructureConnectionStoreError("capacity_busy");
    const { deps, run } = harness(client, { replaceToken: jest.fn().mockRejectedValue(busy) });
    await expect(run()).rejects.toBe(busy);
    expect(deps.replaceToken).toHaveBeenCalledTimes(1);
    expect(deps.reconcileInventory).not.toHaveBeenCalled();
  });
});
