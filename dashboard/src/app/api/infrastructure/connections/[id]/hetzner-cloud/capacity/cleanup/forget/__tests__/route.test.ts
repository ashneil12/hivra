import { NextRequest } from "next/server";
const mockForget=jest.fn();const mockLimit=jest.fn();
jest.mock("@clerk/nextjs/server",()=>({auth:jest.fn()}));
jest.mock("@/lib/authenticated-rate-limit",()=>({enforceAuthenticatedRouteRateLimit:(...args:unknown[])=>mockLimit(...args)}));
jest.mock("@/lib/infrastructure/hetzner-cloud-store",()=>({abandonHetznerCleanup:(...args:unknown[])=>mockForget(...args)}));
import { auth } from "@clerk/nextjs/server";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION } from "@/lib/infrastructure/contracts";
import { POST } from "../route";
const id="11111111-1111-4111-8111-111111111111";
const context={params:Promise.resolve({id})};
const body={orderId:"22222222-2222-4222-8222-222222222222",idempotencyKey:"33333333-3333-4333-8333-333333333333",
  fingerprint:"a".repeat(64),confirmation:HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION};
const request=(value:unknown=body)=>new NextRequest(`https://hivra.test/api/infrastructure/connections/${id}/hetzner-cloud/capacity/cleanup/forget`,{
  method:"POST",headers:{origin:"https://hivra.test","sec-fetch-site":"same-origin","content-type":"application/json"},body:JSON.stringify(value),
});
beforeEach(()=>{jest.clearAllMocks();(auth as unknown as jest.Mock).mockResolvedValue({userId:"owner"});mockLimit.mockReturnValue(null);mockForget.mockResolvedValue(undefined);});
it("only revokes local access and explicitly retains the unresolved provider claim",async()=>{
  const response=await POST(request(),context);expect(response.status).toBe(200);
  expect(mockForget).toHaveBeenCalledWith({...body,userId:"owner",connectionId:id});
  expect(await response.json()).toMatchObject({success:true,data:{connectionDeleted:true,localCredentialsWiped:true,providerCleanupPerformed:false,canarySlotHeld:true}});
});
it("requires authentication, same origin and exact explicit confirmation",async()=>{
  (auth as unknown as jest.Mock).mockResolvedValueOnce({userId:null});expect((await POST(request(),context)).status).toBe(401);
  const foreign=request();foreign.headers.set("origin","https://foreign.test");expect((await POST(foreign,context)).status).toBe(403);
  expect((await POST(request({...body,confirmation:"yes"}),context)).status).toBe(400);
  expect((await POST(request({...body,padding:"x".repeat(5000)}),context)).status).toBe(413);
  expect(mockForget).not.toHaveBeenCalled();
});
it("cannot bypass an active provider lease and never echoes database errors",async()=>{
  mockForget.mockRejectedValueOnce(new InfrastructureConnectionStoreError("capacity_busy"));
  expect((await POST(request(),context)).status).toBe(409);
  mockForget.mockRejectedValueOnce(new Error("private database evidence"));
  const response=await POST(request(),context);expect(response.status).toBe(503);expect(await response.text()).not.toContain("private database evidence");
});
