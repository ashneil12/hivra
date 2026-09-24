import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { BaseAgent, Client, utils, type ConnectConfig, type IdentityCallback, type ParsedKey, type SignCallback, type SigningRequestOptions } from "ssh2";
import { reservedAddressReason } from "@/lib/url-safety";
import { PROVIDER_SHUTDOWN_READINESS_SCRIPT, parseProviderShutdownReadiness } from "./provider-shutdown-readiness";
import { canonicalFirstBootHostKey } from "./first-boot-enrollment";
import { buildReadOnlyHostDiscoveryScript } from "./host-discovery";
import { MAX_HOST_DISCOVERY_OUTPUT_BYTES } from "./host-discovery-contracts";
import type { PortableProvisionerBundleAsset } from "./connection-preparation";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { buildProviderGuestBundlePlan, providerGuestBundleReceipt, parseProviderGuestBundleReceipt, parseProviderGuestClock,
  PROVIDER_GUEST_CLOCK_SCRIPT, type ProviderGuestBundleReceipt, type ProviderGuestClock } from "./provider-guest-bundle";
import { buildProviderGuestWorkerPlan, parseProviderGuestWorkerReceipt,
  type ProviderGuestWorkerInput, type ProviderGuestWorkerReceipt } from "./provider-guest-worker";
import { buildProviderNativeWorkerPlan, parseProviderNativeWorkerReceipt,
  type ProviderNativeWorkerInput, type ProviderNativeWorkerReceipt } from "./provider-native-worker";
import { buildProviderDesktopWorkerPlan, parseProviderDesktopWorkerReceipt,
  type ProviderDesktopWorkerInput, type ProviderDesktopWorkerReceipt } from "./provider-desktop-worker";
import { buildProviderNativeRuntimeProbe, parseProviderNativeRuntimeReceipt,
  type ProviderNativeRuntimeProbe, type ProviderNativeRuntimeReceipt } from "./provider-native-runtime";
import { buildProviderDesktopRuntimeProbe, parseProviderDesktopRuntimeReceipt, buildProviderDesktopPowerProbe, parseProviderDesktopPowerReceipt,
  buildProviderWorkspaceRuntimeProbe, parseProviderWorkspaceRuntimeReceipt,
  type ProviderDesktopRuntimeProbe, type ProviderWorkspaceRuntimeProbe } from "./provider-desktop-runtime";
import { buildProviderGuestRuntimeProbe, parseProviderGuestRuntimeReceipt,
  type ProviderGuestRuntimeProbe, type ProviderGuestRuntimeReceipt } from "./provider-guest-runtime";

export class FirstBootSshError extends Error {
  constructor(readonly code:"invalid_identity"|"address_blocked"|"deadline_expired"|"host_key_mismatch"|"authentication_failed"|"connection_failed"|"command_failed"|"output_limit") {
    super("Pinned guest SSH verification failed: "+code);
    this.name="FirstBootSshError";
  }
}
type Dependencies={client:()=>Client;monotonicNow:()=>number};
const defaults:Dependencies={client:()=>new Client(),monotonicNow:()=>performance.now()};

function blockedAddress(address:string) {
  if(isIP(address)!==4 || reservedAddressReason(address))return true;
  const [a,b,c]=address.split(".").map(Number);
  // IANA non-global special-use ranges, plus all multicast/reserved space.
  // Conservatively exclude the whole protocol-assignment /24 (including its
  // anycast exceptions); no Hetzner guest receipt should identify such a host.
  return a>=224 || (a===192 && ((b===0 && (c===0 || c===2)) || (b===88 && c===99)))
    || (a===198 && (b===18 || b===19 || (b===51 && c===100)))
    || (a===203 && b===0 && c===113);
}

/** Private transport check for an already owner/receipt-bound, enrolled guest.
 * The caller must hold current lifecycle authority and pass its monotonic
 * dispatch deadline (anchored before acquiring that authority). This function
 * does not acquire that authority, read storage, trust a new key, run a command,
 * install anything or publish readiness. Only the enrolled Ed25519 host key
 * and the original generated administrator key are permitted.
 */
