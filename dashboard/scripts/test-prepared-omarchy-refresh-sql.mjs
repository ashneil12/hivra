import { test as nodeTest, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
let db;
const op="018f6d3c-1d91-7c65-9d86-37fc915b8377",id="44444444-4444-4444-8444-444444444444";
const release={release:"v4.0.6",releaseCommit:"a".repeat(40),isoFilename:"omarchy-4.0.6.iso",isoUrl:"https://iso.omarchy.org/omarchy-4.0.6.iso",isoSha256:"b".repeat(64)};
const slot={host:"node-b",node:"node-b",vmid:2099,ip:"10.240.20.99",claim:"019d13b0-4f19-7f55-9a22-83e72232d8c1"};
const row={id,user_id:"owner",type:"linux-desktop",computer_profile:"omarchy",computer_substrate:"proxmox-kvm",deployment_mode:"hivra-managed",proxmox_host:slot.host,vmid:slot.vmid,ip:slot.ip,status:"provisioning",desired_state:"running",cpu:4,ram:8,managed_provisioner_channel:"canary",operation_id:op,allocation_operation_id:op,operation_kind:"provision",operation_started_at:"2026-11-03T01:00:00Z",operation_payload:{stage:"prepared_omarchy_refresh",refreshId:op},infrastructure_binding_token_hash:"c".repeat(64),infrastructure_binding_token_enforced:false};
const receipt={version:1,operationId:op,computerId:id,vmid:slot.vmid,bindingTag:"hivra-bind-"+"c".repeat(32),requestedRelease:release,guestUpdaterStopped:true,state:"complete",observed:{packageVersion:"4.0.6-1",osVersion:"4.0.6",kernelRelease:"7.2.15-1-omarchy",selectedKernel:"7.2.15-1-omarchy",bootIdBefore:"33333333-3333-4333-8333-333333333333",bootIdAfter:"55555555-5555-4555-8555-555555555555",desktopReady:true,migrationsComplete:true,observedAt:"2026-11-03T01:10:00Z"}};
async function scalar(sql,args=[]){const result=await db.query(sql,args);return Object.values(result.rows[0])[0];}
async function reserve(value=row,limit=4,requested=release){return scalar("select public.reserve_hivra_prepared_omarchy($1::jsonb,$2,$3::jsonb,$4::jsonb)",[JSON.stringify(value),limit,JSON.stringify(requested),JSON.stringify(slot)]);}
async function dispatch(){expect(await scalar("select public.bind_hivra_prepared_omarchy('owner',$1)",[op])).toBe(true);expect(await scalar("select public.dispatch_hivra_prepared_omarchy('owner',$1)",[op])).toBe(true);}
async function finish(value=receipt){return scalar("select public.complete_hivra_prepared_omarchy('owner',$1,$2::jsonb)",[op,JSON.stringify(value)]);}
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.hivra_agents(id uuid primary key default gen_random_uuid(),user_id text,type text,computer_profile text,computer_substrate text,deployment_mode text,proxmox_host text,vmid integer,ip text,chat_url text,status text,desired_state text,cpu integer,ram integer,provisioned_at timestamptz,error text,infrastructure_connection_id uuid,deployment_target_id uuid,infrastructure_connection_revision integer,infrastructure_binding_token_hash text default repeat('c',64),infrastructure_binding_token_enforced boolean default false,managed_provisioner_channel text,allocation_operation_id uuid,operation_id uuid,operation_kind text,operation_started_at timestamptz,operation_payload jsonb);
 create unique index hivra_agents_active_proxmox_host_vmid_idx on public.hivra_agents(proxmox_host,vmid) where vmid is not null and status<>'deleted';
 create function public.lock_hivra_owner_agent_slots(text) returns void language sql as $$select pg_advisory_xact_lock(hashtextextended($1,0))$$;
 create function public.hivra_owner_agent_slot_count(text) returns integer language sql as $$select count(*)::integer from public.hivra_agents where user_id=$1 and status<>'deleted'$$;`);
 for(const [file,anchor] of [["20260925100000_hivra_agent_slot_limit.sql","create or replace function public.insert_hivra_managed_agent("],["20260905150000_hivra_desktop_prepare_lifecycle.sql","create function public.hivra_desktop_prepare_authority("]]){
  const source=readFileSync(path.join(process.cwd(),"supabase/migrations",file),"utf8"),a=source.indexOf(anchor);
  await db.exec(source.slice(a,source.indexOf("\n$$;",a)+4)).catch(error=>{console.error("FUNCTION",file,error.message,error.position,error.where);throw error;});
 }
 const compatibility=readFileSync(path.join(process.cwd(),"supabase/migrations/20260826130000_hivra_agent_authority_operations.sql"),"utf8");
 const compatibilityStart=compatibility.indexOf("create or replace function public.normalize_hivra_agent_operation_compatibility()");
 const compatibilityEnd=compatibility.indexOf("\n-- Validate and serialize a portable binding",compatibilityStart);
 await db.exec(compatibility.slice(compatibilityStart,compatibilityEnd));
 await db.exec(readFileSync(path.join(process.cwd(),"supabase/migrations/20261103010000_prepared_omarchy_refresh.sql"),"utf8")).catch(error=>{console.error("MIGRATION",error.message,error.position,error.where,error.internalQuery);throw error;});
 await db.exec(readFileSync(path.join(process.cwd(),"supabase/migrations/20261111170000_prepared_omarchy_x86_artifact.sql"),"utf8")).catch(error=>{console.error("ARTIFACT_MIGRATION",error.message,error.position,error.where,error.internalQuery);throw error;});
});
afterEach(async()=>{await db.close();});
test("reserves one pending owner and refuses another customer's same-slot race",async()=>{
 const first=await reserve();expect(first.status).toBe("inserted");expect(first.row?.status).toBe("provisioning");
 expect(await scalar("select phase from public.hivra_prepared_omarchy_refreshes where id=$1",[op])).toBe("reserved");
 const other=await reserve({...row,id:"66666666-6666-4666-8666-666666666666",user_id:"other",operation_id:"77777777-7777-4777-8777-777777777777",allocation_operation_id:"77777777-7777-4777-8777-777777777777",operation_payload:{stage:"prepared_omarchy_refresh",refreshId:"77777777-7777-4777-8777-777777777777"}});
 expect(other.status).toBe("prepared_slot_claimed");expect(await scalar("select count(*) from public.hivra_agents")).toBe(1);
});
test("does not allocate a reservation when the plan has no slot",async()=>{
 expect((await reserve(row,0)).status).toBe("plan_agent_limit");expect(await scalar("select count(*) from public.hivra_agents")).toBe(0);
 expect(await scalar("select count(*) from public.hivra_prepared_omarchy_refreshes")).toBe(0);
});
test("replays the original reservation without another operation",async()=>{
 await reserve();expect((await reserve()).row?.operation_id).toBe(op);expect(await scalar("select count(*) from public.hivra_prepared_omarchy_refreshes")).toBe(1);
});
test("guards owner identity, ordinary lifecycle admission and ready state during refresh",async()=>{
 await reserve();await expect(db.exec(`update public.hivra_agents set user_id='other' where id='${id}'`)).rejects.toThrow(/exact terminal/);
 await expect(db.exec(`update public.hivra_agents set status='running',operation_id=null,operation_kind=null,operation_payload=null where id='${id}'`)).rejects.toThrow(/exact terminal/);
 expect(await scalar("select public.dispatch_hivra_prepared_omarchy('other',$1)",[op])).toBe(false);
});
test("admits only the exact requested release after reboot, kernel, migration and desktop proof",async()=>{
 await reserve();await dispatch();
 for(const observed of [{...receipt.observed,osVersion:"4.0.2",packageVersion:"4.0.2-1"},{...receipt.observed,bootIdAfter:receipt.observed.bootIdBefore},{...receipt.observed,kernelRelease:"old-kernel"},{...receipt.observed,migrationsComplete:false},{...receipt.observed,desktopReady:false}])expect(await finish({...receipt,observed})).toBe(false);
 expect(await scalar("select status from public.hivra_agents where id=$1",[id])).toBe("provisioning");
 expect(await finish()).toBe(true);expect(await finish()).toBe(true);expect(await scalar("select status from public.hivra_agents where id=$1",[id])).toBe("running");
 expect(await scalar("select operation_id from public.hivra_agents where id=$1",[id])).toBeNull();
 const stored=await scalar("select omarchy_release_receipt from public.hivra_agents where id=$1",[id]);
 expect(stored.observed.osVersion).toBe("4.0.6");expect(stored.observed).not.toHaveProperty("bootIdBefore");
});
test("quarantines failed work and cancels only after updater-stop and binding-release evidence",async()=>{
 await reserve();await dispatch();const {observed:_,...base}=receipt;void _;
 expect(await finish({...base,state:"failed",errorCode:"native_update_failed"})).toBe(true);
 expect(await scalar("select status from public.hivra_agents where id=$1",[id])).toBe("error");expect(await scalar("select operation_id from public.hivra_agents where id=$1",[id])).toBe(op);
 expect(await scalar("select public.cancel_hivra_prepared_omarchy('owner',$1)",[op])).toBe(true);
 expect(await scalar("select public.bind_hivra_prepared_omarchy('owner',$1)",[op])).toBe(false);
 expect(await finish({...base,state:"cancelled",bindingReleased:false})).toBe(false);expect(await finish({...base,state:"cancelled",bindingReleased:true})).toBe(true);
 expect(await scalar("select status from public.hivra_agents where id=$1",[id])).toBe("deleted");
});
test("blocks an older deployment's ready insertion without a durable latest-version reservation",async()=>{
 const legacy={...row,status:"running",operation_id:null,operation_kind:null,operation_started_at:null,operation_payload:null};
 await expect(scalar("select public.insert_hivra_managed_agent($1::jsonb,4)",[JSON.stringify(legacy)])).rejects.toThrow(/requires a reserved/);
 expect(await scalar("select count(*) from public.hivra_agents")).toBe(0);
});
test("preserves legacy compatibility completion for other profiles and ordinary Omarchy operations",async()=>{
 for(const [i,profile] of [null,"ubuntu-desktop","omarchy"].entries()){
  const legacyId=`88888888-8888-4888-8888-88888888888${i}`;
  await db.query("insert into public.hivra_agents(id,user_id,type,computer_profile,deployment_mode,status,desired_state) values($1,'legacy','linux-desktop',$2,'hivra-managed','deleted','running')",[legacyId,profile]);
  await db.query("update public.hivra_agents set status='stopped' where id=$1",[legacyId]);
  await db.query("update public.hivra_agents set status='provisioning' where id=$1",[legacyId]);
  expect(await scalar("select operation_kind from public.hivra_agents where id=$1",[legacyId])).toBe("start");
  await db.query("update public.hivra_agents set status='error' where id=$1",[legacyId]);
  expect(await scalar("select operation_id from public.hivra_agents where id=$1",[legacyId])).toBeNull();
 }
});

const x86Release={...release,release:"v4.5.0",isoFilename:"omarchy-4.5.0-x86.iso",isoUrl:"https://iso.omarchy.org/omarchy-4.5.0-x86.iso"};
test("reserves and admits the exact architecture-qualified x86 release",async()=>{
 expect((await reserve(row,4,x86Release)).status).toBe("inserted");await dispatch();
 expect(await finish({...receipt,requestedRelease:x86Release,observed:{...receipt.observed,packageVersion:"4.5.0-1",osVersion:"4.5.0"}})).toBe(true);
});
for(const filename of ["omarchy-4.5.0.iso","omarchy-4.5.0-arm.iso","omarchy-4.5.1-x86.iso"]){
 test("refuses mismatched x86 artifact "+filename,async()=>{
  expect((await reserve(row,4,{...x86Release,isoFilename:filename,isoUrl:"https://iso.omarchy.org/"+filename})).status).toBe("invalid_request");
  expect(await scalar("select count(*) from public.hivra_agents")).toBe(0);
 });
}
test("refuses malformed release before interpreting its numeric components",async()=>{
 expect((await reserve(row,4,{...x86Release,release:"v4.bad.0"})).status).toBe("invalid_request");
});
test("reapplies its exact definition but refuses an externally changed reservation",async()=>{
 const migration=readFileSync(path.join(process.cwd(),"supabase/migrations/20261111170000_prepared_omarchy_x86_artifact.sql"),"utf8");
 await db.exec(migration);
 await db.exec(`create or replace function public.reserve_hivra_prepared_omarchy(p_row jsonb,p_agent_limit integer,p_release jsonb,p_slot jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$begin return '{}'::jsonb;end;$$;`);
 await expect(db.exec(migration)).rejects.toThrow(/definition changed/);
});
test("keeps reservation execution restricted to the service role",async()=>{
 for(const role of ['anon','authenticated'])expect(await scalar("select has_function_privilege($1,'public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb)','EXECUTE')",[role])).toBe(false);
 expect(await scalar("select has_function_privilege('service_role','public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb)','EXECUTE')")).toBe(true);
});
