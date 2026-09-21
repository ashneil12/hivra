import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { verifyActivityCollectorToken } from "@/lib/activity-observability/auth";
import { normalizeOtlpJson } from "@/lib/activity-observability/otlp";
import { persistTelemetryEvents } from "@/lib/activity-observability/store";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE="/api/activity/ingest";
const MAX_BODY_BYTES=1_048_576;

async function readBoundedBody(request:NextRequest):Promise<Uint8Array|null>{
  if(!request.body) return new Uint8Array();
  const reader=request.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();return null;}chunks.push(value);}
  } finally { reader.releaseLock(); }
  const joined=new Uint8Array(total);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}return joined;
}

export async function POST(request:NextRequest){
  const claims=verifyActivityCollectorToken(request.headers.get("authorization"));
  if(!claims) return apiError("Unauthorized",401,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"invalid_collector_token",logLevel:"warn"});
  const resourceId=request.headers.get("x-hivra-resource-id")?.trim().toLowerCase();
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
  const {data:agent,error}=await supabaseAdmin.from("hivra_agents").select("id,user_id,type,name,status").eq("id",resourceId).eq("user_id",claims.userId).neq("status","deleted").maybeSingle<{id:string;user_id:string;type:string|null;name:string|null;status:string}>();
  if(error) return apiError("Failed to validate telemetry resource",500);
  if(!agent) return apiError("Telemetry resource not found",404,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"resource_not_owned",logLevel:"warn"});
  try {
    const result=await persistTelemetryEvents(supabaseAdmin,claims.userId,agent,normalized.events);
    const partialSuccess:Record<string,unknown>={};
    if(normalized.rejectedSpans) partialSuccess.rejectedSpans=normalized.rejectedSpans;
    if(normalized.rejectedLogRecords) partialSuccess.rejectedLogRecords=normalized.rejectedLogRecords;
    if(normalized.rejectedSpans||normalized.rejectedLogRecords) partialSuccess.errorMessage="Records with invalid identifiers or timestamps were rejected.";
    return Response.json(Object.keys(partialSuccess).length?{partialSuccess}:{},{status:200,headers:{"Cache-Control":"no-store","x-hivra-accepted":String(result.accepted),"x-hivra-duplicates":String(result.duplicates)}});
  } catch {
    return apiError("Failed to persist telemetry",500,undefined,undefined,{source:"activity-ingest",route:ROUTE,failureType:"telemetry_persist_failed"});
  }
}
