import type { SupabaseClient } from "@supabase/supabase-js";
import { recordCollectorEvents, recordCollectorHeartbeat, recordCollectorRejected, recordCollectorRenewed } from "../collectors";

const A="00000000-0000-4000-8000-000000000001";
function client(result:unknown={error:null}){
  const upsert=jest.fn().mockResolvedValue(result);
  const from=jest.fn(()=>({upsert}));
  return {db:{from} as unknown as SupabaseClient,from,upsert};
}

describe("activity collector state recorders",()=>{
  it("records a heartbeat at the given server time with the presented credential's expiry",async()=>{
    const {db,from,upsert}=client();
    await expect(recordCollectorHeartbeat(db,{agentId:A,userId:"user_1",receivedAt:new Date("2026-09-22T12:00:00Z"),credentialExpiresAt:"2026-09-29T12:00:00.000Z"})).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith("hivra_activity_collectors");
    expect(upsert).toHaveBeenCalledWith({agent_id:A,user_id:"user_1",last_heartbeat_at:"2026-09-22T12:00:00.000Z",credential_expires_at:"2026-09-29T12:00:00.000Z",updated_at:"2026-09-22T12:00:00.000Z"},{onConflict:"agent_id"});
  });

  it("writes only the columns each signal owns",async()=>{
    const {db,upsert}=client();
    await recordCollectorEvents(db,{agentId:A,userId:"user_1",receivedAt:"2026-09-22T12:00:00Z"});
    expect(upsert.mock.calls[0][0]).toEqual({agent_id:A,user_id:"user_1",last_event_at:"2026-09-22T12:00:00.000Z",updated_at:"2026-09-22T12:00:00.000Z"});
    await recordCollectorRejected(db,{agentId:A,userId:"user_1",reason:"expired",rejectedAt:new Date("2026-09-22T12:01:00Z")});
    expect(upsert.mock.calls[1][0]).toEqual({agent_id:A,user_id:"user_1",last_rejected_at:"2026-09-22T12:01:00.000Z",last_rejected_reason:"expired",updated_at:"2026-09-22T12:01:00.000Z"});
    await recordCollectorRenewed(db,{agentId:A,userId:"user_1",expiresAt:"2026-09-29T12:00:00.000Z",issuedAt:new Date("2026-09-22T12:00:00Z")});
    expect(upsert.mock.calls[2]).toEqual([{agent_id:A,user_id:"user_1",issued_at:"2026-09-22T12:00:00.000Z",credential_expires_at:"2026-09-29T12:00:00.000Z",issue_reason:"renew",updated_at:"2026-09-22T12:00:00.000Z"},{onConflict:"agent_id"}]);
    for(const call of upsert.mock.calls) expect(call[1]).toEqual({onConflict:"agent_id"});
  });

  it("is best effort: database errors, throws and bad timestamps return false",async()=>{
    await expect(recordCollectorHeartbeat(client({error:{message:"denied"}}).db,{agentId:A,userId:"u",receivedAt:new Date(),credentialExpiresAt:new Date().toISOString()})).resolves.toBe(false);
    const throwing={from:()=>{throw new Error("network");}} as unknown as SupabaseClient;
    await expect(recordCollectorEvents(throwing,{agentId:A,userId:"u",receivedAt:new Date()})).resolves.toBe(false);
    const {db,upsert}=client();
    await expect(recordCollectorHeartbeat(db,{agentId:A,userId:"u",receivedAt:new Date(),credentialExpiresAt:"not a date"})).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
