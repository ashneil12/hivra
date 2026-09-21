export const runtime="nodejs";
export const dynamic="force-dynamic";
export const revalidate=0;
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError,apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { abandonHetznerCleanup } from "@/lib/infrastructure/hetzner-cloud-store";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HetznerCleanupAbandonRequestSchema } from "@/lib/infrastructure/hetzner-cleanup-contracts";
import { hasStrictJsonContentType,isSameOriginMutationRequest,MAX_CAPACITY_REQUEST_BODY_BYTES,readBoundedJson } from "../../../../../request-security";
const noStore=(response:Response)=>{response.headers.set("Cache-Control","no-store");return response;};
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}) {
  try {
    const {userId}=await auth();if(!userId)return noStore(apiError("Unauthorized",401));
    if(!isSameOriginMutationRequest(request))return noStore(apiError("Same-origin request required.",403));
    if(!hasStrictJsonContentType(request))return noStore(apiError("Content-Type must be application/json.",415));
    const id=z.string().uuid().safeParse((await context.params).id);
    if(!id.success)return noStore(apiError("Infrastructure operation not found.",404));
    const limited=enforceAuthenticatedRouteRateLimit(request,{routeKey:"hetzner_cleanup_abandon",userId,limit:2,windowMs:10*60_000});
    if(limited)return noStore(limited);
    const body=await readBoundedJson(request,MAX_CAPACITY_REQUEST_BODY_BYTES);
    if(!body.ok)return noStore(apiError("Invalid forget request.",body.reason==="too_large"?413:400));
    const parsed=HetznerCleanupAbandonRequestSchema.safeParse(body.body);
    if(!parsed.success)return noStore(apiError("Confirm that provider resources and charges may remain.",400));
    await abandonHetznerCleanup({userId,connectionId:id.data,...parsed.data});
    return noStore(apiSuccess({connectionDeleted:true,localCredentialsWiped:true,providerCleanupPerformed:false,canarySlotHeld:true}));
  } catch(error) {
    if(error instanceof InfrastructureConnectionStoreError) {
      if(error.code==="not_found")return noStore(apiError("Infrastructure operation not found.",404));
      if(error.code==="capacity_busy")return noStore(apiError("A cleanup step is still active. Wait for its lease to finish before forgetting access.",409,undefined,{code:"resource_busy"}));
    }
    return noStore(apiError("Local credential removal could not be confirmed. Reopen the same cleanup.",503));
  }
}
