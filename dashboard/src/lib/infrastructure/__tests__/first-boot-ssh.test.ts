import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaseAgent, Client, Server, utils, type ConnectConfig, type Connection, type ParsedKey } from "ssh2";
import { verifyFirstBootSshIdentity, inspectFirstBootGuest, installFirstBootGuestBundle, controlProviderGuestInstaller, controlProviderNativeInstaller, inspectProviderGuestRuntime, inspectProviderShutdownReadiness } from "../first-boot-ssh";
import { PROVIDER_SHUTDOWN_READINESS_SCRIPT } from "../provider-shutdown-readiness";
import { buildProviderNativeWorkerPlan } from "../provider-native-worker";
import { buildProviderDesktopWorkerPlan } from "../provider-desktop-worker";
import { controlProviderDesktopInstaller, inspectProviderDesktopRuntime, inspectProviderDesktopPower, inspectProviderGuestClock, inspectProviderWorkspaceRuntime } from "../first-boot-ssh";
import { buildProviderDesktopRuntimeProbe, buildProviderDesktopPowerProbe, buildProviderWorkspaceRuntimeProbe } from "../provider-desktop-runtime";
import { desktopInstallFixture } from "@/lib/hivra/__tests__/provider-desktop-install.fixtures";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";
import { buildProviderGuestRuntimeProbe } from "../provider-guest-runtime";
import { providerGuestBundleScopeSha256 } from "../provider-guest-bundle";
import { buildProviderGuestWorkerPlan } from "../provider-guest-worker";
import { buildProviderGuestBundlePlan, PROVIDER_GUEST_CLOCK_SCRIPT } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "../portable-provisioner-contract";
import { receiverFixture } from "./first-boot-receiver.fixtures";
import { buildReadOnlyHostDiscoveryScript } from "../host-discovery";
import { MAX_HOST_DISCOVERY_OUTPUT_BYTES } from "../host-discovery-contracts";
import { guestDiscoveryOutput } from "./provider-guest-discovery.fixtures";
import { canonicalFirstBootHostKey } from "../first-boot-enrollment";
import { generateHetznerBootstrapBundle } from "../hetzner-cloud";

function key() {return generateHetznerBootstrapBundle({userId:"owner",connectionId:"11111111-1111-4111-8111-111111111111",
  connectionRevision:7,orderId:"22222222-2222-4222-8222-222222222222",quoteFingerprintSha256:"a".repeat(64)});}
const host=key(),administrator=key(),otherHost=key();
// A public literal is validated but NEVER dialed: all clients below are either
// fake or explicitly remapped to the disposable localhost listener.
const input={address:"8.8.8.8",hostPublicKey:host.publicKeyOpenSsh,administratorPublicKey:administrator.publicKeyOpenSsh,
  administratorPrivateKey:administrator.privateKeyOpenSsh,dispatchDeadlineMs:1_000};
