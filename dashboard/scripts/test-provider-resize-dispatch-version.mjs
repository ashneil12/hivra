// Compatibility entry-point regression, not full historical-schema acceptance.
// Existing journal/lease guards are exercised by test-provider-resize-absence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const read = name => readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const original=await read('20260904130000_hivra_provider_resize_operations.sql');
const readiness=process.argv.includes('--readiness');
const migration=await read(readiness ? '20260905091000_hivra_provider_resize_readiness_dispatch.sql'
  : '20260905073000_hivra_provider_resize_dispatch_version.sql');
const legacy=readiness ? 'begin_hivra_provider_resize_dispatch_v2' : 'begin_hivra_provider_resize_dispatch';
const current=readiness ? 'begin_hivra_provider_resize_dispatch_v3' : legacy+'_v2';
const body=(sql,name) => {
  const start=sql.indexOf('create function public.'+name+'(');
  assert(start>=0);
  const from=sql.indexOf('as $$',start),end=sql.indexOf('\n$$;',from);
  assert(from>start && end>from);
  return sql.slice(from,end);
};
assert.equal(body(migration,current),
  body(original,'begin_hivra_provider_resize_dispatch'));
const db=new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table hivra_agents(id uuid,user_id text,operation_id uuid,operation_kind text,status text,desired_state text);
    create table hivra_provider_resize_operations(operation_id uuid,agent_id uuid,user_id text,capacity_order_id uuid,
      status text,provider_server_id text,source_shape_fingerprint_sha256 text,provider_post_attempted_at timestamptz,
      dispatch_not_after timestamptz,updated_at timestamptz);
    create table infrastructure_capacity_orders(id uuid,user_id text,provider_resource_id text,
      current_server_shape_fingerprint_sha256 text,quote_fingerprint_sha256 text);`);
  await db.exec(migration);
  const agent='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',op='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',order='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await db.query("insert into hivra_agents values($1,'owner',$2,'resize','provisioning','stopped')",[agent,op]);
  await db.query("insert into infrastructure_capacity_orders values($1,'owner','42',null,'shape')",[order]);
  await db.query("insert into hivra_provider_resize_operations values($1,$2,'owner',$3,'dispatch_pending','42','shape',null,clock_timestamp()+interval '45 seconds',clock_timestamp())",[op,agent,order]);
  const call=async(name,owner='owner') => (await db.query(`select ${name}($1,$2,$3) as result`,[owner,agent,op])).rows[0].result;
  assert.equal(await call(legacy),'rejected');
  assert.equal((await db.query('select provider_post_attempted_at from hivra_provider_resize_operations')).rows[0].provider_post_attempted_at,null);
  const allowed=async(role,name)=>(await db.query("select has_function_privilege($1,$2,'execute') as allowed",[role,name+'(text,uuid,uuid)'])).rows[0].allowed;
  assert.equal(await allowed('service_role',legacy),false);
  assert.equal(await allowed('service_role',current),true);
  for(const role of ['anon','authenticated']) assert.equal(await allowed(role,current),false);
  await db.exec('set role service_role');
  await assert.rejects(call(legacy),/permission denied/);
  await db.exec('reset role');
  assert.equal(await call(current,'foreign'),'rejected');
  assert.equal(await call(current),'dispatch');
  const first=(await db.query('select provider_post_attempted_at from hivra_provider_resize_operations')).rows[0].provider_post_attempted_at;
  assert(first);
  assert.equal(await call(current),'observe');
  assert.equal(await call(legacy),'rejected');
  assert.deepEqual((await db.query('select provider_post_attempted_at from hivra_provider_resize_operations')).rows[0].provider_post_attempted_at,first);
  console.log('PASS: old deployment dispatch is inert; compatible entry retains the original one-use body and ACL boundary');
} finally {await db.close();}
