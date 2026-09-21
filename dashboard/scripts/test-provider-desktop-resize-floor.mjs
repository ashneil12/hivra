// Actual additive trigger on a minimal journal shape. Full migration
// composition is separately exercised by test-provider-computer-ownership.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite(),agent='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table hivra_agents(id uuid,user_id text,type text,computer_profile text);
    create table hivra_provider_resize_operations(agent_id uuid,user_id text,status text,provider_post_attempted_at timestamptz,quote_snapshot jsonb);`);
  const migration=await readFile(new URL('../supabase/migrations/20260906020000_provider_desktop_resize_floor.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await db.query("insert into hivra_agents values($1,'owner','linux-desktop','ubuntu-desktop')",[agent]);
  const insert=(memory=8,cores=2)=>db.query("insert into hivra_provider_resize_operations values($1,'owner','quoted',null,$2)",[agent,{target:{cores,memoryGb:memory}}]);
  for(const [memory,cores] of [[4,2],[8,1],[null,2],[8,null]])await assert.rejects(insert(memory,cores),e=>e.code==='55006');
  await insert();
  await db.exec("update hivra_provider_resize_operations set status='dispatch_pending'");
  await db.exec("update hivra_provider_resize_operations set status='request_uncertain',provider_post_attempted_at=clock_timestamp()");
  await db.exec("update hivra_provider_resize_operations set status='provider_pending'");
  // Simulate historical quotes admitted before this additive gate. Restore the
  // exact trigger before exercising either claim or first-POST transitions.
  await db.exec('truncate hivra_provider_resize_operations');
  await db.exec('alter table hivra_provider_resize_operations disable trigger hivra_provider_desktop_resize_floor_guard');
  await insert(4);
  await db.exec('alter table hivra_provider_resize_operations enable trigger hivra_provider_desktop_resize_floor_guard');
  await assert.rejects(db.exec("update hivra_provider_resize_operations set status='dispatch_pending'"),e=>e.code==='55006');
  await db.exec('alter table hivra_provider_resize_operations disable trigger hivra_provider_desktop_resize_floor_guard');
  await db.exec("update hivra_provider_resize_operations set status='dispatch_pending'");
  await db.exec('alter table hivra_provider_resize_operations enable trigger hivra_provider_desktop_resize_floor_guard');
  await assert.rejects(db.exec("update hivra_provider_resize_operations set status='request_uncertain',provider_post_attempted_at=clock_timestamp()"),e=>e.code==='55006');
  await db.exec("update hivra_provider_resize_operations set status='cancelled'");
  await db.exec('alter table hivra_provider_resize_operations disable trigger hivra_provider_desktop_resize_floor_guard');
  await db.exec("update hivra_provider_resize_operations set status='request_uncertain',provider_post_attempted_at=clock_timestamp()");
  await db.exec('alter table hivra_provider_resize_operations enable trigger hivra_provider_desktop_resize_floor_guard');
  await db.exec("update hivra_provider_resize_operations set status='provider_pending'");
  await db.exec('truncate hivra_provider_resize_operations');
  await db.exec("update hivra_agents set computer_profile='omarchy'");
  await assert.rejects(insert(),e=>e.code==='55006');
  await db.exec("update hivra_agents set type='codex',computer_profile=null");
  await insert(4); // Other runtime floors are unchanged.
  console.log('PASS desktop resize floor: quote/claim/first-dispatch enforcement, historical cancellation, explicit profile and agent compatibility');
} finally {await db.close();}
