import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildReadOnlyHostDiscoveryScript, parseHostDiscoveryOutput, parseProviderGuestDiscoveryOutput } from "../host-discovery";
import { HostDiscoverySnapshotSchema, ProviderGuestDiscoverySnapshotSchema, MAX_HOST_DISCOVERY_OUTPUT_BYTES } from "../host-discovery-contracts";
import { guestDiscoveryOutput } from "./provider-guest-discovery.fixtures";

const input={discoveryId:"11111111-1111-4111-8111-111111111111",connectionId:"22222222-2222-4222-8222-222222222222",
  connectionRevision:7,providerServerId:"42",capacityOrderId:"33333333-3333-4333-8333-333333333333",
  enrollmentAttemptId:"44444444-4444-4444-8444-444444444444",normalizedHostFingerprint:"ab".repeat(32),observedAt:new Date("2026-08-27T19:00:00Z")};

it("uses the enrolled SSH-key digest required by provider publication without changing generic host identity",()=>{
  const keyWire=Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,1)]);
  const digest=createHash("sha256").update(keyWire).digest("hex");
  const discovery={...input,output:guestDiscoveryOutput(),normalizedHostFingerprint:`SHA256:${Buffer.from(digest,"hex").toString("base64").replace(/=+$/,"")}`};
  expect(parseProviderGuestDiscoveryOutput(discovery).hostIdentityDigest).toBe(digest);
  expect(parseProviderGuestDiscoveryOutput({...discovery,normalizedHostFingerprint:"cd".repeat(32)}).hostIdentityDigest).toBe("cd".repeat(32));
  const generic=parseHostDiscoveryOutput({...discovery,connectionProvider:"host"});
  expect(generic.hostIdentityDigest).not.toBe(digest);
  expect(parseHostDiscoveryOutput({...discovery,connectionProvider:"host",output:guestDiscoveryOutput({MACHINE_ID_DIGEST:"d".repeat(64)})}).hostIdentityDigest)
    .not.toBe(generic.hostIdentityDigest);
});

it("binds discovered VM facts to the original capacity/enrollment without Proxmox or launch authority",()=>{
  const snapshot=parseProviderGuestDiscoveryOutput({...input,output:guestDiscoveryOutput()});
  expect(snapshot).toMatchObject({connectionProvider:"hetzner-cloud",providerServerId:"42",connectionRevision:7,
    capacityOrderId:input.capacityOrderId,enrollmentAttemptId:input.enrollmentAttemptId,
    host:{os:{id:"ubuntu",versionId:"22.04"},kernel:{architecture:"amd64"},environment:{effectivePrivilege:"root",virtualization:"virtual-machine"},
      capacity:{cpu:{logicalCores:2}},kvm:{devicePresent:false,cpuVirtualization:false}}});
  expect(snapshot.engines.every(engine=>!engine.supported)).toBe(true);
  expect(HostDiscoverySnapshotSchema.safeParse(snapshot).success).toBe(false);
  expect(snapshot).not.toHaveProperty("deploymentTarget");expect(snapshot).not.toHaveProperty("launchReady");
});
it("does not promote a guest that happens to report installed Proxmox",()=>{
  const output=guestDiscoveryOutput({OS_ID_B64:Buffer.from("debian").toString("base64"),KVM_DEVICE:"1",CPU_VIRTUALIZATION:"1",
    PROXMOX_KVM_INSTALLED:"1",PROXMOX_KVM_VERSION_B64:Buffer.from("pve-manager/8.4.1").toString("base64")});
  expect(parseProviderGuestDiscoveryOutput({...input,output}).engines.find(engine=>engine.id==="proxmox-kvm"))
    .toMatchObject({availability:"installed",supported:false,unmetRequirements:expect.arrayContaining(["RUNTIME_ADAPTER_UNAVAILABLE"])});
});
it.each(["duplicate","incomplete","oversized","invalid_capacity","unsafe_text","bad_provider_id"])("rejects %s evidence",kind=>{
  let output=guestDiscoveryOutput();
  if(kind==="duplicate")output+="\nHIVRA_HOST_DISCOVERY_V1\tEND\t1";
  if(kind==="incomplete")output=output.split("\n").slice(1).join("\n");
  if(kind==="oversized")output+="x".repeat(MAX_HOST_DISCOVERY_OUTPUT_BYTES);
  if(kind==="invalid_capacity")output=guestDiscoveryOutput({MEMORY_TOTAL_BYTES:"1"});
  if(kind==="unsafe_text")output=guestDiscoveryOutput({OS_ID_B64:Buffer.from("ubuntu\nsecret").toString("base64")});
  expect(()=>parseProviderGuestDiscoveryOutput({...input,output,providerServerId:kind==="bad_provider_id"?"42;whoami":"42"})).toThrow();
});
it("preserves the bounded TTL and strict provider/identity contract",()=>{
  const snapshot=parseProviderGuestDiscoveryOutput({...input,output:guestDiscoveryOutput()});
  expect(ProviderGuestDiscoverySnapshotSchema.safeParse({...snapshot,expiresAt:input.observedAt.toISOString()}).success).toBe(false);
  expect(ProviderGuestDiscoverySnapshotSchema.safeParse({...snapshot,connectionProvider:"host"}).success).toBe(false);
  expect(ProviderGuestDiscoverySnapshotSchema.safeParse({...snapshot,capacityOrderId:"other"}).success).toBe(false);
  snapshot.engines[0].supported=true;
  expect(ProviderGuestDiscoverySnapshotSchema.safeParse(snapshot).success).toBe(false);
});
it("runs the real read-only probe locally, parses it without pretending this machine is a supported provider guest",()=>{
  const script=buildReadOnlyHostDiscoveryScript(input.connectionId);
  const run=spawnSync("bash",["--noprofile","--norc","-s"],{input:script,encoding:"utf8",timeout:10_000,maxBuffer:MAX_HOST_DISCOVERY_OUTPUT_BYTES,
    env:{PATH:"/usr/sbin:/usr/bin:/sbin:/bin",LC_ALL:"C",NODE_ENV:"test"}});
  expect(run.status).toBe(0);expect(run.error).toBeUndefined();
  const snapshot=parseProviderGuestDiscoveryOutput({...input,output:run.stdout});
  expect(snapshot.engines.every(engine=>!engine.supported)).toBe(true);
  expect(snapshot).not.toHaveProperty("ready");
});
