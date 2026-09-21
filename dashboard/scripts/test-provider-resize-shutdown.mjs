// Local PostgreSQL execution of the new shutdown guard/RPC boundary only.
// Minimal prerequisite tables are fixtures, not full historical migration proof.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table hivra_agents(id uuid primary key,user_id text,operation_id uuid,
      operation_kind text,status text,desired_state text);
    create table infrastructure_capacity_orders(id uuid primary key,user_id text,
      provider_resource_id text,current_server_shape_fingerprint_sha256 text,quote_fingerprint_sha256 text);
    create table hivra_provider_resize_operations(operation_id uuid primary key,agent_id uuid,user_id text,
      capacity_order_id uuid,provider_server_id text,source_shape_fingerprint_sha256 text,
      status text,provider_action jsonb,provider_observed_at timestamptz,provider_observed_status text,
      provider_observed_server_type_id bigint,provider_observed_server_type text,provider_observed_architecture text,
      provider_observed_cores integer,provider_observed_memory_gb integer,provider_observed_advertised_disk_gb bigint,
      provider_observed_cpu_type text,provider_observed_disk_gb bigint,quote_snapshot jsonb,updated_at timestamptz);
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20260905070000_hivra_provider_resize_action_command.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260905071000_hivra_provider_resize_shutdown.sql', import.meta.url), 'utf8'));
  const agent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const operation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const order = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const receipt = { id: 701, command: 'change_server_type', status: 'success', resources: [{ id: 42, type: 'server' }] };
  const quote = { target: { serverTypeId: 109, serverType: 'cpx22', architecture: 'x86', cores: 2,
    memoryGb: 4, advertisedDiskGb: 80, cpuType: 'shared' }, existingDiskGb: 40 };
  await db.query('insert into hivra_agents values ($1,$2,$3,$4,$5,$6)', [agent,'owner',operation,'resize','provisioning','stopped']);
  await db.query('insert into infrastructure_capacity_orders values ($1,$2,$3,null,$4)', [order,'owner','42','fingerprint']);
  await db.query(`insert into hivra_provider_resize_operations values
    ($1,$2,'owner',$3,'42','fingerprint','provider_pending',$4,clock_timestamp(),'running',109,'cpx22','x86',2,4,80,'shared',40,$5,clock_timestamp(),null,null)`,
    [operation,agent,order,JSON.stringify(receipt),JSON.stringify(quote)]);
  const begin = async (owner='owner') => (await db.query('select begin_hivra_provider_resize_shutdown($1,$2,$3) as result', [owner,agent,operation])).rows[0].result;
  assert.equal(await begin('foreign'), 'rejected');
  await db.exec("update hivra_agents set desired_state='deleted'");
  assert.equal(await begin(), 'rejected');
  await db.exec("update hivra_agents set desired_state='stopped'; update hivra_provider_resize_operations set provider_observed_disk_gb=80");
  await assert.rejects(begin(), /fresh exact resized running server/);
  await db.exec('update hivra_provider_resize_operations set provider_observed_disk_gb=40');
  await db.exec("update hivra_provider_resize_operations set provider_observed_at=clock_timestamp()-interval '16 seconds'");
  await assert.rejects(begin(), /fresh exact resized running server/);
  await db.exec("update hivra_provider_resize_operations set provider_observed_at=clock_timestamp(),provider_action=jsonb_set(provider_action,'{status}','\"running\"')");
  await assert.rejects(begin(), /fresh exact resized running server/);
  await db.exec("update hivra_provider_resize_operations set provider_action=jsonb_set(provider_action,'{status}','\"success\"')");
  assert.equal(await begin(), 'dispatch');
  assert.equal(await begin(), 'observe');
  await assert.rejects(db.exec('update hivra_provider_resize_operations set shutdown_attempted_at=null'), /one-use/);
  const record = async action => db.query('select record_hivra_provider_resize_shutdown($1,$2,$3,$4)', ['owner',agent,operation,JSON.stringify(action)]);
  const shutdown = { id: 702, command: 'shutdown_server', status: 'running', resources: [{ id: 42, type: 'server' }] };
  await assert.rejects(record({ ...shutdown, resources: [{ id: 43, type: 'server' }] }), /Invalid resize shutdown receipt/);
  await assert.rejects(record({ ...shutdown, command: 'reboot_server' }), /Invalid resize shutdown receipt/);
  await record(shutdown);
  await assert.rejects(db.exec("update hivra_provider_resize_operations set status='succeeded'"), /original shutdown/);
  await record({ ...shutdown, status: 'success' });
  await assert.rejects(record({ ...shutdown, id: 703, status: 'success' }), /original resize shutdown receipt/);
  await assert.rejects(record(shutdown), /original resize shutdown receipt/);
  await db.exec("update hivra_provider_resize_operations set status='succeeded',provider_observed_status='off'");
  assert.equal((await db.query('select shutdown_action from hivra_provider_resize_operations')).rows[0].shutdown_action.id, 702);
  const privilege = await db.query(`select has_function_privilege('authenticated',
    'begin_hivra_provider_resize_shutdown(text,uuid,uuid)','EXECUTE') as allowed`);
  assert.equal(privilege.rows[0].allowed, false);
  console.log('PASS: PostgreSQL shutdown marker, exact receipt, terminal evidence and RPC permission boundary');
} finally { await db.close(); }
