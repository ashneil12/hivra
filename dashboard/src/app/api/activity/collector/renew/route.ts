import type { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { inspectActivityCollectorToken, mintActivityCollectorToken } from "@/lib/activity-observability/auth";
import { ACTIVITY_COLLECTOR_TTL_SECONDS, recordCollectorRenewed, supportsNativeTracing } from "@/lib/activity-observability/collectors";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guest reporter credential renewal.
// Contract: docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md
// The presented token is the only authority: it must be valid, unexpired and
// scoped to exactly the one computer named in X-Hivra-Resource-Id, and that
// computer must still belong to the token's user, not be (or be becoming)
// deleted, and be a type with a verified native producer. The new token is
// returned once in the body and never logged.

const ROUTE="/api/activity/collector/renew";
const MAX_BODY_BYTES=1024;
const MIN_RENEW_AGE_SECONDS=60*60;

type RenewAgent={id:string;user_id:string;type:string|null;status:string;desired_state:string|null;computer_substrate:string|null};

const refuse=(message:string,status:number,failureType:string)=>apiError(message,status,undefined,undefined,{source:"activity-collector-renew",route:ROUTE,failureType,logLevel:status>=500?"error":"warn"});

/** The body is `{}` (or empty). Anything else is refused so the endpoint carries no hidden inputs. */
async function emptyObjectBody(request:NextRequest):Promise<boolean>{
  if(!request.body) return true;
  const reader=request.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();return false;}chunks.push(value);}
  } finally { reader.releaseLock(); }
  const text=Buffer.concat(chunks).toString("utf8").trim();
  if(!text) return true;
  try {
    const parsed:unknown=JSON.parse(text);
    return !!parsed&&typeof parsed==="object"&&!Array.isArray(parsed)&&Object.keys(parsed).length===0;
  } catch { return false; }
}

export async function POST(request:NextRequest){
  const now=Math.floor(Date.now()/1000);
  const inspection=inspectActivityCollectorToken(request.headers.get("authorization"),now);
  if(inspection.status!=="valid") return refuse("Unauthorized",401,inspection.status==="expired"?"expired_collector_token":"invalid_collector_token");
  const claims=inspection.claims;
  const resourceId=request.headers.get("x-hivra-resource-id")?.trim().toLowerCase();
  if(!resourceId||claims.resourceIds.length!==1||claims.resourceIds[0]!==resourceId) return refuse("Resource outside collector scope",403,"resource_outside_scope");
  let bodyOk:boolean;
  try { bodyOk=await emptyObjectBody(request); } catch { bodyOk=false; }
  if(!bodyOk) return refuse("Renewal takes an empty JSON object",400,"invalid_renew_body");
  const age=now-claims.iat;
  if(age<MIN_RENEW_AGE_SECONDS){
    const response=refuse("Collector credential was issued too recently to renew",429,"renew_too_soon");
    response.headers.set("Retry-After",String(MIN_RENEW_AGE_SECONDS-Math.max(age,0)));
    return response;
  }
  if(!supabaseAdmin) return refuse("Database not configured",500,"database_unavailable");
  const {data:agent,error}=await supabaseAdmin.from("hivra_agents").select("id,user_id,type,status,desired_state,computer_substrate").eq("id",resourceId).eq("user_id",claims.userId).neq("status","deleted").maybeSingle<RenewAgent>();
  if(error) return refuse("Failed to validate collector resource",500,"resource_lookup_failed");
  if(!agent||agent.status==="deleted"||agent.desired_state==="deleted") return refuse("Collector resource not found",404,"resource_not_owned");
  if(!supportsNativeTracing(agent)) return refuse("Agent run reporting is not available for this computer",403,"unsupported_agent");
  const exp=now+ACTIVITY_COLLECTOR_TTL_SECONDS;
  let token:string;
  try { token=mintActivityCollectorToken({userId:claims.userId,resourceIds:[agent.id],iat:now,exp}); }
  catch { return refuse("Collector renewal unavailable",503,"collector_signing_unavailable"); }
  const expiresAt=new Date(exp*1000).toISOString();
  if(!(await recordCollectorRenewed(supabaseAdmin,{agentId:agent.id,userId:claims.userId,expiresAt,issuedAt:new Date(now*1000)}))) log.warn("activity collector renewal not recorded",{source:"activity-collector-renew",route:ROUTE,agentId:agent.id});
  return Response.json({token,expiresAt},{status:200,headers:{"Cache-Control":"no-store"}});
}
