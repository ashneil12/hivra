import { verifyEnrolledGuest, inspectEnrolledGuest, installEnrolledGuestBundle, prepareEnrolledGuest } from "../enrolled-guest-verification";
import { providerVmTarget } from "./provider-vm-target.fixtures";
import { providerGuestBundleReceipt } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "../portable-provisioner-contract";
import { guestDiscoveryOutput } from "./provider-guest-discovery.fixtures";
import { FirstBootSshError } from "../first-boot-ssh";
import { firstBootFirewallRequest } from "@/lib/hetzner/first-boot-firewall";
import { generateHetznerBootstrapBundle } from "../hetzner-cloud";
import { receiverFixture,firstBootNow } from "./first-boot-receiver.fixtures";
import type { FirstBootOperation } from "../first-boot-operations";
import type { HetznerAction } from "@/lib/hetzner/client";
import { verifyEnrolledProviderReceipt, verifyEnrolledProviderPowerReceipt } from "../enrolled-provider-receipt";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function setup(){
  const f=receiverFixture(),scope={binding:f.binding,providerServerId:"42"};
  const lease={...scope,leaseId:"55555555-5555-4555-8555-555555555555"};
  f.stored.phase="enrolled";f.stored.enrolledHostPublicKey=f.host.publicKey;f.stored.hostFingerprintSha256=f.host.fingerprintSha256;
  const firewallScope={orderId:f.binding.orderId,attemptId:f.binding.attemptId,quoteFingerprint:f.binding.quoteFingerprint,serverId:42};
  const request=firstBootFirewallRequest(firewallScope);
  const firewall={id:91,name:request.name,labels:request.labels,created:firstBootNow.toISOString(),
    rules:request.rules.map(rule=>({...rule,destination_ips:[]})),applied_to:request.apply_to};
  const receipt={version:1 as const,scope:firewallScope,firewallId:91,createdAt:firewall.created,setRulesActionId:601,applyActionId:602};
  const actions:Record<number,HetznerAction>={500:f.action,
    601:{id:601,command:"set_firewall_rules",status:"success",resources:[{id:91,type:"firewall"}]},
    602:{id:602,command:"apply_firewall",status:"success",resources:[{id:91,type:"firewall"},{id:42,type:"server"}]},
    603:{id:603,command:"start_server",status:"success",resources:[{id:42,type:"server"}]}};
  f.server.public_net.firewalls=[{id:91,status:"applied"}];
  const operation:FirstBootOperation={...scope,leaseId:lease.leaseId,leaseExpiresAt:new Date(firstBootNow.getTime()+120_000).toISOString(),
    firewallPostAttemptedAt:firewall.created,firewallReceipt:receipt,firewallVerifiedAt:firewall.created,
    powerOnPostAttemptedAt:firewall.created,powerOnAction:actions[603] as FirstBootOperation["powerOnAction"],abandonedAt:null};
  const bootstrap=generateHetznerBootstrapBundle({userId:f.binding.userId,connectionId:f.binding.connectionId,
    connectionRevision:7,orderId:f.binding.orderId,quoteFingerprintSha256:f.binding.quoteFingerprint});
  let elapsed=0;
  const client={getServer:jest.fn(async()=>structuredClone(f.server)),getAction:jest.fn(async(id:number)=>structuredClone(actions[id])),
    getFirewall:jest.fn(async()=>structuredClone(firewall))};
  const deps={
    claim:jest.fn(async()=>({outcome:"claimed" as const,lease:structuredClone(lease),operation:structuredClone(operation)})),
    evidence:jest.fn(async()=>structuredClone(f.evidence)),enrollment:jest.fn(async()=>structuredClone(f.stored)),
    secret:jest.fn(async()=>({connection:{id:f.binding.connectionId,status:"ready"},revision:7,apiToken:"fixture-project-token"}) as Awaited<ReturnType<typeof import("../hetzner-cloud-store").loadHetznerCloudConnectionSecret>>),
    bootstrap:jest.fn(async()=>bootstrap),client:jest.fn(()=>client),
    ssh:jest.fn(async()=>({hostVerified:true as const,administratorAuthenticated:true as const,hostFingerprintSha256:f.host.fingerprintSha256})),
    inspect:jest.fn<ReturnType<typeof import("../first-boot-ssh").inspectFirstBootGuest>,Parameters<typeof import("../first-boot-ssh").inspectFirstBootGuest>>(
      async()=>({hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:f.host.fingerprintSha256,output:guestDiscoveryOutput()})),
    loadBundle:jest.fn(async()=>PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath=>({relativePath,
      content:Buffer.from(relativePath==="VERSION"?PORTABLE_HIVRA_PROVISIONER_VERSION+"\n":"fixture:"+relativePath)}))),
    installBundle:jest.fn<ReturnType<typeof import("../first-boot-ssh").installFirstBootGuestBundle>,Parameters<typeof import("../first-boot-ssh").installFirstBootGuestBundle>>(
      async input=>({hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:f.host.fingerprintSha256,
        receipt:providerGuestBundleReceipt(input.scope,input.assets)})),
    release:jest.fn(async()=>true),now:()=>new Date(firstBootNow.getTime()+1_800_000),monotonicNow:()=>elapsed,
    publish:jest.fn(async()=>providerVmTarget()),
  };
  return {...f,scope,lease,operation,firewall,actions,bootstrap,client,deps,advance:(ms:number)=>{elapsed=ms;}};
}

