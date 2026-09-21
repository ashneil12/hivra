import "server-only";

import { loadHetznerCloudCapacityBootstrap } from "./hetzner-cloud-store";
import { claimEnrolledGuestOperation, releaseFirstBootOperation, type FirstBootOperationScope } from "./first-boot-operations";
import { FirstBootSshError, verifyFirstBootSshIdentity, inspectFirstBootGuest, installFirstBootGuestBundle } from "./first-boot-ssh";
import { loadPortableProvisionerBundle } from "./connection-preparation";
import { providerGuestBundleReceipt, type ProviderGuestBundleReceipt } from "./provider-guest-bundle";
import { parseProviderGuestDiscoveryOutput } from "./host-discovery";
import type { ProviderGuestDiscoverySnapshot } from "./host-discovery-contracts";
import { verifyEnrolledProviderReceipt, EnrolledProviderReceiptError, type EnrolledProviderReceiptDependencies } from "./enrolled-provider-receipt";
import { assertProviderComputerEnvironment, publishPreparedProviderComputer } from "./provider-computer-preparation";
import type { ProviderVmDeploymentTargetDto } from "./contracts";
import { log } from "@/lib/logger";

const PREPARATION_FAILURE_CODES = new Set([
  "rejected", "resource_changed", "action_failed", "deadline_expired", "verification_failed", "checkpoint_failed",
  "bundle_outcome_unknown", "invalid_identity", "address_blocked", "host_key_mismatch", "authentication_failed",
  "connection_failed", "command_failed", "output_limit", "unsupported_environment", "invalid_evidence",
  "ENOENT", "EACCES", "ELOOP",
]);

type Dependencies = Partial<EnrolledProviderReceiptDependencies> & {
  claim: typeof claimEnrolledGuestOperation;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  ssh: typeof verifyFirstBootSshIdentity;
  inspect: typeof inspectFirstBootGuest;
  loadBundle: typeof loadPortableProvisionerBundle;
  installBundle: typeof installFirstBootGuestBundle;
  release: typeof releaseFirstBootOperation;
  publish: typeof publishPreparedProviderComputer;
  now: () => Date;
  monotonicNow: () => number;
};
const defaults:Dependencies = {
  claim:claimEnrolledGuestOperation,bootstrap:loadHetznerCloudCapacityBootstrap,
  ssh:verifyFirstBootSshIdentity,inspect:inspectFirstBootGuest,
  loadBundle:loadPortableProvisionerBundle,installBundle:installFirstBootGuestBundle,release:releaseFirstBootOperation,
  publish:publishPreparedProviderComputer,
  now:()=>new Date(),monotonicNow:()=>performance.now(),
};
class EnrolledGuestVerificationError extends Error {
  constructor(readonly code:"rejected"|"resource_changed"|"action_failed"|"deadline_expired"|"verification_failed"|"checkpoint_failed"|"bundle_outcome_unknown") {
    super("Enrolled guest verification failed: "+code);this.name="EnrolledGuestVerificationError";
  }
}

/** Private current-owner check, not runtime readiness or an install operation.
 * The one-time enrollment token is never loaded or revived. A fresh shared
 * lease protects the persisted pin from cleanup/revocation while exact provider
 * receipts are rechecked and the original administrator key authenticates.
 */
export async function verifyEnrolledGuest(input:FirstBootOperationScope,dependencies:Partial<Dependencies>={}):Promise<
  {stage:"busy"|"waiting_for_provider"}|{stage:"identity_verified";hostFingerprintSha256:string;observedAt:string}
> {
  const result=await checkEnrolledGuest(input,dependencies,"identity");
  if(result.stage==="environment_inspected" || result.stage==="bundle_installed" || result.stage==="computer_prepared")throw new EnrolledGuestVerificationError("verification_failed");
  return result;
}

/** Inspect over the same pinned session that authenticates the original key,
 * while retaining the original owner/order lifecycle lease. Facts alone do not
 * install packages, publish a target or authorize any agent launch.
 */
export async function inspectEnrolledGuest(input:FirstBootOperationScope,dependencies:Partial<Dependencies>={}):Promise<
  {stage:"busy"|"waiting_for_provider"}|{stage:"environment_inspected";snapshot:ProviderGuestDiscoverySnapshot}
> {
  const result=await checkEnrolledGuest(input,dependencies,"inspect");
  if(result.stage==="identity_verified" || result.stage==="bundle_installed" || result.stage==="computer_prepared")throw new EnrolledGuestVerificationError("verification_failed");
  return result;
}

