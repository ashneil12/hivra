import { NextRequest } from "next/server";
const mockList = jest.fn(); const mockPreview = jest.fn(); const mockAdvance = jest.fn(); const mockLimit = jest.fn();
jest.mock("@clerk/nextjs/server",()=>({auth:jest.fn()}));
jest.mock("@/lib/authenticated-rate-limit",()=>({enforceAuthenticatedRouteRateLimit:(...args:unknown[])=>mockLimit(...args)}));
jest.mock("@/lib/infrastructure/hetzner-cleanup",()=>({
  listHetznerCleanup:(...args:unknown[])=>mockList(...args),previewHetznerCleanup:(...args:unknown[])=>mockPreview(...args),
  advanceHetznerCleanup:(...args:unknown[])=>mockAdvance(...args),
}));
import { auth } from "@clerk/nextjs/server";
import { HetznerCleanupError } from "@/lib/infrastructure/hetzner-cleanup-policy";
import { HETZNER_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-cleanup-contracts";
import { GET, POST } from "../route";
const id="11111111-1111-4111-8111-111111111111";
const orderId="22222222-2222-4222-8222-222222222222";
const context={params:Promise.resolve({id})};
const url=`https://hivra.test/api/infrastructure/connections/${id}/hetzner-cloud/capacity/cleanup`;
const body={orderId,idempotencyKey:"33333333-3333-4333-8333-333333333333",fingerprint:"a".repeat(64),
  serverName:"hivra-22222222222242228222",confirmation:HETZNER_CLEANUP_CONFIRMATION};
const request=(value:unknown=body)=>new NextRequest(url,{method:"POST",headers:{
  origin:"https://hivra.test","sec-fetch-site":"same-origin","content-type":"application/json",
},body:JSON.stringify(value)});
beforeEach(()=>{jest.clearAllMocks();(auth as unknown as jest.Mock).mockResolvedValue({userId:"owner"});mockLimit.mockReturnValue(null);
  mockList.mockResolvedValue({orders:[]});mockPreview.mockResolvedValue({orderId});mockAdvance.mockResolvedValue({status:"cleaning"});});
it("keeps list and preview reads owner scoped and non-mutating",async()=>{
  expect((await GET(new NextRequest(url),context)).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith("owner",id);
  const response=await GET(new NextRequest(url+"?orderId="+orderId),context);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mockPreview).toHaveBeenCalledWith("owner",id,orderId);expect(mockAdvance).not.toHaveBeenCalled();
});
it("requires authentication for reads and mutations",async()=>{
  (auth as unknown as jest.Mock).mockResolvedValue({userId:null});
  expect((await GET(new NextRequest(url),context)).status).toBe(401);
  expect((await POST(request(),context)).status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();expect(mockAdvance).not.toHaveBeenCalled();
});
it.each(["origin","sec-fetch-site","content-type"])("rejects missing %s before mutation",async header=>{
  const r=request();r.headers.delete(header);
  expect((await POST(r,context)).status).toBe(header==="content-type"?415:403);
  expect(mockAdvance).not.toHaveBeenCalled();
});
it("requires exact confirmation, strict bounded JSON and UUIDs",async()=>{
  for(const value of [{...body,confirmation:"yes"},{...body,orderId:"wrong"},{...body,apiToken:"must-not-accept"}]) {
    expect((await POST(request(value),context)).status).toBe(400);
  }
  expect((await POST(request({...body,padding:"x".repeat(5000)}),context)).status).toBe(413);
  expect(mockAdvance).not.toHaveBeenCalled();
});
it("returns a partial checkpoint as 202 and terminal cleanup only as 200",async()=>{
  expect((await POST(request(),context)).status).toBe(202);
  expect(mockAdvance).toHaveBeenCalledWith("owner",id,body);
  mockAdvance.mockResolvedValue({status:"deleted"});
  expect((await POST(request(),context)).status).toBe(200);
});
it("sanitizes provider errors and exposes actionable stable refusal codes",async()=>{
  mockAdvance.mockRejectedValue(new Error("provider secret must not echo"));
  let r=await POST(request(),context);expect(r.status).toBe(503);expect(await r.text()).not.toContain("provider secret");
  mockAdvance.mockRejectedValue(new HetznerCleanupError("resource_changed"));
  r=await POST(request(),context);expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:"resource_changed"});
});
it("stops at the per-owner rate limit",async()=>{
  mockLimit.mockReturnValue(new Response(null,{status:429}));
  expect((await POST(request(),context)).status).toBe(429);expect(mockAdvance).not.toHaveBeenCalled();
});
