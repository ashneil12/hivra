import type { SupabaseClient } from "@supabase/supabase-js";
import { parseActivityCollectorMarker, recordCollectorEvents, recordCollectorHeartbeat, recordCollectorInstallResult, recordCollectorRejected, recordCollectorRenewed } from "../collectors";

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

  it("records the latest reporter install outcome, clearing an earlier failure reason on success",async()=>{
    const {db,upsert}=client();
    await expect(recordCollectorInstallResult(db,{agentId:A,userId:"user_1",status:"failed",reason:"install_failed",at:new Date("2026-09-22T12:02:00Z")})).resolves.toBe(true);
    expect(upsert.mock.calls[0]).toEqual([{agent_id:A,user_id:"user_1",last_install_status:"failed",last_install_reason:"install_failed",last_install_at:"2026-09-22T12:02:00.000Z",updated_at:"2026-09-22T12:02:00.000Z"},{onConflict:"agent_id"}]);
    await expect(recordCollectorInstallResult(db,{agentId:A,userId:"user_1",status:"installed",at:new Date("2026-09-22T12:03:00Z")})).resolves.toBe(true);
    expect(upsert.mock.calls[1]).toEqual([{agent_id:A,user_id:"user_1",last_install_status:"installed",last_install_reason:null,last_install_at:"2026-09-22T12:03:00.000Z",updated_at:"2026-09-22T12:03:00.000Z"},{onConflict:"agent_id"}]);
    // Never an issuance, heartbeat or rejection column: the install marker proves none of those.
    for(const [row] of upsert.mock.calls) expect(Object.keys(row).sort()).toEqual(["agent_id","last_install_at","last_install_reason","last_install_status","updated_at","user_id"]);
  });

  it.each([
    ["a failure without a reason",{status:"failed"}],
    ["a reason outside the closed enum",{status:"failed",reason:"Install Failed"}],
    ["a reason carrying free text",{status:"failed",reason:"install_failed; token=hvra_otlp_v1.a.b"}],
    ["an over-long reason",{status:"failed",reason:"a".repeat(41)}],
    ["a reason on a successful install",{status:"installed",reason:"timeout"}],
    ["an unknown status",{status:"partial",reason:"timeout"}],
    ["an invalid timestamp",{status:"installed",at:new Date("not a date")}],
  ])("writes nothing for %s",async(_case,fields)=>{
    const {db,upsert}=client();
    await expect(recordCollectorInstallResult(db,{agentId:A,userId:"u",...fields} as never)).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is best effort: database errors, throws and bad timestamps return false",async()=>{
    await expect(recordCollectorHeartbeat(client({error:{message:"denied"}}).db,{agentId:A,userId:"u",receivedAt:new Date(),credentialExpiresAt:new Date().toISOString()})).resolves.toBe(false);
    const throwing={from:()=>{throw new Error("network");}} as unknown as SupabaseClient;
    await expect(recordCollectorEvents(throwing,{agentId:A,userId:"u",receivedAt:new Date()})).resolves.toBe(false);
    await expect(recordCollectorInstallResult(throwing,{agentId:A,userId:"u",status:"installed"})).resolves.toBe(false);
    await expect(recordCollectorInstallResult(client({error:{message:"denied"}}).db,{agentId:A,userId:"u",status:"failed",reason:"timeout"})).resolves.toBe(false);
    const {db,upsert}=client();
    await expect(recordCollectorHeartbeat(db,{agentId:A,userId:"u",receivedAt:new Date(),credentialExpiresAt:"not a date"})).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("activity collector install marker",()=>{
  it("takes the last closed-enum marker line and ignores anything else",()=>{
    expect(parseActivityCollectorMarker(["HIVRA_ACTIVITY_CREDENTIAL_STAGED","HIVRA_GUEST_RUNTIME_UPDATED vmid=1090"])).toBeNull();
    expect(parseActivityCollectorMarker(["HIVRA_ACTIVITY_COLLECTOR status=failed reason=timeout","  HIVRA_ACTIVITY_COLLECTOR status=installed  "])).toEqual({status:"installed"});
    expect(parseActivityCollectorMarker(["HIVRA_ACTIVITY_COLLECTOR status=installed","HIVRA_ACTIVITY_COLLECTOR status=failed reason=install_failed"])).toEqual({status:"failed",reason:"install_failed"});
    for(const line of ["HIVRA_ACTIVITY_COLLECTOR status=failed reason=Bad-Reason","HIVRA_ACTIVITY_COLLECTOR status=failed","prefix HIVRA_ACTIVITY_COLLECTOR status=installed","HIVRA_ACTIVITY_COLLECTOR status=installed extra"]){
      expect(parseActivityCollectorMarker([line])).toBeNull();
    }
  });
});