/** Idempotent, atomic delivery under the original preparation authority. This
 * installs shared assets only; it neither selects an agent nor publishes a
 * ready target. An unacknowledged mutation retains the lease for its full
 * expiry, outliving the bounded remote process before retry/cleanup can run.
 */
export async function installEnrolledGuestBundle(input:FirstBootOperationScope,dependencies:Partial<Dependencies>={}):Promise<
  {stage:"busy"|"waiting_for_provider"}|{stage:"bundle_installed";receipt:ProviderGuestBundleReceipt;observedAt:string}
> {
  const result=await checkEnrolledGuest(input,dependencies,"install");
  if(result.stage==="identity_verified" || result.stage==="environment_inspected" || result.stage==="computer_prepared")throw new EnrolledGuestVerificationError("verification_failed");
  return result;
}

/** Inspect, deliver the reviewed bundle and publish its evidence without a
 * lease gap. Package installation still belongs to the chosen agent launch. */
export async function prepareEnrolledGuest(input:FirstBootOperationScope,dependencies:Partial<Dependencies>={}):Promise<
  {stage:"busy"|"waiting_for_provider"}|{stage:"computer_prepared";target:ProviderVmDeploymentTargetDto}
> {
  const result=await checkEnrolledGuest(input,dependencies,"prepare");
  if(result.stage==="identity_verified" || result.stage==="environment_inspected" || result.stage==="bundle_installed") {
    throw new EnrolledGuestVerificationError("verification_failed");
  }
  return result;
}

async function checkEnrolledGuest(input:FirstBootOperationScope,dependencies:Partial<Dependencies>,mode:"identity"|"inspect"|"install"|"prepare"):Promise<
  {stage:"busy"|"waiting_for_provider"}|{stage:"identity_verified";hostFingerprintSha256:string;observedAt:string}
  |{stage:"environment_inspected";snapshot:ProviderGuestDiscoverySnapshot}
  |{stage:"bundle_installed";receipt:ProviderGuestBundleReceipt;observedAt:string}
  |{stage:"computer_prepared";target:ProviderVmDeploymentTargetDto}
