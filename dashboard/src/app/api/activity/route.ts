import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { decodeActivityCursor, getActivitySnapshot } from "@/lib/activity-observability/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function boundedInt(value:string|null,fallback:number,min:number,max:number):number|null {
  if(value===null) return fallback; if(!/^\d+$/.test(value)) return null;
  const parsed=Number(value); return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:null;
}

export async function GET(request:NextRequest){
  const {userId}=await auth();
  if(!userId) return apiError("Unauthorized",401);
  const days=boundedInt(request.nextUrl.searchParams.get("days"),30,1,90);
  const limit=boundedInt(request.nextUrl.searchParams.get("limit"),100,1,200);
  const cursorValue=request.nextUrl.searchParams.get("cursor")??undefined;
  const cursor=decodeActivityCursor(cursorValue);
  if(days===null||limit===null||(cursorValue&&!cursor)) return apiError("Invalid activity query",400);
  try {
    const response=apiSuccess(await getActivitySnapshot(userId,{days,limit,cursor}));
    response.headers.set("Cache-Control","no-store");
    return response;
  } catch {
    return apiError("Failed to fetch activity",500,undefined,undefined,{source:"activity-observability",route:"/api/activity",failureType:"activity_feed_failed"});
  }
}

