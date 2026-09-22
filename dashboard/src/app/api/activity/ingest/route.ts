import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { inspectActivityCollectorToken, type ActivityCollectorClaims } from "@/lib/activity-observability/auth";
import { recordCollectorEvents, recordCollectorHeartbeat, recordCollectorRejected } from "@/lib/activity-observability/collectors";
import { normalizeOtlpJson } from "@/lib/activity-observability/otlp";
import { persistTelemetryEvents } from "@/lib/activity-observability/store";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE="/api/activity/ingest";
const MAX_BODY_BYTES=1_048_576;
/** Matches the event time window's future bound in normalizeOtlpJson. */
const CLOCK_SKEW_WARN_SECONDS=300;
// Matches the event window in normalizeOtlpJson: 5 min ahead, 90 days behind.
const CLOCK_SKEW_MAX_BEHIND_SECONDS=90*86_400;

type IngestAgent={id:string;user_id:string;type:string|null;name:string|null;status:string;desired_state:string|null};

async function readBoundedBody(request:NextRequest):Promise<Uint8Array|null>{
  if(!request.body) return new Uint8Array();
  const reader=request.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();return null;}chunks.push(value);}
  } finally { reader.releaseLock(); }
  const joined=new Uint8Array(total);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}return joined;
}

/**
 * The signed owner's computer, or null when it is not theirs or is deleted or
 * being deleted. Deletion revokes collection immediately: desired_state flips
 * to 'deleted' before status does. desired_state is nullable on older rows, so
 * it is checked here rather than with a SQL <> that would drop NULLs.
 */
async function loadCollectingAgent(resourceId:string,userId:string):Promise<{agent:IngestAgent|null;failed:boolean}>{
  const {data,error}=await supabaseAdmin!.from("hivra_agents").select("id,user_id,type,name,status,desired_state").eq("id",resourceId).eq("user_id",userId).neq("status","deleted").maybeSingle<IngestAgent>();
  if(error) return {agent:null,failed:true};
  return {agent:data&&data.status!=="deleted"&&data.desired_state!=="deleted"?data:null,failed:false};
}

/** Direct evidence for Activity that a correctly signed credential ran out. Best effort; the response is 401 either way. */
async function recordExpiredCredential(claims:ActivityCollectorClaims,resourceId:string|undefined):Promise<void>{
  if(!supabaseAdmin||!resourceId||!claims.resourceIds.includes(resourceId)) return;
  try {
    const {agent}=await loadCollectingAgent(resourceId,claims.userId);
    if(agent&&!(await recordCollectorRejected(supabaseAdmin,{agentId:agent.id,userId:claims.userId,reason:"expired"}))) log.warn("activity collector rejection not recorded",{source:"activity-ingest",route:ROUTE,agentId:agent.id});
  } catch { /* the credential is refused regardless */ }
}