> {
  const deps={...defaults,...dependencies};
  const deadline=deps.monotonicNow()+30_000; // Before any awaited lease work.
  const claim=await deps.claim(input);
  if(claim.outcome==="busy")return {stage:"busy"};
  if(claim.outcome!=="claimed")throw new EnrolledGuestVerificationError("rejected");
  const {lease,operation}=claim,b=lease.binding;
  let bundleOutcomeUnknown=false;
  let stage = "provider_receipt";
  const fence=()=>{if(deps.monotonicNow()>=deadline)throw new EnrolledGuestVerificationError("deadline_expired");};
  const changed=():never=>{throw new EnrolledGuestVerificationError("resource_changed");};
  try {
    fence();
    const verified=await verifyEnrolledProviderReceipt({scope:{binding:b,providerServerId:lease.providerServerId},
      operation,dispatchDeadlineMs:deadline},deps);
    if(verified.stage==="waiting_for_provider")return verified;
    const {hostFingerprintSha256,observedAt}=verified;
    fence();
    // Load and validate server-owned assets before decrypting the admin key.
    stage = "load_bundle";
    const assets=mode==="install" || mode==="prepare"?await deps.loadBundle():null;
    const expectedReceipt=assets?providerGuestBundleReceipt({binding:b,providerServerId:lease.providerServerId},assets):null;
    fence();
    // Open the sole generated administrator key only after provider checks.
    stage = "bootstrap";
    const bootstrap=await deps.bootstrap({userId:b.userId,connectionId:b.connectionId,expectedRevision:b.connectionRevision,
      orderId:b.orderId,idempotencyKey:verified.capacityIdempotencyKey,quoteFingerprintSha256:b.quoteFingerprint});
    fence();
    const sshInput={address:verified.address,hostPublicKey:verified.hostPublicKey,
      administratorPublicKey:bootstrap.publicKeyOpenSsh,administratorPrivateKey:bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs:deadline};
    let preparationSnapshot:ProviderGuestDiscoverySnapshot|null=null;
    if(mode==="prepare"){
      stage = "guest_discovery";
      const inspected=await deps.inspect({...sshInput,connectionId:b.connectionId},{monotonicNow:deps.monotonicNow});
      fence();
      if(inspected.hostVerified!==true || inspected.administratorAuthenticated!==true
        || inspected.hostFingerprintSha256!==hostFingerprintSha256)changed();
      preparationSnapshot=parseProviderGuestDiscoveryOutput({output:inspected.output,
        discoveryId:lease.leaseId,connectionId:b.connectionId,connectionRevision:b.connectionRevision,
        providerServerId:lease.providerServerId,capacityOrderId:b.orderId,enrollmentAttemptId:b.attemptId,
        normalizedHostFingerprint:Buffer.from(hostFingerprintSha256.slice(7),"base64").toString("hex"),observedAt:new Date(observedAt)});
      assertProviderComputerEnvironment(preparationSnapshot);
      fence();
    }
    if(mode==="install" || mode==="prepare"){
      fence();
      stage = "bundle_install";
      bundleOutcomeUnknown=true;
      const installed=await deps.installBundle({...sshInput,scope:{binding:b,providerServerId:lease.providerServerId},assets:assets!},
        {monotonicNow:deps.monotonicNow});
      fence();
      if(installed.hostVerified!==true || installed.administratorAuthenticated!==true || installed.hostFingerprintSha256!==hostFingerprintSha256
        || !expectedReceipt || Object.entries(expectedReceipt).some(([key,value])=>installed.receipt?.[key as keyof ProviderGuestBundleReceipt]!==value))changed();
      bundleOutcomeUnknown=false; // Clean channel completion and exact receipt.
      if(preparationSnapshot){
        stage = "target_publish";
        const target=await deps.publish({lease,snapshot:preparationSnapshot,receipt:installed.receipt,powerOnAction:verified.powerOnAction});
        fence();
        return {stage:"computer_prepared",target};
      }
      return {stage:"bundle_installed",receipt:installed.receipt,observedAt};
    }
    stage = mode === "inspect" ? "guest_discovery" : "ssh_identity";
    const result=mode==="inspect"
      ?await deps.inspect({...sshInput,connectionId:b.connectionId},{monotonicNow:deps.monotonicNow})
      :await deps.ssh(sshInput,{monotonicNow:deps.monotonicNow});
    fence();
    if(result.hostVerified!==true || result.administratorAuthenticated!==true || result.hostFingerprintSha256!==hostFingerprintSha256)changed();
    if(mode==="inspect"){
      const output="output" in result && typeof result.output==="string"?result.output:changed();
      const snapshot=parseProviderGuestDiscoveryOutput({output,
        discoveryId:lease.leaseId,connectionId:b.connectionId,connectionRevision:b.connectionRevision,
        providerServerId:lease.providerServerId,capacityOrderId:b.orderId,enrollmentAttemptId:b.attemptId,
        normalizedHostFingerprint:Buffer.from(hostFingerprintSha256.slice(7),"base64").toString("hex"),observedAt:new Date(observedAt)});
      fence();
      return {stage:"environment_inspected",snapshot};
    }
    return {stage:"identity_verified",hostFingerprintSha256,observedAt};
  } catch(error) {
    // Never pass the exception, message, stack, cause, paths or credentials.
    // Only fixed stages and allowlisted codes identify the failing boundary.
    const code = error instanceof Error && "code" in error ? error.code : null;
    log.warn("Provider guest preparation stopped", {
      source: "provider-computer-preparation", stage,
      failureType: typeof code === "string" && PREPARATION_FAILURE_CODES.has(code) ? code : "unclassified",
      orderId: b.orderId, providerServerId: lease.providerServerId,
    });
    if(bundleOutcomeUnknown)throw new EnrolledGuestVerificationError("bundle_outcome_unknown");
    if(error instanceof EnrolledGuestVerificationError)throw error;
    if(error instanceof EnrolledProviderReceiptError)throw new EnrolledGuestVerificationError(error.code);
    if(error instanceof FirstBootSshError && error.code==="deadline_expired")throw new EnrolledGuestVerificationError("deadline_expired");
    throw new EnrolledGuestVerificationError("verification_failed");
  } finally {
    // A disconnected mutation can still be finishing remotely. Do not release
    // its original 120s lease early; the fixed process timeout is at most 9s.
    if(!bundleOutcomeUnknown){
      try {if(!await deps.release(lease))throw new Error();}
      catch {throw new EnrolledGuestVerificationError("checkpoint_failed");}
      fence(); // A delayed release acknowledgement cannot return stale success.
    }
  }
}
