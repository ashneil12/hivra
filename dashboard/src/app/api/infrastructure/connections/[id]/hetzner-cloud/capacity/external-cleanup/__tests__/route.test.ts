import { NextRequest } from "next/server";
jest.mock("@clerk/nextjs/server",()=>({auth:jest.fn()}));
jest.mock("@/lib/authenticated-rate-limit",()=>({enforceAuthenticatedRouteRateLimit:jest.fn()}));
jest.mock("@/lib/infrastructure/hetzner-external-cleanup",()=>({
  verifyHetznerExternalCleanup:jest.fn(), HetznerExternalCleanupError:class extends Error { constructor(readonly code:string){super(code);} },
}));
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { verifyHetznerExternalCleanup, HetznerExternalCleanupError } from "@/lib/infrastructure/hetzner-external-cleanup";
import { HETZNER_EXTERNAL_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-external-cleanup-contracts";
import { POST } from "../route";
const id="11111111-1111-4111-8111-111111111111", orderId="22222222-2222-4222-8222-222222222222";
const body={orderId,idempotencyKey:"33333333-3333-4333-8333-333333333333",serverName:"hivra-22222222222242228222",confirmation:HETZNER_EXTERNAL_CLEANUP_CONFIRMATION};
const context={params:Promise.resolve({id})};
const request=(value:unknown=body)=>new NextRequest(`https://hivra.test/api/infrastructure/connections/${id}/hetzner-cloud/capacity/external-cleanup`,{
  method:"POST",headers:{origin:"https://hivra.test","sec-fetch-site":"same-origin","content-type":"application/json"},body:JSON.stringify(value),
});
beforeEach(()=>{jest.clearAllMocks();(auth as unknown as jest.Mock).mockResolvedValue({userId:"owner"});
  (enforceAuthenticatedRouteRateLimit as jest.Mock).mockReturnValue(null);
  (verifyHetznerExternalCleanup as jest.Mock).mockResolvedValue({resolutionId:orderId,resolvedAt:"2026-08-28T19:00:00Z"});});
it("uses authenticated owner and returns no-store typed resolution",async()=>{
  const response=await POST(request(),context);
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(verifyHetznerExternalCleanup).toHaveBeenCalledWith("owner",id,body);
});
it("rejects unauthenticated requests before any scope/provider read",async()=>{
  (auth as unknown as jest.Mock).mockResolvedValue({userId:null});
  expect((await POST(request(),context)).status).toBe(401);expect(verifyHetznerExternalCleanup).not.toHaveBeenCalled();
});
it.each(["origin","sec-fetch-site","content-type"])("rejects missing %s",async header=>{
  const r=request();r.headers.delete(header);
  expect((await POST(r,context)).status).toBe(header==="content-type"?415:403);
  expect(verifyHetznerExternalCleanup).not.toHaveBeenCalled();
});
it.each([{confirmation:"yes"},{orderId:"bad"},{serverId:"42"},{evidence:{serverAbsent:true}},{stateSha256:"a".repeat(64)},{userId:"another-owner"}])("rejects caller evidence/identity expansion %j",async extra=>{
  expect((await POST(request({...body,...extra}),context)).status).toBe(400);
  expect(verifyHetznerExternalCleanup).not.toHaveBeenCalled();
});
it("bounds body and rate, and never reflects raw provider errors",async()=>{
  expect((await POST(request({...body,extra:"x".repeat(5000)}),context)).status).toBe(413);
  (enforceAuthenticatedRouteRateLimit as jest.Mock).mockReturnValueOnce(new Response(null,{status:429}));
  expect((await POST(request(),context)).status).toBe(429);
  expect(verifyHetznerExternalCleanup).not.toHaveBeenCalled();
  (verifyHetznerExternalCleanup as jest.Mock).mockRejectedValue(new Error("provider secret"));
  const response=await POST(request(),context);expect(response.status).toBe(503);expect(await response.text()).not.toContain("provider secret");
  (verifyHetznerExternalCleanup as jest.Mock).mockRejectedValue(new HetznerExternalCleanupError("resources_remain"));
  expect((await POST(request(),context)).status).toBe(409);
});
