// Execute the actual resize table/checks, journal/lifecycle/shutdown guards and
// absence handoff RPC. Infrastructure binding prerequisites are fixture-only;
// this is not execution of the whole historical deployment schema.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const sql = await readFile(new URL('../supabase/migrations/20260904130000_hivra_provider_resize_operations.sql', import.meta.url), 'utf8');
function definition(source, name) {
  const start = source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  const end = source.indexOf('\n$$;', start);
  assert(start >= 0 && end > start);
  return source.slice(start, end + 4);
}
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table hivra_agents(id uuid primary key,user_id text,operation_id uuid,operation_kind text,
      operation_started_at timestamptz,operation_payload jsonb,status text,desired_state text,cpu numeric,ram integer,
      computer_substrate text,error text);
    create table infrastructure_connections(id uuid primary key);
    create table deployment_targets(id uuid primary key);
    create table infrastructure_capacity_orders(id uuid primary key,user_id text,provider_resource_id text,
      current_server_shape_fingerprint_sha256 text,quote_fingerprint_sha256 text);
    create function hivra_provider_resize_binding_valid(text,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text)
      returns boolean language sql as 'select true';`);
  for (const name of ['hivra_provider_resize_size_valid','hivra_provider_resize_quote_valid','hivra_provider_resize_action_valid']) {
    await db.exec(definition(sql,name));
  }
  const tableStart = sql.indexOf('create table public.hivra_provider_resize_operations (');
  const tableEnd = sql.indexOf('\n);', tableStart);
  await db.exec(sql.slice(tableStart,tableEnd+3));
  for (const name of ['20260905070000_hivra_provider_resize_action_command.sql',
    '20260905071000_hivra_provider_resize_shutdown.sql','20260905072000_hivra_provider_resize_absence.sql',
    '20260905090000_hivra_provider_resize_readiness.sql','20260905091000_hivra_provider_resize_readiness_dispatch.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/'+name, import.meta.url), 'utf8'));
  }
  const agent='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const order='cccccccc-cccc-4ccc-8ccc-cccccccccccc', connection='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const target='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', attempt='ffffffff-ffff-4fff-8fff-ffffffffffff';
  const now=new Date().toISOString(), later=new Date(Date.parse(now)+300000).toISOString();
  const size={serverTypeId:114,serverType:'cx23',architecture:'x86',cores:2,memoryGb:4,advertisedDiskGb:40,
    cpuType:'shared',price:{currency:'USD',hourlyGross:'0.01248',monthlyGross:'7.788'}};
  const quote={operationId:operation,agentId:agent,providerServerId:'42',quoteFingerprint:'d'.repeat(64),
    location:'fsn1',source:size,target:{...size,serverTypeId:109,serverType:'cpx22',advertisedDiskGb:80},
    existingDiskGb:40,upgradeDisk:false,observedAt:now,expiresAt:later,
    downtimeNotice:'The computer must stay powered off while Hetzner changes its server type. Hivra leaves it stopped after the resize so you can review the result before starting it again.',
    billingConfirmation:'Resize this server and accept the new Hetzner billing'};
  await db.query('insert into hivra_agents values ($1,$2,$3,$4,$5,null,$6,$7,2,4,$8,null)',
    [agent,'owner',operation,'resize',now,'provisioning','stopped','provider-vm']);
  await db.query('insert into infrastructure_connections values($1)',[connection]);
  await db.query('insert into deployment_targets values($1)',[target]);
  await db.query('insert into infrastructure_capacity_orders values($1,$2,$3,null,$4)',[order,'owner','42','c'.repeat(64)]);
  const row={operation_id:operation,agent_id:agent,user_id:'owner',connection_id:connection,connection_revision:1,
    deployment_target_id:target,capacity_order_id:order,enrollment_attempt_id:attempt,allocation_operation_id:attempt,
    provider_server_id:'42',source_shape_fingerprint_sha256:'c'.repeat(64),status:'manual_attention',
    plan_fingerprint_sha256:'e'.repeat(64),quote_fingerprint_sha256:quote.quoteFingerprint,quote_snapshot:quote,
    quote_observed_at:now,quote_expires_at:later,billing_confirmed_at:now,dispatch_not_after:new Date(Date.parse(now)+45000).toISOString(),
    provider_post_attempted_at:now,created_at:now,updated_at:now};
  await db.query('insert into hivra_provider_resize_operations select * from jsonb_populate_record(null::hivra_provider_resize_operations,$1)',[JSON.stringify(row)]);
  await db.exec(`create trigger hivra_provider_resize_journal_guard before insert or update or delete
      on hivra_provider_resize_operations for each row execute function guard_hivra_provider_resize_journal();
    create trigger hivra_agents_provider_resize_guard before update on hivra_agents
      for each row execute function guard_hivra_provider_resize_lifecycle();`);
  const absent = async (owner='owner',server='42',at=new Date().toISOString()) =>
    (await db.query('select record_hivra_provider_resize_server_absent($1,$2,$3,$4,$5) as result',[owner,agent,operation,server,at])).rows[0].result;
  assert.equal(await absent(),false);
  await db.exec("update hivra_agents set desired_state='deleted'");
  assert.equal(await absent('foreign'),false);
  assert.equal(await absent('owner','43'),false);
  assert.equal(await absent('owner','42',new Date(Date.now()-16000).toISOString()),false);
  await assert.rejects(db.exec("update hivra_provider_resize_operations set status='removed',provider_server_absent_at=clock_timestamp(),completed_at=clock_timestamp(),failure_code=null"), /hivra_provider_resize_stage_check/);
  await assert.rejects(db.exec('update hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null'), /Verify provider resize/);
  assert.equal(await absent(),true);
  const terminal=(await db.query('select status,provider_action,failure_code,provider_server_absent_at from hivra_provider_resize_operations')).rows[0];
  assert.equal(terminal.status,'removed'); assert.equal(terminal.provider_action,null);
  assert.equal(terminal.failure_code,'provider_server_absent'); assert(terminal.provider_server_absent_at);
  const remaining=(await db.query('select status,desired_state,operation_id from hivra_agents')).rows[0];
  assert.deepEqual(remaining,{status:'error',desired_state:'deleted',operation_id:null});
  await assert.rejects(db.exec("update hivra_provider_resize_operations set failure_code='changed'"), /terminal provider resize/);
  const operations=await readFile(new URL('../supabase/migrations/20260826130000_hivra_agent_authority_operations.sql',import.meta.url),'utf8');
  await db.exec(definition(operations,'request_hivra_agent_delete'));
  assert.equal((await db.query('select request_hivra_agent_delete($1,$2,$3) as result',['owner',agent,target])).rows[0].result,'claimed');
  assert.equal((await db.query('select operation_kind from hivra_agents')).rows[0].operation_kind,'delete');
  console.log('PASS: real resize guards retain absent-server evidence and hand explicit deletion to normal cleanup');
} finally { await db.close(); }
