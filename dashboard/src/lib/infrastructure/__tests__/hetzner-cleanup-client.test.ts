import { advanceCleanup, listCleanupOrders, HetznerCleanupViewSchema } from "../hetzner-cleanup-client";
import { HETZNER_CLEANUP_CONFIRMATION } from "../hetzner-cleanup-contracts";
const id="11111111-1111-4111-8111-111111111111";
const body={orderId:"22222222-2222-4222-8222-222222222222",idempotencyKey:"33333333-3333-4333-8333-333333333333",
  fingerprint:"a".repeat(64),serverName:"hivra-22222222222242228222",confirmation:HETZNER_CLEANUP_CONFIRMATION};
beforeEach(()=>{global.fetch=jest.fn();});
it("requires API success as well as HTTP success",async()=>{
  (fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({success:false,error:"unsafe reflected secret"}),{status:200}));
  await expect(advanceCleanup(id,body)).rejects.toThrow("could not be confirmed");
});
it("rejects terminal success without all resource absence evidence",()=>{
  expect(HetznerCleanupViewSchema.safeParse({orderId:body.orderId,connectionId:id,serverName:body.serverName,
    status:"deleted",eligible:true,fingerprint:body.fingerprint,resources:{server:"42",ipv4:"88",ipv6:"89",sshKey:"77"},cleanup:null}).success).toBe(false);
});
it("binds requests to the validated same-origin connection endpoint",async()=>{
  (fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({success:true,data:{orders:[]}}),{status:200}));
  expect(await listCleanupOrders(id)).toEqual({orders:[]});
  expect(fetch).toHaveBeenCalledWith(`/api/infrastructure/connections/${id}/hetzner-cloud/capacity/cleanup`,
    expect.objectContaining({credentials:"same-origin",cache:"no-store",redirect:"error"}));
});
it("requires exactly the expected five absence checks before accepting first-boot completion",()=>{
  const absence={server:true,ipv4:true,ipv6:true,sshKey:true};
  const complete={orderId:body.orderId,connectionId:id,serverName:body.serverName,status:"deleted",eligible:true,
    fingerprint:body.fingerprint,resources:{server:"42",ipv4:"88",ipv6:"89",sshKey:"77",firewall:"91"},
    cleanup:{idempotencyKey:body.idempotencyKey,fingerprint:body.fingerprint,absence,error:null,
      startedAt:"2026-08-27T16:00:00Z",observedAt:"2026-08-27T16:01:00Z",finishedAt:"2026-08-27T16:01:00Z"}};
  expect(HetznerCleanupViewSchema.safeParse(complete).success).toBe(false);
  expect(HetznerCleanupViewSchema.safeParse({...complete,cleanup:{...complete.cleanup,absence:{...absence,firewall:false}}}).success).toBe(false);
  expect(HetznerCleanupViewSchema.safeParse({...complete,cleanup:{...complete.cleanup,absence:{...absence,firewall:true}}}).success).toBe(true);
  expect(HetznerCleanupViewSchema.safeParse({...complete,status:"created_off",cleanup:null,observedAbsence:absence}).success).toBe(false);
  const legacy={server:"42",ipv4:"88",ipv6:"89",sshKey:"77"};
  expect(HetznerCleanupViewSchema.safeParse({...complete,resources:legacy}).success).toBe(true);
  expect(HetznerCleanupViewSchema.safeParse({...complete,resources:legacy,cleanup:{...complete.cleanup,absence:{...absence,firewall:true}}}).success).toBe(false);
});