export async function POST(request:NextRequest){
  const inspection=inspectActivityCollectorToken(request.headers.get("authorization"));
  const resourceId=request.headers.get("x-hivra-resource-id")?.trim().toLowerCase();
  if(inspection.status==="expired"){
    await recordExpiredCredential(inspection.claims,resourceId);
    return apiError("Unauthorized",401,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"expired_collector_token",logLevel:"warn"});
  }
  if(inspection.status!=="valid") return apiError("Unauthorized",401,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"invalid_collector_token",logLevel:"warn"});
  const claims=inspection.claims;
  if(!resourceId||!claims.resourceIds.includes(resourceId)) return apiError("Resource outside collector scope",403,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"resource_outside_scope",logLevel:"warn"});
  const contentType=request.headers.get("content-type")?.toLowerCase()??"";
  if(!contentType.startsWith("application/json")) return apiError("OTLP JSON required",415);
  const declared=Number(request.headers.get("content-length")??0);
  if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES) return apiError("Telemetry payload too large",413);
  if(!supabaseAdmin) return apiError("Database not configured",500);
  let bytes:Uint8Array|null;
  try { bytes=await readBoundedBody(request); } catch { return apiError("Invalid telemetry payload",400); }
  if(!bytes) return apiError("Telemetry payload too large",413);
  let body:unknown;
  try { body=JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return apiError("Invalid JSON body",400); }
  let normalized;
  try { normalized=normalizeOtlpJson(body,resourceId); }
  catch(error){ return apiError(error instanceof Error&&error.message==="too_many_telemetry_items"?"Too many telemetry items":"Invalid OTLP payload",400); }
  if(!normalized) return apiError("Unsupported OTLP JSON payload",400);
  const {agent,failed}=await loadCollectingAgent(resourceId,claims.userId);
  if(failed) return apiError("Failed to validate telemetry resource",500);
  if(!agent) return apiError("Telemetry resource not found",404,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"resource_not_owned",logLevel:"warn"});
  let result;
  try { result=await persistTelemetryEvents(supabaseAdmin,claims.userId,agent,normalized.events); }
  catch { return apiError("Failed to persist telemetry",500,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"telemetry_persist_failed"}); }
  // Reporter state is keyed on the server's receive time, never the guest
  // clock, and on the expiry of the credential actually presented.
  const receivedAt=new Date(); const credentialExpiresAt=new Date(claims.exp*1000).toISOString();
  const recorded=await Promise.all([
    normalized.heartbeats.length?recordCollectorHeartbeat(supabaseAdmin,{agentId:agent.id,userId:claims.userId,receivedAt,credentialExpiresAt}):true,
    result.accepted>0?recordCollectorEvents(supabaseAdmin,{agentId:agent.id,userId:claims.userId,receivedAt,credentialExpiresAt}):true,
  ]);
  if(recorded.includes(false)) log.warn("activity collector state not recorded",{source:"activity-ingest",route:ROUTE,agentId:agent.id});
  // A wrong guest clock never blocks liveness, but it does refuse run records,
  // so it is surfaced to operators and to the reporter instead of staying silent.
  const guestClockMs=normalized.heartbeats.map(h=>Date.parse(h.occurredAt)).filter(Number.isFinite).at(-1);
  const clockSkewSeconds=guestClockMs===undefined?undefined:Math.round((guestClockMs-receivedAt.getTime())/1000);
  if(normalized.clockSkewedLogRecords||(clockSkewSeconds!==undefined&&Math.abs(clockSkewSeconds)>CLOCK_SKEW_WARN_SECONDS)) log.warn("activity collector clock skew",{source:"activity-ingest",route:ROUTE,agentId:agent.id,clockSkewSeconds,clockSkewedLogRecords:normalized.clockSkewedLogRecords});
  // Run records from a clock outside the accepted window are refused, so a
  // computer that still checks in must not look healthy: record why.
  const runRecordsRefusedByClock=normalized.clockSkewedLogRecords>0||(clockSkewSeconds!==undefined&&(clockSkewSeconds>CLOCK_SKEW_WARN_SECONDS||clockSkewSeconds<-CLOCK_SKEW_MAX_BEHIND_SECONDS));
  if(runRecordsRefusedByClock&&!(await recordCollectorRejected(supabaseAdmin,{agentId:agent.id,userId:claims.userId,reason:"clock_skew",rejectedAt:receivedAt}))) log.warn("activity collector clock skew not recorded",{source:"activity-ingest",route:ROUTE,agentId:agent.id});
  const partialSuccess:Record<string,unknown>={};
  if(normalized.rejectedSpans) partialSuccess.rejectedSpans=normalized.rejectedSpans;
  if(normalized.rejectedLogRecords) partialSuccess.rejectedLogRecords=normalized.rejectedLogRecords;
  if(normalized.rejectedSpans||normalized.rejectedLogRecords) partialSuccess.errorMessage="Records with invalid identifiers, timestamps or fields were rejected."
    +(normalized.clockSkewedLogRecords?` ${normalized.clockSkewedLogRecords} run record(s) had timestamps more than 5 minutes ahead of, or 90 days behind, the server clock; check the computer's clock.`:"");
  return Response.json(Object.keys(partialSuccess).length?{partialSuccess}:{},{status:200,headers:{"Cache-Control":"no-store","x-hivra-accepted":String(result.accepted),"x-hivra-duplicates":String(result.duplicates)}});
}