type FirstBootSshInput={
  address:string;hostPublicKey:string;administratorPublicKey:string;administratorPrivateKey:string;
  dispatchDeadlineMs:number;
};
type FirstBootSshIdentity={hostVerified:true;administratorAuthenticated:true;hostFingerprintSha256:string};

export async function verifyFirstBootSshIdentity(input:FirstBootSshInput,dependencies:Partial<Dependencies>={}):Promise<FirstBootSshIdentity> {
  const {hostVerified,administratorAuthenticated,hostFingerprintSha256}=await connectFirstBootGuest(input,dependencies);
  return {hostVerified,administratorAuthenticated,hostFingerprintSha256};
}

/** Caller retains the original lifecycle authority. Same enrolled pin, fenced
 * administrator authentication and bounded read-only interpreter as discovery. */
export async function inspectProviderShutdownReadiness(input: FirstBootSshInput, dependencies: Partial<Dependencies> = {}) {
  const result = await connectFirstBootGuest(input, dependencies, {
    kind: "bundle", script: PROVIDER_SHUTDOWN_READINESS_SCRIPT,
  });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderShutdownReadiness(result.output) };
}

/** Fixed, read-only discovery recipe. No caller-selected shell or SSH options.
 * The owner-scoped caller must retain the lifecycle lease throughout this call.
 */
export async function inspectFirstBootGuest(input:FirstBootSshInput & {connectionId:string},dependencies:Partial<Dependencies>={}):Promise<FirstBootSshIdentity & {output:string}> {
  let script:string;
  try{script=buildReadOnlyHostDiscoveryScript(input.connectionId);}catch{throw new FirstBootSshError("invalid_identity");}
  return connectFirstBootGuest(input,dependencies,{kind:"discovery",script});
}

/** Install only the allowlisted, checksum-bound bundle in its fixed directory.
 * No runtime file is executed. Caller retains the shared owner lifecycle lease;
 * an uncertain channel outcome must keep that lease until its normal expiry.
 */
export async function installFirstBootGuestBundle(input:FirstBootSshInput & {
  scope:FirstBootOperationScope;assets:PortableProvisionerBundleAsset[];
},dependencies:Partial<Dependencies>={}):Promise<FirstBootSshIdentity & {receipt:ProviderGuestBundleReceipt}> {
  // Validate before network, then sample the guest's suspend-aware monotonic
  // clock over a clean authenticated channel. The second command cannot gain a
  // new lifetime by being queued before sudo/timeout begins on the guest.
  providerGuestBundleReceipt(input.scope,input.assets);
  const scope=structuredClone(input.scope),assets=input.assets.map(asset=>({relativePath:asset.relativePath,content:Buffer.from(asset.content)}));
  const transport={address:input.address,hostPublicKey:input.hostPublicKey,administratorPublicKey:input.administratorPublicKey,
    administratorPrivateKey:input.administratorPrivateKey,dispatchDeadlineMs:input.dispatchDeadlineMs};
  const clockResult=await connectFirstBootGuest(transport,dependencies,{kind:"bundle",script:PROVIDER_GUEST_CLOCK_SCRIPT});
  const clock=parseProviderGuestClock(clockResult.output);
  const plan=buildProviderGuestBundlePlan(scope,assets,clock);
  const result=await connectFirstBootGuest(transport,dependencies,{kind:"bundle",script:plan.script});
  const receipt=parseProviderGuestBundleReceipt(result.output,plan.receipt);
  return {hostVerified:result.hostVerified,administratorAuthenticated:result.administratorAuthenticated,
    hostFingerprintSha256:result.hostFingerprintSha256,receipt};
}

/** Fixed bounded command over the same pinned SSH transport. This requires
 * an existing provider agent operation retained by the caller across polls;
 * it must NOT acquire/release the pre-allocation first-boot lease. Cancellation
 * is terminal only after the worker returns an exact stopped receipt.
 */