const hostWire=Buffer.from(host.publicKeyOpenSsh.split(" ")[1],"base64");
const administratorKey=utils.parseKey(administrator.publicKeyOpenSsh) as ParsedKey;
function changedPrivateSeed() {
  const binary=Buffer.from(administrator.privateKeyOpenSsh.split("\n").filter(line=>!line.startsWith("-----")).join(""),"base64");
  let offset=15; // openssh-key-v1\0
  const field=()=>{const length=binary.readUInt32BE(offset);offset+=4;const start=offset;offset+=length;return start;};
  field();field();field();offset+=4;field(); // cipher, KDF, KDF options, key count, public blob
  offset=field()+8; // private block, then its two check integers
  field();field(); // key type, embedded public key
  binary[field()]^=1; // change only the private seed, leaving all public bytes intact
  return "-----BEGIN OPENSSH PRIVATE KEY-----\n"+binary.toString("base64").match(/.{1,70}/g)!.join("\n")+"\n-----END OPENSSH PRIVATE KEY-----\n";
}
class FakeClient extends EventEmitter {
  config:ConnectConfig|null=null;
  connect=jest.fn((config:ConnectConfig)=>{this.config=config;return this;});
  destroy=jest.fn(()=>this);
  exec=jest.fn();
}
function fake() {
  const client=new FakeClient();let elapsed=0;
  const deps={client:jest.fn(()=>client as unknown as Client),monotonicNow:()=>elapsed};
  const verify=(wire=hostWire)=>(client.config!.hostVerifier as (key:Buffer)=>boolean)(wire);
  const authenticate=()=>{const next=jest.fn();(client.config!.authHandler as (methods:unknown,partial:unknown,callback:(method:unknown)=>void)=>unknown)(null,null,next);return next;};
  const signer=(authentication:ReturnType<typeof authenticate>)=>authentication.mock.calls[0][0].agent as BaseAgent<ParsedKey>;
  const sign=(agent:BaseAgent<ParsedKey>,publicKey=administratorKey)=>{const callback=jest.fn();agent.sign(publicKey,Buffer.from("fixture-session-auth"),{},callback);return callback;};
  return {client,deps,verify,authenticate,signer,sign,advance:(value:number)=>{elapsed=value;}};
}
describe("read-only provider runtime SSH", () => {
  const scope = { binding: receiverFixture().binding, providerServerId: "42" };
  const request = { ...input, scope, runtime: "codex" as const, identity: { version: 1 as const,
    agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
    bundle: { version: 1 as const, state: "bundle_installed" as const, provisionerVersion: "2026.08.28.1" as const,
      scopeSha256: providerGuestBundleScopeSha256(scope), bundleSha256: "a".repeat(64) } } };
  const receipt = { version: 1, ready: true, runtime: "codex", identity: request.identity, apiToken: "b".repeat(64) };
  class Channel extends EventEmitter { stderr = new EventEmitter(); end = jest.fn(); destroy = jest.fn(); }
  it("uses the same enrolled pin, fixed deadline and snapshotted workspace identity", async () => {
    const desktop = desktopInstallFixture();
    const f = fake(), stream = new Channel(), value = { ...input, identity: structuredClone(desktop.identity),
      access: { mode: "cloudflare-named" as const, hostname: desktop.context.hostname!, tunnelId: desktop.context.tunnelId! },
      controlOrigin: "https://canary.hermesos.cloud" };
    const expectedScript = buildProviderWorkspaceRuntimeProbe(value);
    const pending = inspectProviderWorkspaceRuntime(value, f.deps);
    value.controlOrigin = "https://changed.example.test";
    value.identity.operationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(f.client.exec).not.toHaveBeenCalled();
    expect(f.verify()).toBe(true); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.client.exec.mock.calls[0][1](null, stream);
    expect(stream.end).toHaveBeenCalledWith(expectedScript);
    expect(f.client.exec.mock.calls[0][0]).toContain("timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    const capability = { protocol: "hivra-remote-desktop-capability-v1", computerKind: "hivra-agent", computerId: desktop.op.agentId,
      capabilityGeneration: desktop.clock.bootId, observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION, compositor: "x11",
      installedTransports: ["selkies-websocket"], privateNetworkReachable: false, supportsInputTakeover: true,
      brokerOrigin: `https://${desktop.context.hostname}`, observedAt: new Date().toISOString() };
    const workspace = { protocol: "hivra-workspace-v1", computerId: desktop.op.agentId,
      operationId: desktop.op.operationId, publicOrigin: `https://${desktop.context.hostname}`, controlOrigin: "https://canary.hermesos.cloud" };
    stream.emit("data", Buffer.from(`HIVRA_PROVIDER_WORKSPACE_V1 ${JSON.stringify({ ...workspace,
      capabilityOutput: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(capability)}\n` })}\n`));
    stream.emit("close", 0);
    await expect(pending).resolves.toEqual({ hostVerified: true, administratorAuthenticated: true,
      hostFingerprintSha256: canonicalFirstBootHostKey(input.hostPublicKey).fingerprintSha256, receipt: { ...workspace, capability } });
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([false,true])("reads only the pinned guest clock and rejects malformed=%s output",async malformed=>{
    const f=fake(),stream=new Channel(),value={...input};
    const clock={bootId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",boottimeMs:1000};
    const pending=inspectProviderGuestClock(value,f.deps);
    const result=malformed?expect(pending).rejects.toThrow():expect(pending).resolves.toMatchObject({clock});
    value.hostPublicKey=otherHost.publicKeyOpenSsh;
    f.verify();f.sign(f.signer(f.authenticate()));f.client.emit("ready");
    f.client.exec.mock.calls[0][1](null,stream);
    expect(stream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    stream.emit("data",Buffer.from(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(malformed?{bootId:"bad",boottimeMs:1}:clock)}\n`));
    stream.emit("close",0);await result;
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("checks shutdown readiness only through the pinned bounded read-only recipe", async () => {
    const f = fake(), stream = new Channel();
    const pending = inspectProviderShutdownReadiness(input, f.deps);
    expect(f.client.exec).not.toHaveBeenCalled();
    f.verify(); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.client.exec.mock.calls[0][1](null, stream);
    expect(stream.end).toHaveBeenCalledWith(PROVIDER_SHUTDOWN_READINESS_SCRIPT);
    expect(f.client.exec.mock.calls[0][0]).toContain("timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    stream.emit("data", Buffer.from('HIVRA_SHUTDOWN_READY_V1 {"version":1,"ready":false}\n'));
    stream.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ hostVerified: true, receipt: { version: 1, ready: false } });
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("requires the original signed host pin and sends only the fixed read-only recipe", async () => {
    const f = fake(), stream = new Channel();
    const pending = inspectProviderGuestRuntime(request, f.deps);
    expect(f.client.exec).not.toHaveBeenCalled();
    f.verify(); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.client.exec.mock.calls[0][1](null, stream);
    expect(stream.end).toHaveBeenCalledWith(buildProviderGuestRuntimeProbe(request).script);
    expect(f.client.exec.mock.calls[0][0]).toContain("timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    stream.emit("data", Buffer.from(`HIVRA_PROVIDER_RUNTIME_V1 ${JSON.stringify(receipt)}\n`));
    stream.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ hostVerified: true, administratorAuthenticated: true, receipt });
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["pin", "deadline", "receipt", "exit"])("rejects %s without publishing a bearer", async change => {
    const f = fake(), stream = new Channel();
    const pending = inspectProviderGuestRuntime(request, f.deps), rejected = expect(pending).rejects.toThrow();
    if (change === "pin") {
      f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1], "base64"));
      f.client.emit("error", new Error("private connection detail"));
      expect(f.client.exec).not.toHaveBeenCalled();
    } else {
      f.verify(); f.sign(f.signer(f.authenticate()));
      if (change === "deadline") f.advance(1001);
      f.client.emit("ready");
      if (change !== "deadline") {
        f.client.exec.mock.calls[0][1](null, stream);
        stream.emit("data", Buffer.from(`HIVRA_PROVIDER_RUNTIME_V1 ${JSON.stringify({ ...receipt, runtime: change === "receipt" ? "claude" : "codex" })}\n`));
        stream.emit("close", change === "exit" ? 1 : 0);
      }
    }
    await rejected;
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("retained desktop capability SSH", () => {
  const desktop = desktopInstallFixture();
  const request = () => ({ ...input, identity: structuredClone(desktop.identity),
    access: { mode: "cloudflare-named" as const, hostname: desktop.context.hostname!, tunnelId: desktop.context.tunnelId! } });
  const receipt = () => ({ protocol: "hivra-remote-desktop-capability-v1", computerKind: "hivra-agent",
    computerId: desktop.op.agentId, capabilityGeneration: desktop.clock.bootId,
    observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION, compositor: "x11", installedTransports: ["selkies-websocket"],
    privateNetworkReachable: false, supportsInputTakeover: true,
    brokerOrigin: `https://${desktop.context.hostname}`, observedAt: new Date().toISOString() });
  class Channel extends EventEmitter { stderr = new EventEmitter(); end = jest.fn(); destroy = jest.fn(); }
  it.each([false,true])("snapshots ownership and sends only the bounded power=%s probe after original pinned authentication", async power => {
    const f = fake(), stream = new Channel(), value = request(), expectedScript = power?buildProviderDesktopPowerProbe(value):buildProviderDesktopRuntimeProbe(value);
    const pending = power?inspectProviderDesktopPower(value, f.deps):inspectProviderDesktopRuntime(value, f.deps);
    value.identity.operationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    value.access.hostname = "changed.example.test";
    value.hostPublicKey = otherHost.publicKeyOpenSsh;
    expect(f.client.exec).not.toHaveBeenCalled();
    expect(f.verify()).toBe(true); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.client.exec.mock.calls[0][1](null, stream);
    expect(stream.end).toHaveBeenCalledWith(expectedScript);
    expect(f.client.exec.mock.calls[0][0]).toContain("timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    const observed = receipt();
    const capabilityOutput=`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed)}\n`;
    stream.emit("data", Buffer.from(power?`HIVRA_PROVIDER_DESKTOP_POWER_V1 ${JSON.stringify({bootId:desktop.op.operationId,capabilityOutput})}\n`:capabilityOutput));
    stream.emit("close", 0);
    await expect(pending).resolves.toEqual({ hostVerified: true, administratorAuthenticated: true,
      hostFingerprintSha256: canonicalFirstBootHostKey(input.hostPublicKey).fingerprintSha256,
      receipt: power?{bootId:desktop.op.operationId,capability:observed}:observed });
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid ownership before opening a connection", async () => {
    const f = fake(), value = request(); value.identity.operationId = "invalid";
    await expect(inspectProviderDesktopRuntime(value, f.deps)).rejects.toThrow();
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it.each(["pin", "deadline", "computer", "origin", "stale", "duplicate", "exit"])("rejects %s without a capability", async fault => {
    const f = fake(), stream = new Channel();
    const pending = inspectProviderDesktopRuntime(request(), f.deps), rejected = expect(pending).rejects.toThrow();
    if (fault === "pin") {
      f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1], "base64"));
      f.client.emit("error", new Error("private connection detail"));
      expect(f.client.exec).not.toHaveBeenCalled();
    } else {
      f.verify(); f.sign(f.signer(f.authenticate()));
      if (fault === "deadline") f.advance(1001);
      f.client.emit("ready");
      if (fault !== "deadline") {
        f.client.exec.mock.calls[0][1](null, stream);
        const observed = receipt();
        if (fault === "computer") observed.computerId = desktop.op.operationId;
        if (fault === "origin") observed.brokerOrigin = "https://other.example.test";
        if (fault === "stale") observed.observedAt = "2026-01-01T00:00:00Z";
        const wire = `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed)}\n`;
        stream.emit("data", Buffer.from(fault === "duplicate" ? wire + wire : wire));
        stream.emit("close", fault === "exit" ? 1 : 0);
      } else expect(f.client.exec).not.toHaveBeenCalled();
    }
    await rejected;
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("enrolled guest pinned SSH transport",()=>{
  afterEach(()=>jest.useRealTimers());
  it("uses only the exact pin and original administrator key, returns no readiness and closes",async()=>{
    const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);
    expect(f.client.config).toMatchObject({host:input.address,port:22,username:"hivra",tryKeyboard:false,
      algorithms:{serverHostKey:["ssh-ed25519"]}});
    expect(f.client.config).not.toHaveProperty("agent");expect(f.client.config).not.toHaveProperty("password");
    expect(f.client.config).not.toHaveProperty("privateKey");
    expect(f.verify()).toBe(true);
    const authentication=f.authenticate();expect(authentication).toHaveBeenCalledWith(expect.objectContaining({type:"agent",username:"hivra"}));
    const signer=f.signer(authentication),identities=jest.fn();signer.getIdentities(identities);
    expect(identities).toHaveBeenCalledWith(null,[expect.objectContaining({type:"ssh-ed25519"})]);
    expect(identities.mock.calls[0][1][0].getPublicSSH()).toEqual(administratorKey.getPublicSSH());
    expect(identities.mock.calls[0][1][0].isPrivateKey()).toBe(false);
    expect(f.sign(signer)).toHaveBeenCalledWith(null,expect.any(Buffer));
    f.client.emit("ready");
    expect(await pending).toEqual({hostVerified:true,administratorAuthenticated:true,
      hostFingerprintSha256:canonicalFirstBootHostKey(host.publicKeyOpenSsh).fingerprintSha256});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);expect(f.client.exec).not.toHaveBeenCalled();
    expect(f.sign(signer)).toHaveBeenCalledWith(expect.objectContaining({code:"deadline_expired"}));
  });
  it("rejects a changed host key before any administrator authentication",async()=>{
    const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);
    expect(f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1],"base64"))).toBe(false);
    expect(f.authenticate()).not.toHaveBeenCalled();f.client.emit("error",new Error("sensitive raw transport error"));
    await expect(pending).rejects.toMatchObject({code:"host_key_mismatch"});expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["127.0.0.1","169.254.169.254","10.240.0.5","localhost","guest.example","::1","224.0.0.1",
    "0.0.0.0","100.64.0.1","100.127.255.255","172.16.0.1","192.168.0.1","192.0.0.9","192.0.2.1",
    "192.88.99.2","198.18.0.1","198.19.255.255","198.51.100.1","203.0.113.1","240.0.0.1","255.255.255.255"])("rejects non-public IPv4 destination %s without a client",async address=>{
    const f=fake();await expect(verifyFirstBootSshIdentity({...input,address},f.deps)).rejects.toMatchObject({code:"address_blocked"});
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("requires the original matching private key before connecting",async()=>{
    const f=fake();await expect(verifyFirstBootSshIdentity({...input,administratorPrivateKey:otherHost.privateKeyOpenSsh},f.deps))
      .rejects.toMatchObject({code:"invalid_identity"});expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("rejects a corrupted private seed even when the embedded public key still matches",async()=>{
    const privateKey=changedPrivateSeed(),parsed=utils.parseKey(privateKey) as ParsedKey;
    expect(parsed.getPublicSSH()).toEqual(administratorKey.getPublicSSH());
    expect(administratorKey.verify("proof",parsed.sign("proof"))).toBe(false);
    const f=fake();await expect(verifyFirstBootSshIdentity({...input,administratorPrivateKey:privateKey},f.deps))
      .rejects.toMatchObject({code:"invalid_identity"});expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("requires a signature for this handshake, not merely an unsigned authentication probe",async()=>{
    const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);f.verify();f.authenticate();f.client.emit("ready");
    await expect(pending).rejects.toMatchObject({code:"authentication_failed"});
  });
  it.each(["pin","authentication","signature","ready"])("enforces the 10-second cap at %s even before the timer runs",async boundary=>{
    const f=fake(),pending=verifyFirstBootSshIdentity({...input,dispatchDeadlineMs:30_000},f.deps);
    if(boundary!=="pin")f.verify();
    const signer=(boundary==="signature" || boundary==="ready")?f.signer(f.authenticate()):null;
    if(boundary==="ready")f.sign(signer!);
    f.advance(10_001);
    if(boundary==="pin")expect(f.verify()).toBe(false);
    if(boundary==="authentication")expect(f.authenticate()).not.toHaveBeenCalled();
    if(boundary==="signature")expect(f.sign(signer!)).toHaveBeenCalledWith(expect.objectContaining({code:"deadline_expired"}));
    f.client.emit("ready");await expect(pending).rejects.toMatchObject({code:"deadline_expired"});
  });
  it("does not let its in-memory signer authenticate another key or sign twice",async()=>{
    const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);f.verify();const signer=f.signer(f.authenticate());
    expect(f.sign(signer,utils.parseKey(otherHost.publicKeyOpenSsh) as ParsedKey))
      .toHaveBeenCalledWith(expect.objectContaining({code:"authentication_failed"}));
    expect(f.sign(signer)).toHaveBeenCalledWith(null,expect.any(Buffer));
    expect(f.sign(signer)).toHaveBeenCalledWith(expect.objectContaining({code:"authentication_failed"}));
    f.client.emit("ready");await expect(pending).resolves.toMatchObject({administratorAuthenticated:true});
  });
  it("enforces the caller deadline before dispatch and again before authentication",async()=>{
    const f=fake();f.advance(1_000);
    await expect(verifyFirstBootSshIdentity(input,f.deps)).rejects.toMatchObject({code:"deadline_expired"});
    expect(f.deps.client).not.toHaveBeenCalled();f.advance(0);
    const pending=verifyFirstBootSshIdentity(input,f.deps);f.verify();f.advance(1_000);
    expect(f.authenticate()).not.toHaveBeenCalled();f.client.emit("error",new Error("failed"));
    await expect(pending).rejects.toMatchObject({code:"deadline_expired"});
  });
  it("does not accept late ready events after timeout or a transport that skipped host verification",async()=>{
    jest.useFakeTimers();const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);
    const rejected=expect(pending).rejects.toMatchObject({code:"deadline_expired"});jest.advanceTimersByTime(1_000);await rejected;
    f.client.emit("ready");expect(f.client.destroy).toHaveBeenCalledTimes(1);expect(f.client.exec).not.toHaveBeenCalled();
    const g=fake(),unguarded=verifyFirstBootSshIdentity(input,g.deps);g.client.emit("ready");
    await expect(unguarded).rejects.toMatchObject({code:"host_key_mismatch"});
  });
  it("never returns raw connection or factory exceptions",async()=>{
    const f=fake(),pending=verifyFirstBootSshIdentity(input,f.deps);f.client.emit("error",new Error(administrator.privateKeyOpenSsh));
    await expect(pending).rejects.toThrow("Pinned guest SSH verification failed: connection_failed");
    await expect(verifyFirstBootSshIdentity(input,{...f.deps,client:()=>{throw new Error(administrator.privateKeyOpenSsh);}}))
      .rejects.toThrow("Pinned guest SSH verification failed: connection_failed");
  });
});

it("verifies real SSH signatures locally and rejects a changed server pin before auth",async()=>{
  const peers=new Set<Connection>();let authenticationAttempts=0,verifiedSignatures=0,sessionAttempts=0;
  let mode="normal",elapsed=0;
  const publicKey=utils.parseKey(administrator.publicKeyOpenSsh);
  if(publicKey instanceof Error || Array.isArray(publicKey))throw new Error("Invalid fixture public key");
  const server=new Server({hostKeys:[host.privateKeyOpenSsh]},peer=>{
    peers.add(peer);peer.on("close",()=>peers.delete(peer));peer.on("error",()=>{});
    peer.on("authentication",context=>{
      authenticationAttempts++;
      if(context.method!=="publickey" || context.username!=="hivra"
        || !context.key.data.equals(publicKey.getPublicSSH()))return context.reject();
      if(!context.signature){
        if(mode==="late_pk_ok")elapsed=1_000;
        if(mode==="unsigned_success"){
          // Deliberately nonconforming fixture: skip PK_OK/signature entirely.
          (peer as unknown as {_protocol:{authSuccess:()=>void}})._protocol.authSuccess();return;
        }
        return context.accept();
      }
      if(context.blob && publicKey.verify(context.blob,context.signature,context.hashAlgo)===true){verifiedSignatures++;context.accept();}
      else context.reject();
    });
    peer.on("session",(_accept,reject)=>{sessionAttempts++;reject();});
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try {
    const address=server.address();if(!address || typeof address==="string")throw new Error("No fixture listener");
    const clientFactory=()=>{
      const client=new Client(),connect=client.connect.bind(client);
      // Test-only remap: production receives/validates the original literal
      // IPv4 and fixed port. No real provider/network destination is contacted.
      client.connect=config=>{expect(config.host).toBe(input.address);expect(config.port).toBe(22);
        return connect({...config,host:"127.0.0.1",port:address.port});};
      return client;
    };
    const run=(pin:string)=>{elapsed=0;return verifyFirstBootSshIdentity({...input,hostPublicKey:pin},{client:clientFactory,monotonicNow:()=>elapsed});};
    await expect(run(host.publicKeyOpenSsh)).resolves.toMatchObject({hostVerified:true,administratorAuthenticated:true});
    expect(verifiedSignatures).toBe(1);const before=authenticationAttempts;
    await expect(run(otherHost.publicKeyOpenSsh)).rejects.toMatchObject({code:"host_key_mismatch"});
    expect(authenticationAttempts).toBe(before);expect(sessionAttempts).toBe(0);
    mode="late_pk_ok";
    await expect(run(host.publicKeyOpenSsh)).rejects.toMatchObject({code:"deadline_expired"});
    expect(verifiedSignatures).toBe(1); // No signature crossed the expired deadline.
    mode="unsigned_success";
    await expect(run(host.publicKeyOpenSsh)).rejects.toMatchObject({code:"authentication_failed"});
    expect(verifiedSignatures).toBe(1);expect(sessionAttempts).toBe(0);
  } finally {
    await Promise.all([...peers].map(peer=>new Promise<void>(resolve=>{peer.once("close",resolve);peer.end();})));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    expect(server.address()).toBeNull();expect(peers.size).toBe(0);
  }
},15_000);

describe("pinned read-only guest inspection",()=>{
  const inspectInput={...input,connectionId:"11111111-1111-4111-8111-111111111111"};
  class Channel extends EventEmitter {
    stderr=new EventEmitter();end=jest.fn();destroy=jest.fn();
  }
  function inspecting(){
    const f=fake(),stream=new Channel(),pending=inspectFirstBootGuest(inspectInput,f.deps);
    f.verify();f.sign(f.signer(f.authenticate()));
    const ready=()=>f.client.emit("ready");
    const acknowledge=()=>f.client.exec.mock.calls[0][1](null,stream);
    return {...f,stream,pending,ready,acknowledge};
  }
  afterEach(()=>jest.useRealTimers());
  it("runs exactly one fixed bounded probe after signed authentication and captures only bounded stdout",async()=>{
    const f=inspecting();expect(f.client.exec).not.toHaveBeenCalled();f.ready();f.ready();f.acknowledge();
    expect(f.client.exec).toHaveBeenCalledTimes(1);
    expect(f.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /bin/bash --noprofile --norc -s");
    expect(f.stream.end).toHaveBeenCalledWith(buildReadOnlyHostDiscoveryScript(inspectInput.connectionId));
    f.stream.emit("data",Buffer.from("facts"));f.stream.stderr.emit("data",Buffer.from("private diagnostic"));f.stream.emit("close",0);
    await expect(f.pending).resolves.toMatchObject({hostVerified:true,administratorAuthenticated:true,output:"facts"});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("rejects a malformed connection salt before client creation",async()=>{
    const f=fake();await expect(inspectFirstBootGuest({...inspectInput,connectionId:"';touch /tmp/unsafe"},f.deps))
      .rejects.toMatchObject({code:"invalid_identity"});expect(f.deps.client).not.toHaveBeenCalled();
  });
  it.each(["ready","acknowledgement","stdin","close"])("fences delayed %s even before the timer runs",async boundary=>{
    const f=inspecting();
    if(boundary==="ready")f.advance(1_000);
    f.ready();
    if(boundary==="acknowledgement")f.advance(1_000);
    if(boundary==="stdin"){
      const on=f.stream.on.bind(f.stream);
      f.stream.on=(event,listener)=>{const result=on(event,listener);if(event==="close")f.advance(1_000);return result;};
    }
    if(boundary!=="ready")f.acknowledge();
    if(boundary==="close"){f.advance(1_000);f.stream.emit("close",0);}
    await expect(f.pending).rejects.toMatchObject({code:"deadline_expired"});
    if(boundary!=="close")expect(f.stream.end).not.toHaveBeenCalled();
  });
  it("discards a channel acknowledged after timeout and never sends stdin",async()=>{
    jest.useFakeTimers();const f=inspecting();f.ready();
    const rejected=expect(f.pending).rejects.toMatchObject({code:"deadline_expired"});jest.advanceTimersByTime(1_000);await rejected;
    f.acknowledge();expect(f.stream.destroy).toHaveBeenCalledTimes(1);expect(f.stream.end).not.toHaveBeenCalled();
    f.ready();expect(f.client.exec).toHaveBeenCalledTimes(1);
  });
  it.each(["stdout","stderr","combined"])("bounds %s bytes without exposing raw output in errors",async where=>{
    const f=inspecting();f.ready();f.acknowledge();
    if(where==="combined"){f.stream.emit("data",Buffer.alloc(MAX_HOST_DISCOVERY_OUTPUT_BYTES));f.stream.stderr.emit("data",Buffer.from("private"));}
    else (where==="stdout"?f.stream:f.stream.stderr).emit("data",Buffer.alloc(MAX_HOST_DISCOVERY_OUTPUT_BYTES+1));
    await expect(f.pending).rejects.toThrow("Pinned guest SSH verification failed: output_limit");expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([[1,undefined],[null,undefined],[0,"TERM"]])("requires a clean zero exit: %s %s",async(code,signal)=>{
    const f=inspecting();f.ready();f.acknowledge();f.stream.emit("data",Buffer.from(guestDiscoveryOutput()));f.stream.emit("close",code,signal);
    await expect(f.pending).rejects.toMatchObject({code:"command_failed"});
  });
  it("does not accept an output marker without channel completion",async()=>{
    jest.useFakeTimers();const f=inspecting();f.ready();f.acknowledge();f.stream.emit("data",Buffer.from(guestDiscoveryOutput()));
    expect(f.client.destroy).not.toHaveBeenCalled();
    const rejected=expect(f.pending).rejects.toMatchObject({code:"deadline_expired"});jest.advanceTimersByTime(1_000);await rejected;
  });
  it("rejects success if synchronous final teardown crosses the deadline",async()=>{
    const f=inspecting();f.ready();f.acknowledge();f.client.destroy.mockImplementation(()=>{f.advance(1_000);return f.client;});
    f.stream.emit("close",0);await expect(f.pending).rejects.toMatchObject({code:"deadline_expired"});
  });
});

it("executes the exact probe protocol over a real local SSH channel, without executing a host command",async()=>{
  const peers=new Set<Connection>();let commands=0,scripts=0,verifiedSignatures=0;
  const publicKey=utils.parseKey(administrator.publicKeyOpenSsh) as ParsedKey;
  const connectionId="11111111-1111-4111-8111-111111111111";
  const server=new Server({hostKeys:[host.privateKeyOpenSsh]},peer=>{
    peers.add(peer);peer.on("close",()=>peers.delete(peer));peer.on("error",()=>{});
    peer.on("authentication",context=>{
      if(context.method!=="publickey" || context.username!=="hivra" || !context.key.data.equals(publicKey.getPublicSSH()))return context.reject();
      if(!context.signature)return context.accept();
      if(context.blob && publicKey.verify(context.blob,context.signature,context.hashAlgo)===true){verifiedSignatures++;context.accept();}
      else context.reject();
    });
    peer.on("session",accept=>{
      const session=accept();
      session.on("exec",(acceptExec,reject,info)=>{
        if(info.command!=="sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /bin/bash --noprofile --norc -s")return reject();
        commands++;const stream=acceptExec(),chunks:Buffer[]=[];
        stream.on("data",(chunk:Buffer)=>chunks.push(chunk));
        stream.on("end",()=>{
          if(Buffer.concat(chunks).toString()!==buildReadOnlyHostDiscoveryScript(connectionId)){stream.exit(1);stream.end();return;}
          scripts++;stream.write(guestDiscoveryOutput());stream.exit(0);stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try{
    const address=server.address();if(!address || typeof address==="string")throw new Error("Missing listener");
    const client=()=>{const client=new Client(),connect=client.connect.bind(client);
      client.connect=config=>{expect(config.host).toBe(input.address);return connect({...config,host:"127.0.0.1",port:address.port});};return client;};
    await expect(inspectFirstBootGuest({...input,connectionId,dispatchDeadlineMs:performance.now()+10_000},{client}))
      .resolves.toMatchObject({hostVerified:true,administratorAuthenticated:true,output:guestDiscoveryOutput()});
    expect(verifiedSignatures).toBe(1);expect(commands).toBe(1);expect(scripts).toBe(1);
  }finally{
    await Promise.all([...peers].map(peer=>new Promise<void>(resolve=>{peer.once("close",resolve);peer.end();})));
    await new Promise<void>(resolve=>server.close(()=>resolve()));expect(server.address()).toBeNull();expect(peers.size).toBe(0);
  }
},15_000);

describe("pinned fixed bundle delivery transport",()=>{
  const scope={binding:receiverFixture().binding,providerServerId:"42"};
  const assets=PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath=>({relativePath,
    content:Buffer.from(relativePath==="VERSION"?PORTABLE_HIVRA_PROVISIONER_VERSION+"\n":"fixture:"+relativePath)}));
  const clock={bootId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",boottimeMs:1000};
  const clockOutput="HIVRA_GUEST_CLOCK_V1 "+JSON.stringify(clock)+"\n";
  const plan=buildProviderGuestBundlePlan(scope,assets,clock);
  const output="HIVRA_PROVIDER_BUNDLE_V1 "+JSON.stringify(plan.receipt)+"\n";
  class Channel extends EventEmitter {stderr=new EventEmitter();end=jest.fn();destroy=jest.fn();}
  async function installing(mutate?:(request:Parameters<typeof installFirstBootGuestBundle>[0])=>void){
    const f=fake(),clockSession=fake(),clockStream=new Channel(),stream=new Channel();
    const secondConnected=new Promise<void>(resolve=>{
      const connect=f.client.connect.getMockImplementation()!;
      f.client.connect.mockImplementation(config=>{const result=connect(config);resolve();return result;});
    });
    const client=jest.fn().mockReturnValueOnce(clockSession.client).mockReturnValueOnce(f.client);
    const request={...input,scope:structuredClone(scope),assets:assets.map(asset=>({...asset,content:Buffer.from(asset.content)}))};
    const pending=installFirstBootGuestBundle(request,{...f.deps,client});
    mutate?.(request);
    clockSession.verify();clockSession.sign(clockSession.signer(clockSession.authenticate()));clockSession.client.emit("ready");
    clockSession.client.exec.mock.calls[0][1](null,clockStream);
    expect(clockSession.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    expect(clockStream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    clockStream.emit("data",Buffer.from(clockOutput));clockStream.emit("close",0);
    await Promise.race([secondConnected,pending.then(()=>{throw new Error("Unexpected completion before second connection");})]);
    const signed=()=>{f.verify();f.sign(f.signer(f.authenticate()));};
    return {...f,stream,pending,signed,ready:()=>f.client.emit("ready"),acknowledge:()=>f.client.exec.mock.calls[0][1](null,stream)};
  }
  afterEach(()=>jest.useRealTimers());
  it("runs exactly the generated Python delivery under the fixed remote deadline after signed pinned auth",async()=>{
    const f=await installing();expect(f.client.exec).not.toHaveBeenCalled();f.signed();f.ready();f.acknowledge();
    expect(f.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    expect(f.stream.end).toHaveBeenCalledWith(plan.script);
    f.stream.emit("data",Buffer.from(output));f.stream.emit("close",0);
    await expect(f.pending).resolves.toMatchObject({receipt:plan.receipt});expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("does not submit a bundle before authenticating the original signer",async()=>{
    const f=await installing();f.verify();f.ready();
    await expect(f.pending).rejects.toMatchObject({code:"authentication_failed"});
    expect(f.client.exec).not.toHaveBeenCalled();
  });
  it("snapshots transport, scope and bytes before awaiting the read-only clock channel",async()=>{
    const f=await installing(request=>{
      request.address="8.8.4.4";request.hostPublicKey=otherHost.publicKeyOpenSsh;
      request.administratorPrivateKey="changed";request.scope.providerServerId="43";request.assets[0].content.fill(0);
    });
    expect(f.client.config?.host).toBe(input.address);f.signed();f.ready();f.acknowledge();
    expect(f.stream.end).toHaveBeenCalledWith(plan.script);
    f.stream.emit("data",Buffer.from(output));f.stream.emit("close",0);
    await expect(f.pending).resolves.toMatchObject({receipt:plan.receipt});
  });
  it.each(["ready","ack","stdin"])("prevents expired %s from sending bundle bytes",async change=>{
    const f=await installing();f.signed();if(change==="ready")f.advance(1_000);f.ready();
    if(change==="ack")f.advance(1_000);
    if(change==="stdin"){
      const on=f.stream.on.bind(f.stream);
      f.stream.on=(event,callback)=>{const result=on(event,callback);if(event==="close")f.advance(1_000);return result;};
    }
    if(change!=="ready")f.acknowledge();
    await expect(f.pending).rejects.toMatchObject({code:"deadline_expired"});expect(f.stream.end).not.toHaveBeenCalled();
  });
  it.each(["wrong_receipt","nonzero_exit","output_only","output_limit"])("rejects %s without accepting installation",async change=>{
    jest.useFakeTimers();const f=await installing();f.signed();f.ready();f.acknowledge();
    const rejected=expect(f.pending).rejects.toThrow();
    f.stream.emit("data",Buffer.from(change==="wrong_receipt"?output.replace(plan.receipt.bundleSha256,"a".repeat(64)):
      change==="output_limit"?"x".repeat(MAX_HOST_DISCOVERY_OUTPUT_BYTES+1):output));
    if(change==="output_only")jest.advanceTimersByTime(1_000);
    else f.stream.emit("close",change==="nonzero_exit"?1:0);
    await rejected;
  });
  it("rejects an invalid bundle before constructing a transport",async()=>{
    const f=fake();await expect(installFirstBootGuestBundle({...input,scope,assets:[]},f.deps)).rejects.toThrow("Invalid provider guest bundle");
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it.each(["invalid_clock","nonzero_clock","unclosed_clock","late_clock"])("does not construct the mutating session after %s",async change=>{
    jest.useFakeTimers();const f=fake(),stream=new Channel();
    const pending=installFirstBootGuestBundle({...input,scope,assets},f.deps),rejected=expect(pending).rejects.toThrow();
    f.verify();f.sign(f.signer(f.authenticate()));f.client.emit("ready");f.client.exec.mock.calls[0][1](null,stream);
    expect(stream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    stream.emit("data",Buffer.from(change==="invalid_clock"?"untrusted private clock output":clockOutput));
    if(change==="late_clock")f.advance(1_000);
    if(change==="unclosed_clock")jest.advanceTimersByTime(1_000);
    else stream.emit("close",change==="nonzero_clock"?1:0);
    await rejected;expect(f.deps.client).toHaveBeenCalledTimes(1);expect(f.client.exec).toHaveBeenCalledTimes(1);
  });
  it("delivers the actual bundle and reconciles it across real signed loopback SSH sessions",async()=>{
    const root=mkdtempSync(path.join(tmpdir(),"hivra-bundle-ssh-test-")),peers=new Set<Connection>();
    const actual=PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath=>({relativePath,
      content:readFileSync(path.join(process.cwd(),"provisioner",relativePath))}));
    const expected=buildProviderGuestBundlePlan(scope,actual,clock);
    const publicKey=utils.parseKey(administrator.publicKeyOpenSsh) as ParsedKey;
    let signed=0,delivered=0;
    const server=new Server({hostKeys:[host.privateKeyOpenSsh]},peer=>{
      peers.add(peer);peer.on("close",()=>peers.delete(peer));peer.on("error",()=>{});
      peer.on("authentication",context=>{
        if(context.method!=="publickey" || context.username!=="hivra" || !context.key.data.equals(publicKey.getPublicSSH()))return context.reject();
        if(!context.signature)return context.accept();
        if(context.blob && publicKey.verify(context.blob,context.signature,context.hashAlgo)===true){signed++;context.accept();}
        else context.reject();
      });
      peer.on("session",accept=>accept().on("exec",(acceptExec,reject,info)=>{
        if(info.command!=="sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -")return reject();
        const stream=acceptExec(),chunks:Buffer[]=[];
        stream.on("data",(chunk:Buffer)=>chunks.push(chunk));
        stream.on("end",()=>{
          const received=Buffer.concat(chunks).toString();
          if(received===PROVIDER_GUEST_CLOCK_SCRIPT){stream.write(clockOutput);stream.exit(0);stream.end();return;}
          if(received!==expected.script){stream.exit(1);stream.end();return;}
          // Execute the received filesystem functions, not the production root
          // entrypoint. The fixture's only writable path is its mkdtemp root.
          const program=received.replace('if __name__ == "__main__":\n    main()',"")+
            `\ncurrent_guest_clock = lambda: ${JSON.stringify(clock)}\n`+
            `\nprint("HIVRA_PROVIDER_BUNDLE_V1 " + json.dumps(install_bundle(${JSON.stringify(root)}, os.getuid(), PAYLOAD)))\n`;
          const result=spawnSync("/usr/bin/python3",["-I","-"],{input:program,encoding:"utf8",timeout:8_000,
            env:{PATH:"/usr/bin:/bin",NODE_ENV:"test"}});
          if(result.status===0){delivered++;stream.write(result.stdout);}
          stream.exit(result.status===0?0:1);stream.end();
        });
      }));
    });
    try{
      await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
      const address=server.address();if(!address || typeof address==="string")throw new Error("Missing loopback listener");
      const client=()=>{const client=new Client(),connect=client.connect.bind(client);
        client.connect=config=>{expect(config.host).toBe(input.address);return connect({...config,host:"127.0.0.1",port:address.port});};return client;};
      const run=()=>installFirstBootGuestBundle({...input,scope,assets:actual,dispatchDeadlineMs:performance.now()+10_000},{client});
      await expect(run()).resolves.toMatchObject({receipt:expected.receipt});
      const inode=statSync(path.join(root,"current")).ino;
      await expect(run()).resolves.toMatchObject({receipt:expected.receipt});
      expect(statSync(path.join(root,"current")).ino).toBe(inode);
      for(const file of actual)expect(readFileSync(path.join(root,"current",file.relativePath))).toEqual(file.content);
      expect(signed).toBe(4);expect(delivered).toBe(2);
    }finally{
      await Promise.all([...peers].map(peer=>new Promise<void>(resolve=>{peer.once("close",resolve);peer.end();})));
      if(server.address())await new Promise<void>(resolve=>server.close(()=>resolve()));
      expect(server.address()).toBeNull();expect(peers.size).toBe(0);
      rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);
    }
  },20_000);
});

describe("staged native provider installer transport", () => {
  const request = {...input, scope: {binding: receiverFixture().binding, providerServerId: "42"},
    agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
    assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({relativePath,
      content: readFileSync(path.join(process.cwd(), "provisioner", relativePath))})),
    action: "start" as const, journaledHostname: "native.example.test",
    launch: {version: 2 as const, agentKind: "deepseek-harness" as const, computerSubstrate: "provider-vm" as const,
      wantBrowser: false, modelKey: "" as const, modelBaseUrl: "" as const, model: "" as const,
      publicOrigin: "https://native.example.test", tunnelToken: "fixture-private-tunnel", accessHostname: null}};
  const clock = {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000};
  const plan = buildProviderNativeWorkerPlan(request, clock);
  const receipt = {version: 2, identity: plan.identity, state: "failed", stopped: true,
    nativeCleanup: {state: "verified_stopped", bootId: clock.bootId}};
  class Channel extends EventEmitter {stderr = new EventEmitter(); end = jest.fn(); destroy = jest.fn();}
  async function dispatch(action: "start" | "status" | "cancel", mutate = false) {
    const sample = fake(), worker = fake(), sampleStream = new Channel(), stream = new Channel();
    const connected = new Promise<void>(resolve => {
      const connect = worker.client.connect.getMockImplementation()!;
      worker.client.connect.mockImplementation(config => {const result = connect(config); resolve(); return result;});
    });
    const client = jest.fn().mockReturnValueOnce(sample.client).mockReturnValueOnce(worker.client);
    const value = {...request, scope: structuredClone(request.scope), launch: {...request.launch},
      assets: request.assets.map(asset => ({...asset, content: Buffer.from(asset.content)}))};
    const recovery = {...input, scope: structuredClone(request.scope), agentId: request.agentId,
      operationId: request.operationId, identity: structuredClone(plan.identity), action: action as "status" | "cancel"};
    const pending = controlProviderNativeInstaller(action === "start" ? value : recovery, {...worker.deps, client});
    if (mutate) {
      value.journaledHostname = "changed.example.test"; value.launch.publicOrigin = "https://changed.example.test";
      value.launch.tunnelToken = "changed"; value.assets[0].content.fill(0); value.scope.providerServerId = "43";
      recovery.identity.nativeCleanup.closureSha256 = "f".repeat(64); recovery.scope.providerServerId = "43";
    }
    sample.verify(); sample.sign(sample.signer(sample.authenticate())); sample.client.emit("ready");
    sample.client.exec.mock.calls[0][1](null, sampleStream);
    expect(sampleStream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    sampleStream.emit("data", Buffer.from("HIVRA_GUEST_CLOCK_V1 " + JSON.stringify(clock) + "\n")); sampleStream.emit("close", 0);
    await Promise.race([connected, pending.then(() => {throw new Error("premature result");})]);
    expect(sample.client.destroy).toHaveBeenCalledTimes(1);
    return {...worker, pending, stream, execute: () => {
      worker.verify(); worker.sign(worker.signer(worker.authenticate())); worker.client.emit("ready");
      worker.client.exec.mock.calls[0][1](null, stream);
    }};
  }
  afterEach(() => jest.useRealTimers());
  it.each(["start", "status", "cancel"] as const)("sends pinned %s after a clean clock sample and snapshots before await", async action => {
    const f = await dispatch(action, true); f.execute();
    const expected = action === "start" ? plan : buildProviderNativeWorkerPlan({scope: request.scope, agentId: request.agentId,
      operationId: request.operationId, identity: plan.identity, action}, clock);
    expect(f.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    expect(f.stream.end).toHaveBeenCalledWith(expected.script);
    f.stream.emit("data", Buffer.from("HIVRA_PROVIDER_WORKER_V1 " + JSON.stringify(receipt) + "\n")); f.stream.emit("close", 0);
    await expect(f.pending).resolves.toMatchObject({receipt, clock});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["origin", "key", "bundle", "identity"])("rejects %s before opening a connection", async field => {
    const f = fake();
    const invalid = field === "identity" ? {...input, scope: request.scope, agentId: request.agentId, operationId: request.operationId,
      action: "cancel" as const, identity: {...plan.identity, operationId: request.agentId}}
      : {...request, journaledHostname: field === "origin" ? "other.example.test" : request.journaledHostname,
        launch: {...request.launch, modelKey: field === "key" ? "private-key" : ""}, assets: field === "bundle" ? [] : request.assets};
    await expect(controlProviderNativeInstaller(invalid as never, f.deps)).rejects.toThrow("Invalid provider native worker request");
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("rejects a changed worker-session pin before sending private stdin", async () => {
    const f = await dispatch("start");
    f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1], "base64"));
    f.client.emit("error", new Error("private transport detail"));
    await expect(f.pending).rejects.toMatchObject({code: "host_key_mismatch"});
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it("does not extend original authority while sampling the guest clock", async () => {
    const f = await dispatch("cancel"); f.verify(); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.advance(1000); f.client.exec.mock.calls[0][1](null, f.stream);
    await expect(f.pending).rejects.toMatchObject({code: "deadline_expired"});
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it.each(["stale_boot", "wrong_operation", "no_cleanup", "nonzero_exit", "no_exit"])("withholds cleanup authority after %s", async field => {
    jest.useFakeTimers(); const f = await dispatch("cancel"); f.execute();
    const rejected = expect(f.pending).rejects.toThrow();
    const value = {...receipt, nativeCleanup: field === "stale_boot" ? {...receipt.nativeCleanup, bootId: request.agentId}
      : field === "no_cleanup" ? undefined : receipt.nativeCleanup,
      identity: field === "wrong_operation" ? {...receipt.identity, operationId: request.agentId} : receipt.identity};
    f.stream.emit("data", Buffer.from("HIVRA_PROVIDER_WORKER_V1 " + JSON.stringify(value) + "\n"));
    if (field === "no_exit") jest.advanceTimersByTime(1000); else f.stream.emit("close", field === "nonzero_exit" ? 1 : 0);
    await rejected;
  });
});

describe("staged desktop provider installer transport", () => {
  const request = {...input, scope: {binding: receiverFixture().binding, providerServerId: "42"},
    agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
    assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({relativePath,
      content: readFileSync(path.join(process.cwd(), "provisioner", relativePath))})),
    action: "start" as const, authority: {computerId: "11111111-1111-4111-8111-111111111111", controlOrigin: "https://canary.hermesos.cloud",
      access: {mode: "cloudflare-named" as const, hostname: "desktop.example.test", tunnelId: "33333333-3333-4333-8333-333333333333"}},
    launch: {version: 3 as const, agentKind: "linux-desktop" as const, computerSubstrate: "provider-vm" as const,
      wantBrowser: null, computerId: "11111111-1111-4111-8111-111111111111", controlOrigin: "https://canary.hermesos.cloud", modelKey: "" as const, modelBaseUrl: "" as const, model: "" as const,
      publicOrigin: "https://desktop.example.test", tunnelToken: Buffer.from(JSON.stringify({t: "33333333-3333-4333-8333-333333333333", s: "fixture-private-tunnel"})).toString("base64"), accessHostname: null}};
  const clock = {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000};
  const plan = buildProviderDesktopWorkerPlan(request, clock);
  const receipt = {version: 3, identity: plan.identity, state: "failed", stopped: true,
    desktopCleanup: {state: "verified_stopped", bootId: clock.bootId}};
  class Channel extends EventEmitter {stderr = new EventEmitter(); end = jest.fn(); destroy = jest.fn();}
  async function dispatch(action: "start" | "status" | "cancel", mutate = false) {
    const sample = fake(), worker = fake(), sampleStream = new Channel(), stream = new Channel();
    const connected = new Promise<void>(resolve => {
      const connect = worker.client.connect.getMockImplementation()!;
      worker.client.connect.mockImplementation(config => {const result = connect(config); resolve(); return result;});
    });
    const client = jest.fn().mockReturnValueOnce(sample.client).mockReturnValueOnce(worker.client);
    const value = {...request, scope: structuredClone(request.scope), launch: {...request.launch}, authority: structuredClone(request.authority),
      assets: request.assets.map(asset => ({...asset, content: Buffer.from(asset.content)}))};
    const recovery = {...input, scope: structuredClone(request.scope), agentId: request.agentId,
      operationId: request.operationId, identity: structuredClone(plan.identity), action: action as "status" | "cancel"};
    const pending = controlProviderDesktopInstaller(action === "start" ? value : recovery, {...worker.deps, client});
    if (mutate) {
      value.authority.access.hostname = "changed.example.test"; value.authority.computerId = request.operationId; value.launch.publicOrigin = "https://changed.example.test";
      value.launch.tunnelToken = "changed"; value.assets[0].content.fill(0); value.scope.providerServerId = "43";
      recovery.identity.desktopCleanup.closureSha256 = "f".repeat(64); recovery.scope.providerServerId = "43";
    }
    sample.verify(); sample.sign(sample.signer(sample.authenticate())); sample.client.emit("ready");
    sample.client.exec.mock.calls[0][1](null, sampleStream);
    expect(sampleStream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    sampleStream.emit("data", Buffer.from("HIVRA_GUEST_CLOCK_V1 " + JSON.stringify(clock) + "\n")); sampleStream.emit("close", 0);
    await Promise.race([connected, pending.then(() => {throw new Error("premature result");})]);
    expect(sample.client.destroy).toHaveBeenCalledTimes(1);
    return {...worker, pending, stream, execute: () => {
      worker.verify(); worker.sign(worker.signer(worker.authenticate())); worker.client.emit("ready");
      worker.client.exec.mock.calls[0][1](null, stream);
    }};
  }
  afterEach(() => jest.useRealTimers());
  it.each(["start", "status", "cancel"] as const)("sends pinned %s after a clean clock sample and snapshots before await", async action => {
    const f = await dispatch(action, true); f.execute();
    const expected = action === "start" ? plan : buildProviderDesktopWorkerPlan({scope: request.scope, agentId: request.agentId,
      operationId: request.operationId, identity: plan.identity, action}, clock);
    expect(f.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    expect(f.stream.end).toHaveBeenCalledWith(expected.script);
    f.stream.emit("data", Buffer.from("HIVRA_PROVIDER_WORKER_V1 " + JSON.stringify(receipt) + "\n")); f.stream.emit("close", 0);
    await expect(f.pending).resolves.toMatchObject({receipt, clock});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["origin", "key", "bundle", "identity"])("rejects %s before opening a connection", async field => {
    const f = fake();
    const invalid = field === "identity" ? {...input, scope: request.scope, agentId: request.agentId, operationId: request.operationId,
      action: "cancel" as const, identity: {...plan.identity, operationId: request.agentId}}
      : {...request, authority: {...request.authority, access: {...request.authority.access, hostname: field === "origin" ? "other.example.test" : request.authority.access.hostname}},
        launch: {...request.launch, modelKey: field === "key" ? "private-key" : ""}, assets: field === "bundle" ? [] : request.assets};
    await expect(controlProviderDesktopInstaller(invalid as never, f.deps)).rejects.toThrow("Invalid provider desktop worker request");
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("rejects a changed worker-session pin before sending private stdin", async () => {
    const f = await dispatch("start");
    f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1], "base64"));
    f.client.emit("error", new Error("private transport detail"));
    await expect(f.pending).rejects.toMatchObject({code: "host_key_mismatch"});
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it("does not extend original authority while sampling the guest clock", async () => {
    const f = await dispatch("cancel"); f.verify(); f.sign(f.signer(f.authenticate())); f.client.emit("ready");
    f.advance(1000); f.client.exec.mock.calls[0][1](null, f.stream);
    await expect(f.pending).rejects.toMatchObject({code: "deadline_expired"});
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it.each(["stale_boot", "wrong_operation", "no_cleanup", "nonzero_exit", "no_exit"])("withholds cleanup authority after %s", async field => {
    jest.useFakeTimers(); const f = await dispatch("cancel"); f.execute();
    const rejected = expect(f.pending).rejects.toThrow();
    const value = {...receipt, desktopCleanup: field === "stale_boot" ? {...receipt.desktopCleanup, bootId: request.agentId}
      : field === "no_cleanup" ? undefined : receipt.desktopCleanup,
      identity: field === "wrong_operation" ? {...receipt.identity, operationId: request.agentId} : receipt.identity};
    f.stream.emit("data", Buffer.from("HIVRA_PROVIDER_WORKER_V1 " + JSON.stringify(value) + "\n"));
    if (field === "no_exit") jest.advanceTimersByTime(1000); else f.stream.emit("close", field === "nonzero_exit" ? 1 : 0);
    await rejected;
  });
});

describe("pinned provider installer worker transport", () => {
  const request = {...input, scope: {binding: receiverFixture().binding, providerServerId: "42"},
    agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
    assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({relativePath,
      content: readFileSync(path.join(process.cwd(), "provisioner", relativePath))})),
    action: "start" as const, launch: {version: 1 as const, agentKind: "codex" as const, computerSubstrate: "provider-vm" as const,
      wantBrowser: false, modelKey: "fixture-model-key", modelBaseUrl: "", model: "", tunnelToken: "fixture-tunnel-token", accessHostname: null}};
  const clock = {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000};
  const plan = buildProviderGuestWorkerPlan(request, clock);
  const receipt = {version: 1, identity: plan.identity, state: "running", stopped: false};
  class Channel extends EventEmitter {stderr=new EventEmitter(); end=jest.fn(); destroy=jest.fn();}
  async function dispatch(change?: (value: typeof request) => void, action: "start" | "status" | "cancel" = "start") {
    const clockSession=fake(), workerSession=fake(), clockStream=new Channel(), stream=new Channel();
    const connected=new Promise<void>(resolve=>{
      const connect=workerSession.client.connect.getMockImplementation()!;
      workerSession.client.connect.mockImplementation(config=>{const result=connect(config); resolve(); return result;});
    });
    const client=jest.fn().mockReturnValueOnce(clockSession.client).mockReturnValueOnce(workerSession.client);
    const value={...request, scope:structuredClone(request.scope), launch:{...request.launch},
      assets:request.assets.map(asset=>({...asset,content:Buffer.from(asset.content)}))};
    const control = action === "start" ? value : {...input, scope: structuredClone(request.scope), agentId: request.agentId,
      operationId: request.operationId, identity: structuredClone(plan.identity), action};
    const pending=controlProviderGuestInstaller(control,{...workerSession.deps,client});
    change?.(value);
    clockSession.verify(); clockSession.sign(clockSession.signer(clockSession.authenticate())); clockSession.client.emit("ready");
    clockSession.client.exec.mock.calls[0][1](null,clockStream);
    expect(clockStream.end).toHaveBeenCalledWith(PROVIDER_GUEST_CLOCK_SCRIPT);
    clockStream.emit("data",Buffer.from("HIVRA_GUEST_CLOCK_V1 "+JSON.stringify(clock)+"\n")); clockStream.emit("close",0);
    await Promise.race([connected,pending.then(()=>{throw new Error("premature result");})]);
    return {...workerSession,pending,stream,execute:()=>{
      workerSession.verify(); workerSession.sign(workerSession.signer(workerSession.authenticate())); workerSession.client.emit("ready");
      workerSession.client.exec.mock.calls[0][1](null,stream);
    }};
  }
  afterEach(()=>jest.useRealTimers());
  it("sends only the fixed worker over signed pinned SSH and accepts clean exact receipts",async()=>{
    const f=await dispatch(); f.execute();
    expect(f.client.exec.mock.calls[0][0]).toBe("sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /usr/bin/python3 -I -B -");
    expect(f.stream.end).toHaveBeenCalledWith(plan.script);
    expect(f.client.exec.mock.calls[0][0]).not.toContain("fixture-tunnel-token");
    f.stream.emit("data",Buffer.from("HIVRA_PROVIDER_WORKER_V1 "+JSON.stringify(receipt)+"\n")); f.stream.emit("close",0);
    await expect(f.pending).resolves.toMatchObject({receipt});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["status", "cancel"] as const)("sends %s using only the original identity and pinned controller recipe", async action => {
    const f = await dispatch(undefined, action); f.execute();
    const recovery = buildProviderGuestWorkerPlan({scope: request.scope, agentId: request.agentId,
      operationId: request.operationId, identity: plan.identity, action}, clock);
    expect(f.stream.end).toHaveBeenCalledWith(recovery.script);
    f.stream.emit("data", Buffer.from("HIVRA_PROVIDER_WORKER_V1 " + JSON.stringify(receipt) + "\n")); f.stream.emit("close", 0);
    await expect(f.pending).resolves.toMatchObject({receipt});
    expect(f.client.destroy).toHaveBeenCalledTimes(1);
  });
  it("rejects a foreign recovery journal before opening SSH", async () => {
    const f = fake();
    await expect(controlProviderGuestInstaller({...input, scope: request.scope, agentId: request.agentId,
      operationId: request.operationId, identity: {...plan.identity, agentId: request.operationId}, action: "cancel"}, f.deps))
      .rejects.toThrow("Invalid provider guest worker request");
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("snapshots operation, runtime, credential and bytes before the clock read",async()=>{
    const f=await dispatch(value=>{value.operationId=value.agentId; value.launch.modelKey="changed";
      value.launch.agentKind="claude" as never; value.scope.providerServerId="43"; value.assets[0].content.fill(0);});
    f.execute(); expect(f.stream.end).toHaveBeenCalledWith(plan.script);
    f.stream.emit("data",Buffer.from("HIVRA_PROVIDER_WORKER_V1 "+JSON.stringify(receipt)+"\n")); f.stream.emit("close",0);
    await expect(f.pending).resolves.toMatchObject({receipt});
  });
  it("rejects malformed launch data before administrator authentication or network",async()=>{
    const f=fake();
    await expect(controlProviderGuestInstaller({...request,launch:{...request.launch,tunnelToken:"secret\n"}},f.deps))
      .rejects.toThrow("Invalid provider guest worker request");
    expect(f.deps.client).not.toHaveBeenCalled();
  });
  it("rejects a changed pin before sending the worker's credential-bearing stdin",async()=>{
    const f=await dispatch(); expect(f.verify(Buffer.from(otherHost.publicKeyOpenSsh.split(" ")[1],"base64"))).toBe(false);
    f.client.emit("error",new Error("private transport error"));
    await expect(f.pending).rejects.toMatchObject({code:"host_key_mismatch"});
    expect(f.stream.end).not.toHaveBeenCalled();
  });
  it("never sends delayed stdin after the original dispatch deadline",async()=>{
    const f=await dispatch(); f.verify(); f.sign(f.signer(f.authenticate())); f.client.emit("ready"); f.advance(1000);
    f.client.exec.mock.calls[0][1](null,f.stream);
    await expect(f.pending).rejects.toMatchObject({code:"deadline_expired"}); expect(f.stream.end).not.toHaveBeenCalled();
  });
  it.each(["wrong_operation","nonzero_exit","no_exit"])("does not claim worker success after %s",async change=>{
    jest.useFakeTimers(); const f=await dispatch(); f.execute();
    const rejected=expect(f.pending).rejects.toThrow();
    const value=change==="wrong_operation"?{...receipt,identity:{...receipt.identity,operationId:request.agentId}}:receipt;
    f.stream.emit("data",Buffer.from("HIVRA_PROVIDER_WORKER_V1 "+JSON.stringify(value)+"\n"));
    if(change==="no_exit")jest.advanceTimersByTime(1000); else f.stream.emit("close",change==="nonzero_exit"?1:0);
    await rejected;
  });
});