describe("same-lease computer preparation", () => {
  it("identifies a missing bundle asset without logging an exception or credential", async () => {
    const h = setup();
    h.deps.loadBundle.mockRejectedValue(Object.assign(new Error("private path and secret"), { code: "ENOENT" }));
    await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toMatchObject({ code: "verification_failed" });
    expect(log.warn).toHaveBeenLastCalledWith("Provider guest preparation stopped", {
      source: "provider-computer-preparation", stage: "load_bundle", failureType: "ENOENT",
      orderId: h.binding.orderId, providerServerId: "42",
    });
    expect(JSON.stringify(jest.mocked(log.warn).mock.calls)).not.toContain("private path and secret");
    expect(h.deps.bootstrap).not.toHaveBeenCalled();
    expect(h.deps.release).toHaveBeenCalledWith(h.lease);
  });
  it("reports an unknown exception code only as unclassified", async () => {
    const h = setup();
    h.deps.inspect.mockRejectedValue(Object.assign(new Error("secret"), { code: "arbitrary-private-value" }));
    await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toThrow();
    expect(log.warn).toHaveBeenLastCalledWith("Provider guest preparation stopped", expect.objectContaining({
      stage: "guest_discovery", failureType: "unclassified",
    }));
    expect(JSON.stringify(jest.mocked(log.warn).mock.calls)).not.toContain("arbitrary-private-value");
  });
  it("inspects before writing, then publishes verified bundle evidence before releasing the original lease", async () => {
    const h = setup();
    expect(await prepareEnrolledGuest(h.scope, h.deps)).toEqual({ stage: "computer_prepared", target: providerVmTarget() });
    expect(h.deps.inspect.mock.invocationCallOrder[0]).toBeLessThan(h.deps.installBundle.mock.invocationCallOrder[0]);
    expect(h.deps.installBundle.mock.invocationCallOrder[0]).toBeLessThan(h.deps.publish.mock.invocationCallOrder[0]);
    expect(h.deps.publish.mock.invocationCallOrder[0]).toBeLessThan(h.deps.release.mock.invocationCallOrder[0]);
    expect(h.deps.publish).toHaveBeenCalledWith({ lease: h.lease, snapshot: expect.objectContaining({
      discoveryId: h.lease.leaseId, connectionId: h.binding.connectionId, connectionRevision: 7,
      providerServerId: "42", capacityOrderId: h.binding.orderId, enrollmentAttemptId: h.binding.attemptId,
    }), receipt: providerGuestBundleReceipt(h.scope, await h.deps.loadBundle()), powerOnAction: h.actions[603] });
  });
  it.each<Record<string, string>>([{ VIRTUALIZATION: "container" }, { ARCH_B64: Buffer.from("aarch64").toString("base64") },
    { OS_VERSION_ID_B64: Buffer.from("24.04").toString("base64") }, { MEMORY_AVAILABLE_BYTES: "0" }])(
    "rejects an unsupported observed environment before bundle writes: %j", async changes => {
      const h = setup();
      h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true,
        hostFingerprintSha256: h.host.fingerprintSha256, output: guestDiscoveryOutput(changes) });
      await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toThrow();
      expect(h.deps.installBundle).not.toHaveBeenCalled(); expect(h.deps.publish).not.toHaveBeenCalled();
      expect(h.deps.release).toHaveBeenCalledWith(h.lease);
    });
  it("keeps a lost delivery lease and never publishes uncertain bundle evidence", async () => {
    const h = setup(); h.deps.installBundle.mockRejectedValue(new Error("lost channel"));
    await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toMatchObject({ code: "bundle_outcome_unknown" });
    expect(h.deps.publish).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
  });
  it("does not turn failed publication into prepared success", async () => {
    const h = setup(); h.deps.publish.mockRejectedValue(new Error("lease changed"));
    await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toThrow();
    expect(h.deps.release).toHaveBeenCalledWith(h.lease);
  });
  it("does not publish after the original deadline elapsed during installation", async () => {
    const h = setup();
    h.deps.installBundle.mockImplementation(async input => { h.advance(30000); return {
      hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: h.host.fingerprintSha256,
      receipt: providerGuestBundleReceipt(input.scope, input.assets),
    }; });
    await expect(prepareEnrolledGuest(h.scope, h.deps)).rejects.toThrow(); expect(h.deps.publish).not.toHaveBeenCalled();
  });
});