export async function controlProviderGuestInstaller(input: FirstBootSshInput & ProviderGuestWorkerInput,
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & {receipt: ProviderGuestWorkerReceipt}> {
  const request = structuredClone(input);
  if (request.action === "start" && input.action === "start") {
    request.assets = input.assets.map(asset => ({relativePath: asset.relativePath, content: Buffer.from(asset.content)}));
  }
  // Validate all caller-owned data before any network/authentication.
  buildProviderGuestWorkerPlan(request, {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 0});
  const clockResult = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: PROVIDER_GUEST_CLOCK_SCRIPT});
  const plan = buildProviderGuestWorkerPlan(request, parseProviderGuestClock(clockResult.output));
  const result = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: plan.script});
  return {hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderGuestWorkerReceipt(result.output, plan.identity)};
}

/** Private transport; its adapter acquires cleanup grants before invoking it.
 * No public route caller. Uses the SAME pinned SSH/signing/deadline
 * boundary as v1, but retained v2 recovery and boot-bound cleanup receipts.
 * A stopped installer alone is not native cleanup or permission to release.
 */
export async function controlProviderNativeInstaller(input: FirstBootSshInput & ProviderNativeWorkerInput,
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & {receipt: ProviderNativeWorkerReceipt; clock: ProviderGuestClock}> {
  const request = structuredClone(input);
  if (request.action === "start" && input.action === "start") {
    request.assets = input.assets.map(asset => ({relativePath: asset.relativePath, content: Buffer.from(asset.content)}));
  }
  buildProviderNativeWorkerPlan(request, {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 0});
  const clockResult = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: PROVIDER_GUEST_CLOCK_SCRIPT});
  const clock = parseProviderGuestClock(clockResult.output);
  const plan = buildProviderNativeWorkerPlan(request, clock);
  const result = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: plan.script});
  return {hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, clock, receipt: parseProviderNativeWorkerReceipt(result.output, plan.identity, clock)};
}

/** Private desktop transport. The lifecycle adapter must hold dispatch/cleanup
 * authority before calling; neither a stopped installer nor this receipt can
 * release that authority. Both clock and worker channels use the original
 * enrolled host pin, administrator key and unchanged monotonic deadline.
 */
export async function controlProviderDesktopInstaller(input: FirstBootSshInput & ProviderDesktopWorkerInput,
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & {receipt: ProviderDesktopWorkerReceipt; clock: ProviderGuestClock}> {
  const request = structuredClone(input);
  if (request.action === "start" && input.action === "start") {
    request.assets = input.assets.map(asset => ({relativePath: asset.relativePath, content: Buffer.from(asset.content)}));
  }
  buildProviderDesktopWorkerPlan(request, {bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 0});
  const clockResult = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: PROVIDER_GUEST_CLOCK_SCRIPT});
  const clock = parseProviderGuestClock(clockResult.output);
  const plan = buildProviderDesktopWorkerPlan(request, clock);
  const result = await connectFirstBootGuest(request, dependencies, {kind: "bundle", script: plan.script});
  return {hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, clock, receipt: parseProviderDesktopWorkerReceipt(result.output, plan.identity, clock)};
}

/** Read-only service/authentication observation. No worker execution, package
 * installation, token rotation or current-bundle substitution. */
export async function inspectProviderGuestRuntime(input: FirstBootSshInput & ProviderGuestRuntimeProbe,
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & { receipt: ProviderGuestRuntimeReceipt }> {
  const request = structuredClone(input), plan = buildProviderGuestRuntimeProbe(request);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script: plan.script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderGuestRuntimeReceipt(result.output, request) };
}

/** Fixed native ownership/authentication probe over the same pinned SSH lane. */
export async function inspectProviderNativeRuntime(input: FirstBootSshInput & ProviderNativeRuntimeProbe,
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & { receipt: ProviderNativeRuntimeReceipt }> {
  const request = structuredClone(input), plan = buildProviderNativeRuntimeProbe(request);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script: plan.script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderNativeRuntimeReceipt(result.output, request) };
}

