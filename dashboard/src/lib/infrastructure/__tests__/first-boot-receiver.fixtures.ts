import { createFirstBootChallenge, FIRST_BOOT_RECIPE_VERSION, canonicalFirstBootHostKey } from "../first-boot-enrollment";
import type { StoredFirstBootEnrollment } from "../first-boot-store";
import type { FirstBootCapacityEvidence } from "../first-boot-receiver";
import { cleanupFixture, cleanupConnection, cleanupOrder } from "./hetzner-cleanup.fixtures";
import { HETZNER_CLOUD_BILLING_SEMANTICS, HETZNER_CLOUD_FIREWALL_LIMITATION,
  HETZNER_CLOUD_SIMPLE_MODE_POLICY,HETZNER_CLOUD_SPENDING_CONFIRMATION } from "../contracts";

export const firstBootNow = new Date("2026-08-27T15:00:00.000Z");
export function receiverFixture() {
  const {order,snapshot} = cleanupFixture();
  const binding = {userId:"owner",connectionId:cleanupConnection,connectionRevision:7,
    orderId:cleanupOrder,attemptId:"44444444-4444-4444-8444-444444444444",
    quoteFingerprint:"a".repeat(64),recipeVersion:FIRST_BOOT_RECIPE_VERSION};
  const proof = createFirstBootChallenge(binding,firstBootNow);
  const host = canonicalFirstBootHostKey("ssh-ed25519 "+Buffer.concat([
    Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,8),
  ]).toString("base64"));
  const stored: StoredFirstBootEnrollment = {challenge:proof.challenge,phase:"awaiting_identity",
    capacityIdempotencyKey:"33333333-3333-4333-8333-333333333333",providerServerId:"42",
    enrolledHostPublicKey:null,hostFingerprintSha256:null};
  const amount = {net:"1",gross:"1.19"};
  const component = {hourly:amount,monthly:amount};
  const evidence: FirstBootCapacityEvidence = {
    id:binding.orderId,user_id:binding.userId,connection_id:binding.connectionId,active_connection_id:binding.connectionId,
    connection_revision:7,provider:"hetzner-cloud",status:"created_off",quote_fingerprint_sha256:binding.quoteFingerprint,
    provider_labels:{"hivra-operation":binding.orderId,"hivra-quote":"a".repeat(32),"hivra-managed":"true"},
    provider_resource_id:"42",provider_action_id:"500",provider_server_status:"accepted",
    provider_creation_receipt:order.creationReceipt!,
    quote_snapshot:{id:binding.orderId,connectionId:binding.connectionId,connectionRevision:7,
      serverName:snapshot.server!.name,serverType:{id:104,name:"cpx22",description:"CPX 22",architecture:"x86",cores:2,memoryGb:4,diskGb:80},
      location:{id:1,name:"fsn1",city:"Falkenstein",country:"DE"},
      image:{id:100,type:"system",name:"ubuntu-24.04",description:"Ubuntu 24.04",architecture:"x86",osFlavor:"ubuntu",osVersion:"24.04"},
      price:{currency:"EUR",vatRate:"19",server:component,primaryIpv4:component,primaryIpv6:component,total:component,
        traffic:{includedBytes:0,additionalPerTb:amount}},
      publicNetwork:{ipv4:true,ipv6:true},backups:false,volumes:[],startAfterCreate:false,
      simpleModePolicy:{...HETZNER_CLOUD_SIMPLE_MODE_POLICY,maxMonthlyGrossByCurrency:[
        {...HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMonthlyGrossByCurrency[0]},
        {...HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMonthlyGrossByCurrency[1]},
      ]},billing:HETZNER_CLOUD_BILLING_SEMANTICS,
      access:{username:"hivra",method:"generated-ed25519",inboundTcpPortsAfterFirstBoot:[22],passwordAuthentication:false,
        rootSshLogin:false,providerFirewallAttached:false,firewallLimitation:HETZNER_CLOUD_FIREWALL_LIMITATION},
      fetchedAt:firstBootNow.toISOString(),expiresAt:new Date(firstBootNow.getTime()+300_000).toISOString(),
      spendingConfirmation:HETZNER_CLOUD_SPENDING_CONFIRMATION},
  };
  const server = snapshot.server!; server.status = "running";
  const action = {id:500,command:"create_server",status:"success" as const,resources:[{id:42,type:"server"}]};
  const input = {token:proof.token,registration:{version:1,orderId:binding.orderId,attemptId:binding.attemptId,
    providerServerId:"42",hostPublicKey:host.publicKey}};
  return {binding,proof,host,stored,evidence,server,action,input};
}