describe("provider power observation", () => {
  it("keeps legacy SSH-only named-tunnel computers operable but requires HTTPS ingress for direct access", async () => {
    const h = setup(); h.server.status = "running";
    h.firewall.rules = h.firewall.rules.filter(rule => rule.port === "22");
    const input = { scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 };
    await expect(verifyEnrolledProviderReceipt(input, h.deps)).resolves.toMatchObject({ stage: "provider_verified" });
    await expect(verifyEnrolledProviderReceipt({ ...input, requireDirectHttps: true }, h.deps)).rejects.toThrow();
    await expect(verifyEnrolledProviderPowerReceipt({ ...input, requireDirectHttps: true }, h.deps)).rejects.toThrow();
    expect(h.deps.bootstrap).not.toHaveBeenCalled(); expect(h.deps.ssh).not.toHaveBeenCalled();
  });
  it.each(["running", "off"] as const)("observes the actual %s computer through original identity and firewall receipts", async state => {
    const h = setup(); h.server.status = state;
    expect(await verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .toMatchObject({ stage: "provider_verified", scope: h.scope, powerState: state, powerOnAction: h.actions[603] });
    expect(h.deps.client).toHaveBeenCalledWith("fixture-project-token");
    for (const unused of [h.deps.claim,h.deps.release,h.deps.bootstrap,h.deps.ssh,h.deps.inspect,h.deps.installBundle]) expect(unused).not.toHaveBeenCalled();
    expect(h.server.status).toBe(state);
  });
  it("accepts the exact terminal resize shape so a resized computer can Start and reach runtime verification", async () => {
    const h = setup();
    h.server.status = "running";
    Object.assign(h.server.server_type, {
      id: 204, name: "cpx32", description: "CPX 32", architecture: "x86",
      cores: 4, memory: 8, disk: 160, cpu_type: "shared",
    });
    h.server.primary_disk_size = 80;
    h.evidence.current_server_shape = {
      version: 1, provider: "hetzner-cloud", capacityOrderId: h.binding.orderId,
      connectionId: h.binding.connectionId, connectionRevision: 7, providerServerId: "42",
      resizeOperationId: "66666666-6666-4666-8666-666666666666",
      resizeQuoteFingerprintSha256: "b".repeat(64),
      previousShapeFingerprintSha256: h.binding.quoteFingerprint,
      serverType: { id: 204, name: "cpx32", architecture: "x86", cores: 4, memoryGb: 8,
        advertisedDiskGb: 160, cpuType: "shared" },
      primaryDiskGb: 80, observedAt: "2026-09-04T14:00:00.000Z",
    };
    h.evidence.current_server_shape_fingerprint_sha256 = "c".repeat(64);

    await expect(verifyEnrolledProviderPowerReceipt({
      scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000,
    }, h.deps)).resolves.toMatchObject({ stage: "provider_verified", powerState: "running" });

    h.server.server_type.cores = 8;
    await expect(verifyEnrolledProviderPowerReceipt({
      scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000,
    }, h.deps)).rejects.toMatchObject({ code: "resource_changed" });
  });
  it("does not relax the original preparation and runtime-readiness running gate", async () => {
    const h = setup(); h.server.status = "off";
    await expect(verifyEnrolledProviderReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .rejects.toMatchObject({ code: "resource_changed" });
  });
  it.each(["starting", "stopping", "initializing", "migrating"] as const)("keeps %s as a provider wait, without assuming a power result", async state => {
    const h = setup(); h.server.status = state;
    expect(await verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .toEqual({ stage: "waiting_for_provider" });
  });
  it.each(["unknown", "deleting", "rebuilding"] as const)("rejects an incompatible %s computer", async state => {
    const h = setup(); h.server.status = state;
    await expect(verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .rejects.toMatchObject({ code: "resource_changed" });
  });
  it.each(["server", "ipv4", "image", "firewall", "pin", "owner", "action"])("retains the original %s identity check even when the server is off", async change => {
    const h = setup(); h.server.status = "off";
    if (change === "server") h.server.id = 43;
    if (change === "ipv4") h.server.public_net.ipv4!.ip = "8.8.4.4";
    if (change === "image") h.server.image!.id = 101;
    if (change === "firewall") h.firewall.applied_to[0].server.id = 43;
    if (change === "pin") h.stored.hostFingerprintSha256 = "SHA256:changed";
    if (change === "owner") h.stored.challenge.binding.userId = "foreign";
    if (change === "action") h.actions[603].id = 604;
    await expect(verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps)).rejects.toThrow();
    expect(h.deps.bootstrap).not.toHaveBeenCalled();
  });
  it("does not accept a locked off server or late provider observation", async () => {
    const h = setup(); h.server.status = "off"; h.server.locked = true;
    expect(await verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .toEqual({ stage: "waiting_for_provider" });
    h.server.locked = false;
    h.client.getServer.mockImplementation(async () => { h.advance(30_000); return h.server; });
    await expect(verifyEnrolledProviderPowerReceipt({ scope: h.scope, operation: h.operation, dispatchDeadlineMs: 30_000 }, h.deps))
      .rejects.toMatchObject({ code: "deadline_expired" });
  });
});

describe("shared enrolled-provider receipt boundary",()=>{
  it("returns only original public identity, without acquiring a lease, opening an administrator key or connecting SSH",async()=>{
    const h=setup();
    const result=await verifyEnrolledProviderReceipt({scope:h.scope,operation:h.operation,dispatchDeadlineMs:30_000},h.deps);
    expect(result).toEqual({stage:"provider_verified",scope:h.scope,
      address:h.evidence.provider_creation_receipt.primaryIpv4.ip,hostPublicKey:h.host.publicKey,
      hostFingerprintSha256:h.host.fingerprintSha256,capacityIdempotencyKey:h.stored.capacityIdempotencyKey,
      observedAt:h.deps.now().toISOString(),powerOnAction:h.actions[603]});
    for(const unused of [h.deps.claim,h.deps.release,h.deps.bootstrap,h.deps.ssh,h.deps.inspect,h.deps.loadBundle,h.deps.installBundle]){
      expect(unused).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(result)).not.toContain("fixture-project-token");
    expect(JSON.stringify(result)).not.toContain(h.stored.challenge.verifierSha256);
    expect(JSON.stringify(result)).not.toContain(h.bootstrap.privateKeyOpenSsh);
    expect(result).not.toHaveProperty("ready");expect(result).not.toHaveProperty("leaseId");
  });

  it.each(["userId","connectionId","connectionRevision","orderId","attemptId","quoteFingerprint","recipeVersion","serverId"])(
    "rejects a journal from another %s before loading credentials or provider evidence",async part=>{
      const h=setup(),operation=structuredClone(h.operation);
      if(part==="serverId")operation.providerServerId="43";
      else if(part==="connectionRevision")operation.binding.connectionRevision=8;
      else if(part==="userId")operation.binding.userId="foreign-owner";
      else if(part==="quoteFingerprint")operation.binding.quoteFingerprint="f".repeat(64);
      else if(part==="recipeVersion")operation.binding.recipeVersion="future" as never;
      else operation.binding[part as "connectionId"|"orderId"|"attemptId"]="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await expect(verifyEnrolledProviderReceipt({scope:h.scope,operation,dispatchDeadlineMs:30_000},h.deps))
        .rejects.toThrow("Enrolled provider receipt failed:");
      expect(h.deps.evidence).not.toHaveBeenCalled();expect(h.deps.secret).not.toHaveBeenCalled();expect(h.deps.client).not.toHaveBeenCalled();
    });

  it.each([NaN,Infinity,-1,0,30_001])("rejects the invalid original deadline %s before any read",async deadline=>{
    const h=setup();
    await expect(verifyEnrolledProviderReceipt({scope:h.scope,operation:h.operation,dispatchDeadlineMs:deadline},h.deps))
      .rejects.toMatchObject({code:"deadline_expired"});
    expect(h.deps.evidence).not.toHaveBeenCalled();expect(h.deps.secret).not.toHaveBeenCalled();
  });

  it.each(["firewallPostAttemptedAt","firewallReceipt","firewallVerifiedAt","powerOnPostAttemptedAt","powerOnAction","abandonedAt"])(
    "rejects incomplete or revoked journal authority: %s",async field=>{
      const h=setup(),operation=structuredClone(h.operation);
      Object.assign(operation,{[field]:field==="abandonedAt"?firstBootNow.toISOString():null});
      await expect(verifyEnrolledProviderReceipt({scope:h.scope,operation,dispatchDeadlineMs:30_000},h.deps))
        .rejects.toMatchObject({code:"resource_changed"});
      expect(h.deps.evidence).not.toHaveBeenCalled();expect(h.deps.secret).not.toHaveBeenCalled();
    });

  it("snapshots caller-owned scope, journal and deadline before the first await",async()=>{
    const h=setup(),scope=structuredClone(h.scope),operation=structuredClone(h.operation);
    const input={scope,operation,dispatchDeadlineMs:30_000};
    h.deps.evidence.mockImplementation(async()=>{
      input.scope.binding.userId="changed-owner";
      input.scope.providerServerId="43";
      input.operation.firewallReceipt!.firewallId=92;
      input.operation.powerOnAction!.id=604;
      input.dispatchDeadlineMs=120_000;
      return structuredClone(h.evidence);
    });
    const result=await verifyEnrolledProviderReceipt(input,h.deps);
    expect(result).toMatchObject({stage:"provider_verified",scope:h.scope});
    expect(h.deps.secret).toHaveBeenCalledWith(h.binding.userId,h.binding.connectionId,{requireBoundToken:true});
    expect(h.client.getServer).toHaveBeenCalledWith(42);
    expect(h.client.getFirewall).toHaveBeenCalledWith(91);
    expect(h.client.getAction).toHaveBeenCalledWith(603);
    expect(h.client.getAction).not.toHaveBeenCalledWith(604);
  });

  it("does not extend its deadline when a caller changes the input during provider I/O",async()=>{
    const h=setup(),input={scope:h.scope,operation:h.operation,dispatchDeadlineMs:30_000};
    h.client.getServer.mockImplementation(async()=>{
      input.dispatchDeadlineMs=120_000;h.advance(30_000);return structuredClone(h.server);
    });
    await expect(verifyEnrolledProviderReceipt(input,h.deps)).rejects.toMatchObject({code:"deadline_expired"});
  });

  it.each(["evidence","enrollment","secret","provider"])("redacts raw %s failures",async boundary=>{
    const h=setup(),privateError=new Error("fixture-project-token "+h.bootstrap.privateKeyOpenSsh);
    if(boundary==="evidence")h.deps.evidence.mockRejectedValue(privateError);
    if(boundary==="enrollment")h.deps.enrollment.mockRejectedValue(privateError);
    if(boundary==="secret")h.deps.secret.mockRejectedValue(privateError);
    if(boundary==="provider")h.client.getServer.mockRejectedValue(privateError);
    await expect(verifyEnrolledProviderReceipt({scope:h.scope,operation:h.operation,dispatchDeadlineMs:30_000},h.deps))
      .rejects.toThrow("Enrolled provider receipt failed: verification_failed");
  });
});

it("verifies original live receipt/firewall/pin with the owner key after token expiry, without readiness",async()=>{
  const h=setup();expect(Date.parse(h.stored.challenge.expiresAt)).toBeLessThan(h.deps.now().getTime());
  await expect(verifyEnrolledGuest(h.scope,h.deps)).resolves.toEqual({stage:"identity_verified",hostFingerprintSha256:h.host.fingerprintSha256,observedAt:h.deps.now().toISOString()});
  expect(h.deps.client).toHaveBeenCalledWith("fixture-project-token");
  expect(h.deps.ssh).toHaveBeenCalledWith({address:h.evidence.provider_creation_receipt.primaryIpv4.ip,hostPublicKey:h.host.publicKey,
    administratorPublicKey:h.bootstrap.publicKeyOpenSsh,administratorPrivateKey:h.bootstrap.privateKeyOpenSsh,dispatchDeadlineMs:30_000},
  {monotonicNow:h.deps.monotonicNow});
  expect(h.deps.bootstrap).toHaveBeenCalledWith({userId:h.binding.userId,connectionId:h.binding.connectionId,expectedRevision:7,
    orderId:h.binding.orderId,idempotencyKey:h.stored.capacityIdempotencyKey,quoteFingerprintSha256:h.binding.quoteFingerprint});
  expect(h.deps.release).toHaveBeenCalledWith(h.lease);
});

describe("owner-leased guest bundle installation",()=>{
  it("uses the original lease and owner key, verifies a concrete receipt and releases only after completion",async()=>{
    const h=setup();
    h.deps.installBundle.mockImplementation(async input=>{
      expect(h.deps.release).not.toHaveBeenCalled();expect(input.scope).toEqual(h.scope);
      expect(input).toMatchObject({hostPublicKey:h.host.publicKey,administratorPrivateKey:h.bootstrap.privateKeyOpenSsh,
        dispatchDeadlineMs:30_000,address:h.evidence.provider_creation_receipt.primaryIpv4.ip});
      const receipt=providerGuestBundleReceipt(input.scope,input.assets);
      // JSON property order is not part of the receipt protocol.
      return {hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:h.host.fingerprintSha256,
        receipt:JSON.parse(JSON.stringify(receipt,Object.keys(receipt).reverse()))};
    });
    const result=await installEnrolledGuestBundle(h.scope,h.deps);
    expect(result).toMatchObject({stage:"bundle_installed",observedAt:h.deps.now().toISOString(),receipt:{provisionerVersion:PORTABLE_HIVRA_PROVISIONER_VERSION}});
    expect(result).not.toHaveProperty("deploymentTarget");expect(result).not.toHaveProperty("ready");
    expect(h.deps.installBundle).toHaveBeenCalledTimes(1);expect(h.deps.release).toHaveBeenCalledTimes(1);
    expect(h.deps.ssh).not.toHaveBeenCalled();expect(h.deps.inspect).not.toHaveBeenCalled();
  });
  it.each(["busy","rejected","revoked","provider_changed","provider_pending","revision_changed","expired_claim","expired_bundle","invalid_bundle","key_failed"])(
    "never installs without valid current authority and assets: %s",async change=>{
      const h=setup();
      if(change==="busy" || change==="rejected")h.deps.claim.mockResolvedValue({outcome:change} as never);
      if(change==="revoked")h.stored.phase="revoked";
      if(change==="provider_changed")h.server.id=43;
      if(change==="provider_pending")h.actions[603].status="running";
      if(change==="revision_changed")h.deps.secret.mockResolvedValue({connection:{id:h.binding.connectionId,status:"ready"},revision:8,apiToken:"wrong"} as never);
      if(change==="expired_claim")h.deps.claim.mockImplementation(async()=>{h.advance(30_000);return {outcome:"claimed",lease:h.lease,operation:h.operation};});
      if(change==="expired_bundle"){
        const original=h.deps.loadBundle.getMockImplementation()!;
        h.deps.loadBundle.mockImplementation(async()=>{const result=await original();h.advance(30_000);return result;});
      }
      if(change==="invalid_bundle")h.deps.loadBundle.mockResolvedValue([]);
      if(change==="key_failed")h.deps.bootstrap.mockRejectedValue(new Error("private"));
      if(change==="busy" || change==="provider_pending")await expect(installEnrolledGuestBundle(h.scope,h.deps)).resolves.toMatchObject({stage:change==="busy"?"busy":"waiting_for_provider"});
      else await expect(installEnrolledGuestBundle(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed:");
      expect(h.deps.installBundle).not.toHaveBeenCalled();
      if(change!=="busy" && change!=="rejected")expect(h.deps.release).toHaveBeenCalledWith(h.lease);
    });
  it.each(["disconnect","timeout","pin","digest","late_receipt"])("retains the shared lease when %s leaves an uncertain mutation",async change=>{
    const h=setup(),original=h.deps.installBundle.getMockImplementation()!;
    h.deps.installBundle.mockImplementation(async(...args)=>{
      if(change==="disconnect")throw new Error("private credentials or diagnostics");
      if(change==="timeout")throw new FirstBootSshError("deadline_expired");
      const result=await original(...args);
      if(change==="pin")result.hostFingerprintSha256="SHA256:changed";
      if(change==="digest")result.receipt.bundleSha256="b".repeat(64);
      if(change==="late_receipt")h.advance(30_000);
      return result;
    });
    await expect(installEnrolledGuestBundle(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed: bundle_outcome_unknown");
    expect(h.deps.release).not.toHaveBeenCalled();expect(h.deps.installBundle).toHaveBeenCalledTimes(1);
  });
  it("fails a missing or late release acknowledgement instead of claiming completed delivery",async()=>{
    const h=setup();h.deps.release.mockResolvedValue(false);
    await expect(installEnrolledGuestBundle(h.scope,h.deps)).rejects.toMatchObject({code:"checkpoint_failed"});
    h.deps.release.mockImplementation(async()=>{h.advance(30_000);return true;});
    await expect(installEnrolledGuestBundle(h.scope,h.deps)).rejects.toMatchObject({code:"deadline_expired"});
  });
});
it.each(["busy","rejected"])("does no provider, credential or SSH work on %s",async outcome=>{
  const h=setup();h.deps.claim.mockResolvedValue({outcome} as never);
  if(outcome==="busy")await expect(verifyEnrolledGuest(h.scope,h.deps)).resolves.toEqual({stage:"busy"});
  else await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toMatchObject({code:"rejected"});
  expect(h.deps.evidence).not.toHaveBeenCalled();expect(h.deps.secret).not.toHaveBeenCalled();expect(h.deps.ssh).not.toHaveBeenCalled();expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["revoked","failed","staged","awaiting_identity"] as const)("does not use non-enrolled authority: %s",async phase=>{
  const h=setup();h.stored.phase=phase;
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toMatchObject({code:"rejected"});
  expect(h.deps.secret).not.toHaveBeenCalled();expect(h.deps.release).toHaveBeenCalledWith(h.lease);
});
it.each(["server","ipv4","image","action","firewall","pin","owner","revision"])("rejects changed %s evidence before loading the administrator key",async changed=>{
  const h=setup();
  if(changed==="server")h.server.id=43;
  if(changed==="ipv4")h.server.public_net.ipv4!.ip="8.8.4.4";
  if(changed==="image")h.server.image!.id=101;
  if(changed==="action")h.actions[603].id=604;
  if(changed==="firewall")h.firewall.applied_to[0].server.id=43;
  if(changed==="pin")h.stored.hostFingerprintSha256="SHA256:changed";
  if(changed==="owner")h.stored.challenge.binding.userId="foreign";
  if(changed==="revision")h.deps.secret.mockResolvedValue({connection:{id:h.binding.connectionId,status:"ready"},revision:8,apiToken:"wrong"} as never);
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed:");
  expect(h.deps.bootstrap).not.toHaveBeenCalled();expect(h.deps.ssh).not.toHaveBeenCalled();expect(h.deps.release).toHaveBeenCalledWith(h.lease);
});
it.each(["locked","starting","power_pending","firewall_pending"])("shows a factual wait without SSH while %s",async state=>{
  const h=setup();if(state==="locked")h.server.locked=true;
  if(state==="starting")h.server.status="starting";
  if(state==="power_pending")h.actions[603].status="running";
  if(state==="firewall_pending")h.actions[602].status="running";
  await expect(verifyEnrolledGuest(h.scope,h.deps)).resolves.toEqual({stage:"waiting_for_provider"});
  expect(h.deps.bootstrap).not.toHaveBeenCalled();expect(h.deps.ssh).not.toHaveBeenCalled();
});
it.each(["claim","provider","bootstrap","ssh"])("fences stale %s work before accepting identity",async boundary=>{
  const h=setup();
  if(boundary==="claim")h.deps.claim.mockImplementation(async()=>{h.advance(30_000);return {outcome:"claimed",lease:h.lease,operation:h.operation};});
  if(boundary==="provider")h.client.getServer.mockImplementation(async()=>{h.advance(30_000);return h.server;});
  if(boundary==="bootstrap")h.deps.bootstrap.mockImplementation(async()=>{h.advance(30_000);return h.bootstrap;});
  if(boundary==="ssh")h.deps.ssh.mockImplementation(async()=>{h.advance(30_000);return {hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:h.host.fingerprintSha256};});
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toMatchObject({code:"deadline_expired"});
  if(boundary!=="ssh")expect(h.deps.ssh).not.toHaveBeenCalled();expect(h.deps.release).toHaveBeenCalledWith(h.lease);
});
it("propagates bounded SSH failures and never leaks raw transport or release errors",async()=>{
  const h=setup();h.deps.ssh.mockRejectedValue(new FirstBootSshError("deadline_expired"));
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toMatchObject({code:"deadline_expired"});
  h.deps.ssh.mockRejectedValue(new Error(h.bootstrap.privateKeyOpenSsh));
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed: verification_failed");
  h.deps.release.mockResolvedValue(false);
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed: checkpoint_failed");
});
it.each([30_000,120_001])("does not report identity success after a delayed %ims lease release",async elapsed=>{
  const h=setup();h.deps.release.mockImplementation(async()=>{h.advance(elapsed);return true;});
  await expect(verifyEnrolledGuest(h.scope,h.deps)).rejects.toMatchObject({code:"deadline_expired"});
  expect(h.deps.ssh).toHaveBeenCalledTimes(1);expect(h.deps.release).toHaveBeenCalledTimes(1);
});

describe("leased enrolled guest environment inspection",()=>{
  it("keeps the original owner lease until same-session inspection and parsing complete",async()=>{
    const h=setup();
    h.deps.inspect.mockImplementation(async input=>{
      expect(h.deps.release).not.toHaveBeenCalled();expect(input).toMatchObject({connectionId:h.binding.connectionId,
        address:h.evidence.provider_creation_receipt.primaryIpv4.ip,hostPublicKey:h.host.publicKey,
        administratorPrivateKey:h.bootstrap.privateKeyOpenSsh,dispatchDeadlineMs:30_000});
      return {hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:h.host.fingerprintSha256,output:guestDiscoveryOutput()};
    });
    const result=await inspectEnrolledGuest(h.scope,h.deps);
    expect(result).toMatchObject({stage:"environment_inspected",snapshot:{discoveryId:h.lease.leaseId,
      connectionId:h.binding.connectionId,connectionRevision:7,connectionProvider:"hetzner-cloud",providerServerId:"42",
      capacityOrderId:h.binding.orderId,enrollmentAttemptId:h.binding.attemptId,
      host:{os:{id:"ubuntu"},kernel:{architecture:"amd64"}}}});
    expect(h.deps.ssh).not.toHaveBeenCalled();expect(h.deps.inspect).toHaveBeenCalledTimes(1);
    expect(h.deps.release).toHaveBeenCalledWith(h.lease);expect(result).not.toHaveProperty("deploymentTarget");
  });
  it.each(["busy","revoked","provider_changed","provider_pending","revision_changed","bootstrap_failed"])("does not inspect without current authority: %s",async changed=>{
    const h=setup();
    if(changed==="busy")h.deps.claim.mockResolvedValue({outcome:"busy"} as never);
    if(changed==="revoked")h.stored.phase="revoked";
    if(changed==="provider_changed")h.server.public_net.ipv4!.ip="8.8.4.4";
    if(changed==="provider_pending")h.actions[603].status="running";
    if(changed==="revision_changed")h.deps.secret.mockResolvedValue({connection:{id:h.binding.connectionId,status:"ready"},revision:8,apiToken:"wrong"} as never);
    if(changed==="bootstrap_failed")h.deps.bootstrap.mockRejectedValue(new Error("private"));
    if(changed==="busy" || changed==="provider_pending")await expect(inspectEnrolledGuest(h.scope,h.deps)).resolves.toMatchObject({stage:changed==="busy"?"busy":"waiting_for_provider"});
    else await expect(inspectEnrolledGuest(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed:");
    expect(h.deps.inspect).not.toHaveBeenCalled();expect(h.deps.ssh).not.toHaveBeenCalled();
  });
  it.each(["pin","malformed_output","expired_inspection","expired_release","release_failed"])("rejects %s without publishing facts",async changed=>{
    const h=setup();
    if(changed==="pin")h.deps.inspect.mockResolvedValue({hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:"SHA256:changed",output:guestDiscoveryOutput()});
    if(changed==="malformed_output")h.deps.inspect.mockResolvedValue({hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:h.host.fingerprintSha256,output:"private malformed text"});
    if(changed==="expired_inspection")h.deps.inspect.mockImplementation(async()=>{h.advance(30_000);return {hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:h.host.fingerprintSha256,output:guestDiscoveryOutput()};});
    if(changed==="expired_release")h.deps.release.mockImplementation(async()=>{h.advance(30_000);return true;});
    if(changed==="release_failed")h.deps.release.mockResolvedValue(false);
    await expect(inspectEnrolledGuest(h.scope,h.deps)).rejects.toThrow("Enrolled guest verification failed:");
    expect(h.deps.release).toHaveBeenCalledTimes(1);
  });
});