/** Read-only retained desktop ownership observation. The caller keeps the
 * original lifecycle authority; this does not publish readiness or prove an
 * authenticated public desktop session. No new host key or bundle is trusted. */
export async function inspectProviderDesktopRuntime(input: FirstBootSshInput & ProviderDesktopRuntimeProbe,
  dependencies: Partial<Dependencies> = {}) {
  const request = structuredClone(input), script = buildProviderDesktopRuntimeProbe(request);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderDesktopRuntimeReceipt(result.output, request) };
}

/** Original enrolled SSH lane, with installed workspace protocol observation.
 * No session is issued and no guest configuration is changed by this probe. */
export async function inspectProviderWorkspaceRuntime(input: FirstBootSshInput & ProviderWorkspaceRuntimeProbe,
  dependencies: Partial<Dependencies> = {}) {
  const request = structuredClone(input), script = buildProviderWorkspaceRuntimeProbe(request);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderWorkspaceRuntimeReceipt(result.output, request) };
}

/** Kernel boot observation also works when the desktop service is unhealthy.
 * The power caller must separately validate the original provider operation. */
export async function inspectProviderGuestClock(input: FirstBootSshInput, dependencies: Partial<Dependencies> = {}) {
  const request = structuredClone(input);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script: PROVIDER_GUEST_CLOCK_SCRIPT });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, clock: parseProviderGuestClock(result.output) };
}

