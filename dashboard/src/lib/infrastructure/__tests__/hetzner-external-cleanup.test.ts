jest.mock("@/lib/supabase",()=>({supabaseAdmin:null}));
jest.mock("../hetzner-cloud-store",()=>({loadHetznerCloudConnectionSecret:jest.fn()}));
import { verifyHetznerExternalCleanup } from "../hetzner-external-cleanup";
import { HETZNER_EXTERNAL_CLEANUP_CONFIRMATION } from "../hetzner-external-cleanup-contracts";
const connectionId="11111111-1111-4111-8111-111111111111", orderId="22222222-2222-4222-8222-222222222222";
const idempotencyKey="33333333-3333-4333-8333-333333333333";
const request={orderId,idempotencyKey,serverName:"hivra-22222222222242228222",confirmation:HETZNER_EXTERNAL_CLEANUP_CONFIRMATION};
const original={orderId,connectionId,revision:7,serverId:"42",sshKeyId:"77",serverName:request.serverName,stateSha256:"a".repeat(64),resolutionId:null,eligible:true};
function fixture() {
  const verify=jest.fn().mockResolvedValue(true);
  return {verify,loadScope:jest.fn().mockResolvedValue(original),loadSecret:jest.fn().mockResolvedValue({revision:7,connection:{status:"ready"},apiToken:"fixture-only"}),
    reader:jest.fn(()=>({verify})),resolve:jest.fn().mockResolvedValue({resolutionId:idempotencyKey,resolvedAt:"2026-08-28T19:00:00Z"}),
    now:()=>new Date("2026-08-28T19:00:00Z"),monotonicNow:jest.fn(()=>0)};
}
it("uses server-generated scope and original bound credentials, then stores only sanitized proof", async()=>{
  const deps=fixture(); await verifyHetznerExternalCleanup("owner",connectionId,request,deps);
  expect(deps.loadSecret).toHaveBeenCalledWith("owner",connectionId,{requireBoundToken:true});
  expect(deps.verify).toHaveBeenCalledWith(42,77);
  expect(deps.resolve).toHaveBeenCalledWith({userId:"owner",connectionId,request},original,{
    version:1,serverId:"42",sshKeyId:"77",observedAt:"2026-08-28T19:00:00.000Z",serverAbsent:true,sshKeyAbsent:true,projectServers:0,projectPrimaryIps:0,
  });
  expect(JSON.stringify(deps.resolve.mock.calls)).not.toContain("fixture-only");
});
it.each([{orderId:idempotencyKey},{connectionId:idempotencyKey},{serverName:"different"},{eligible:false},{serverId:null},{sshKeyId:null}])("rejects changed or ineligible scope %j before credentials",async change=>{
  const deps=fixture();deps.loadScope.mockResolvedValue({...original,...change});
  await expect(verifyHetznerExternalCleanup("owner",connectionId,request,deps)).rejects.toThrow();
  expect(deps.loadSecret).not.toHaveBeenCalled();expect(deps.resolve).not.toHaveBeenCalled();
});
it("replays an already resolved request without opening credentials or reading provider",async()=>{
  const deps=fixture();deps.loadScope.mockResolvedValue({...original,eligible:false,resolutionId:idempotencyKey});
  await verifyHetznerExternalCleanup("owner",connectionId,request,deps);
  expect(deps.resolve).toHaveBeenCalledWith(expect.anything(),expect.anything(),null);
  expect(deps.loadSecret).not.toHaveBeenCalled();expect(deps.reader).not.toHaveBeenCalled();
});
it("rejects rotated credentials, retained resources, time expiry and unavailable reads",async()=>{
  let deps=fixture();deps.loadSecret.mockResolvedValue({revision:8,connection:{status:"ready"},apiToken:"fixture"});
  await expect(verifyHetznerExternalCleanup("owner",connectionId,request,deps)).rejects.toMatchObject({code:"connection_changed"});
  deps=fixture();deps.verify.mockResolvedValue(false);
  await expect(verifyHetznerExternalCleanup("owner",connectionId,request,deps)).rejects.toMatchObject({code:"resources_remain"});
  expect(deps.resolve).not.toHaveBeenCalled();
  deps=fixture();deps.monotonicNow.mockReturnValueOnce(0).mockReturnValueOnce(25_001);
  await expect(verifyHetznerExternalCleanup("owner",connectionId,request,deps)).rejects.toMatchObject({code:"evidence_expired"});
  expect(deps.resolve).not.toHaveBeenCalled();
  deps=fixture();deps.verify.mockRejectedValue(new Error("secret"));
  await expect(verifyHetznerExternalCleanup("owner",connectionId,request,deps)).rejects.toMatchObject({code:"verification_unavailable"});
  expect(deps.resolve).not.toHaveBeenCalled();
});