/** Read-only boot and desktop observation using the original enrolled SSH pin. */
export async function inspectProviderDesktopPower(input: FirstBootSshInput & ProviderDesktopRuntimeProbe,
  dependencies: Partial<Dependencies> = {}) {
  const request = structuredClone(input), script = buildProviderDesktopPowerProbe(request);
  const result = await connectFirstBootGuest(request, dependencies, { kind: "bundle", script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, receipt: parseProviderDesktopPowerReceipt(result.output, request) };
}

/** Largest server-built guest seed accepted (the Bankr skill suite is the biggest). */
export const MAX_PROVIDER_GUEST_SEED_BYTES=1024*1024;

/** Server-built guest seed over the original enrolled pin: the provider-VM
 * twin of the Proxmox host-to-guest seed lane (identity files, skill files,
 * the Computer Contract). The caller builds the script from server data only,
 * with every payload base64-encoded inside it, and must have loaded a stable
 * running computer. It runs as root with no inherited environment under the
 * same 8-second bound. It creates no lifecycle state and trusts no new key. */
export async function runProviderGuestSeed(input: FirstBootSshInput & { script: string },
  dependencies: Partial<Dependencies> = {}): Promise<FirstBootSshIdentity & { output: string }> {
  const request = structuredClone(input);
  if (typeof request.script !== "string" || !request.script.startsWith("set -e\n")
    || Buffer.byteLength(request.script) > MAX_PROVIDER_GUEST_SEED_BYTES) throw new FirstBootSshError("invalid_identity");
  const result = await connectFirstBootGuest(request, dependencies, { kind: "seed", script: request.script });
  return { hostVerified: result.hostVerified, administratorAuthenticated: result.administratorAuthenticated,
    hostFingerprintSha256: result.hostFingerprintSha256, output: result.output };
}

async function connectFirstBootGuest(input:FirstBootSshInput,dependencies:Partial<Dependencies>,recipe?:{
  kind:"discovery"|"bundle"|"seed";script:string;
}):Promise<FirstBootSshIdentity & {output:string}> {
  const deps={...defaults,...dependencies};
  const {address,hostPublicKey,administratorPublicKey,administratorPrivateKey,dispatchDeadlineMs}=input;
  // No hostname resolution, proxy, local SSH agent, key file, ambient fleet
  // setting or caller-selected SSH user/port can redirect this connection.
  if(blockedAddress(address)) {
    throw new FirstBootSshError("address_blocked");
  }
  const startedAt=deps.monotonicNow();
  const remaining=dispatchDeadlineMs-startedAt;
  if(!Number.isFinite(remaining) || remaining<=0 || remaining>30_000) throw new FirstBootSshError("deadline_expired");
  const deadline=Math.min(dispatchDeadlineMs,startedAt+10_000);
  let pin:ReturnType<typeof canonicalFirstBootHostKey>,expected:Buffer;
  let signingKey:ParsedKey|null=null,administratorKey:ParsedKey;
  try {
    pin=canonicalFirstBootHostKey(hostPublicKey);
    const administrator=canonicalFirstBootHostKey(administratorPublicKey);
    if(typeof administratorPrivateKey!=="string" || administratorPrivateKey.length>16_384) throw new Error();
    const parsed=utils.parseKey(administratorPrivateKey),publicParsed=utils.parseKey(administrator.publicKey);
    if(parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey() || parsed.type!=="ssh-ed25519"
      || !parsed.getPublicSSH().equals(Buffer.from(administrator.publicKey.split(" ")[1],"base64"))) throw new Error();
    if(publicParsed instanceof Error || Array.isArray(publicParsed) || publicParsed.isPrivateKey())throw new Error();
    // OpenSSH's embedded public bytes alone do not prove the private seed
    // belongs to this key. Verify locally before exposing any identity/network.
    const challenge=Buffer.concat([Buffer.from("hivra-first-boot-key-check\0"),randomBytes(32)]);
    const signature=parsed.sign(challenge);
    if(!Buffer.isBuffer(signature) || publicParsed.verify(challenge,signature)!==true)throw new Error();
    signingKey=parsed;administratorKey=publicParsed;
    expected=Buffer.from(pin.publicKey.split(" ")[1],"base64");
  } catch { throw new FirstBootSshError("invalid_identity"); }

  return new Promise((resolve,reject)=>{
    let client:Client;
    try{client=deps.client();}catch{signingKey=null;reject(new FirstBootSshError("connection_failed"));return;}
    let settled=false,pinVerified=false,authAttempted=false,signatureProduced=false,commandStarted=false;
    let outputBytes=0;
    const output:Buffer[]=[];
    let refused:FirstBootSshError["code"]|null=null;
    const finish=(code:FirstBootSshError["code"]|null)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      try{client.destroy();}catch{/* No teardown exception may expose key material. */}
      signingKey=null; // Release our signer; not a claim of full memory erasure.
      if(!code && deps.monotonicNow()>=deadline)code="deadline_expired";
      if(code)reject(new FirstBootSshError(code));
      else resolve({hostVerified:true,administratorAuthenticated:true,hostFingerprintSha256:pin.fingerprintSha256,
        output:Buffer.concat(output).toString("utf8")});
    };
    const current=()=>!settled && deps.monotonicNow()<deadline;
    const timer=setTimeout(()=>finish("deadline_expired"),Math.max(1,deadline-deps.monotonicNow()));
    // This is an in-memory signer, NOT a socket/ambient SSH agent. ssh2 asks
    // for the signature only after USERAUTH_PK_OK; fencing authHandler alone
    // would allow an old probe to authenticate after its authority expired.
    const signer=new class extends BaseAgent<ParsedKey> {
      getIdentities(callback:IdentityCallback<ParsedKey>) {
        if(!current()){refused="deadline_expired";callback(new FirstBootSshError(refused));return;}
        if(!pinVerified || !authAttempted){callback(new FirstBootSshError("authentication_failed"));return;}
        callback(null,[administratorKey]);
      }
      sign(key:ParsedKey,data:Buffer,options:SigningRequestOptions,callback?:SignCallback):void;
      sign(key:ParsedKey,data:Buffer,callback:SignCallback):void;
      sign(key:ParsedKey,data:Buffer,options:SigningRequestOptions|SignCallback,callback?:SignCallback) {
        const done=typeof options==="function"?options:callback;
        if(!done)return;
        if(!current()){refused="deadline_expired";done(new FirstBootSshError(refused));return;}
        let signature:Buffer;
        try {
          if(!pinVerified || !authAttempted || signatureProduced || !signingKey
            || !key.getPublicSSH().equals(administratorKey.getPublicSSH()))throw new Error();
          signature=signingKey.sign(data);
          if(!Buffer.isBuffer(signature) || administratorKey.verify(data,signature)!==true)throw new Error();
        } catch {done(new FirstBootSshError("authentication_failed"));return;}
        if(!current()){refused="deadline_expired";done(new FirstBootSshError(refused));return;}
        signatureProduced=true;
        done(null,signature);
      }
    }();
    const config:ConnectConfig={host:address,port:22,username:"hivra",
      algorithms:{serverHostKey:["ssh-ed25519"]},readyTimeout:Math.max(1,deadline-deps.monotonicNow()),
      tryKeyboard:false,keepaliveInterval:0,
      hostVerifier:(key:Buffer)=>{
        if(!current()){refused="deadline_expired";return false;}
        pinVerified=Buffer.isBuffer(key) && key.length===expected.length && timingSafeEqual(key,expected);
        if(!pinVerified)refused="host_key_mismatch";
        return pinVerified;
      },
      authHandler:(_methods,_partial,callback)=>{
        // ssh2 supports synchronous false; its callback typedef omits false.
        if(!current()){refused="deadline_expired";return false;}
        if(!pinVerified || authAttempted)return false;
        authAttempted=true;
        callback({type:"agent",username:"hivra",agent:signer});
      },
    };
    client.on("ready",()=>{
      if(settled || commandStarted)return;
      if(!current())return finish("deadline_expired");
      if(!pinVerified)return finish("host_key_mismatch");
      if(!authAttempted || !signatureProduced)return finish("authentication_failed");
      if(recipe===undefined)return finish(null);
      commandStarted=true;
      // Remote process lifetime stays below the shared lease even if SSH dies.
      // Both recipes have fixed interpreters and no inherited environment.
      // Python imports must not create bytecode files on the read-only probe.
      const command="sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s "
        +(recipe.kind==="discovery" || recipe.kind==="seed"?"/bin/bash --noprofile --norc -s":"/usr/bin/python3 -I -B -");
      if(!current())return finish("deadline_expired");
      try {client.exec(command,(error,stream)=>{
        const active=()=>{
          if(settled)return false;
          if(!current()){finish("deadline_expired");return false;}
          return true;
        };
        if(!active()){try{stream?.destroy();}catch{/* No late stdin. */}return;}
        if(error || !stream)return finish("command_failed");
        const capture=(chunk:Buffer,stdout:boolean)=>{
          if(!active())return;
          if(!Buffer.isBuffer(chunk))return finish("command_failed");
          if(chunk.length>MAX_HOST_DISCOVERY_OUTPUT_BYTES-outputBytes)return finish("output_limit");
          outputBytes+=chunk.length;
          if(stdout)output.push(chunk);
        };
        stream.on("data",(chunk:Buffer)=>capture(chunk,true));
        stream.stderr.on("data",(chunk:Buffer)=>capture(chunk,false));
        stream.on("error",()=>finish("command_failed"));
        stream.stderr.on("error",()=>finish("command_failed"));
        stream.on("close",(code:number|null,signal?:string)=>{
          if(active())finish(code===0 && !signal?null:"command_failed");
        });
        if(!active()){try{stream.destroy();}catch{/* No late stdin. */}return;}
        try{stream.end(recipe.script);}catch{finish("command_failed");}
      });} catch{finish("command_failed");}
    });
    client.on("error",(error:Error & {level?:string})=>finish(refused??(
      error.level==="client-authentication"?"authentication_failed":"connection_failed")));
    client.on("close",()=>finish(refused??"connection_failed"));
    client.on("end",()=>finish(refused??"connection_failed"));
    // No awaited work separates the final local fence and the socket dispatch.
    if(!current())return finish("deadline_expired");
    try{client.connect(config);}catch{finish("connection_failed");}
  });
}
