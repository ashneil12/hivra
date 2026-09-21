// Execute the readiness migration against minimal local PostgreSQL prerequisites.
// This covers real trigger/RPC behavior, not complete historical schema acceptance.
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
    create table infrastructure_first_boot_enrollments(order_id uuid,attempt_id uuid,user_id text,
      connection_id uuid,connection_revision bigint,provider_server_id text,phase text,
      host_public_key text,host_fingerprint_sha256 text,quote_fingerprint_sha256 text);
    create table hivra_provider_resize_operations(operation_id uuid primary key,agent_id uuid,user_id text,
      capacity_order_id uuid,provider_server_id text,source_shape_fingerprint_sha256 text,
      status text,provider_action jsonb,provider_observed_at timestamptz,provider_observed_status text,
      provider_observed_server_type_id bigint,provider_observed_server_type text,provider_observed_architecture text,
      provider_observed_cores integer,provider_observed_memory_gb integer,provider_observed_advertised_disk_gb bigint,
      provider_observed_cpu_type text,provider_observed_disk_gb bigint,quote_snapshot jsonb,updated_at timestamptz,
      enrollment_attempt_id uuid,connection_id uuid,connection_revision bigint);
  `);
  for (const name of ['20260905070000_hivra_provider_resize_action_command.sql',
    '20260905071000_hivra_provider_resize_shutdown.sql', '20260905090000_hivra_provider_resize_readiness.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const agent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const order = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', attempt = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const connection = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const pin = `SHA256:${'A'.repeat(43)}`;
  const action = { id: 701, command: 'change_server_type', status: 'success', resources: [{ id: 42, type: 'server' }] };
  const quote = { target: { serverTypeId: 109, serverType: 'cpx22', architecture: 'x86', cores: 2,
    memoryGb: 4, advertisedDiskGb: 80, cpuType: 'shared' }, existingDiskGb: 40 };
  await db.query('insert into hivra_agents values ($1,$2,$3,$4,$5,$6)', [agent,'owner',operation,'resize','provisioning','stopped']);
  await db.query('insert into infrastructure_capacity_orders values ($1,$2,$3,null,$4)', [order,'owner','42','fingerprint']);
  await db.query('insert into infrastructure_first_boot_enrollments values ($1,$2,$3,$4,7,$5,$6,$7,$8,$9)',
    [order,attempt,'owner',connection,'42','enrolled','fixture-public-key',pin,'fingerprint']);
  await db.query(`insert into hivra_provider_resize_operations(operation_id,agent_id,user_id,capacity_order_id,
    provider_server_id,source_shape_fingerprint_sha256,status,provider_action,provider_observed_at,provider_observed_status,
    provider_observed_server_type_id,provider_observed_server_type,provider_observed_architecture,provider_observed_cores,
    provider_observed_memory_gb,provider_observed_advertised_disk_gb,provider_observed_cpu_type,provider_observed_disk_gb,
    quote_snapshot,updated_at,enrollment_attempt_id,connection_id,connection_revision)
    values ($1,$2,'owner',$3,'42','fingerprint','provider_pending',$4,clock_timestamp(),'running',109,'cpx22','x86',2,4,80,'shared',40,$5,clock_timestamp(),$6,$7,7)`,
    [operation,agent,order,JSON.stringify(action),JSON.stringify(quote),attempt,connection]);
  const record = async (receipt, owner='owner') => (await db.query('select record_hivra_provider_resize_readiness($1,$2,$3,$4) as result',
    [owner,agent,operation,receipt === null ? null : JSON.stringify(receipt)])).rows[0].result;
  const begin = async receipt => (await db.query('select begin_hivra_provider_resize_shutdown_v2($1,$2,$3,$4) as result',
    ['owner',agent,operation,receipt === null ? null : JSON.stringify(receipt)])).rows[0].result;
  const oldBegin = async () => (await db.query('select begin_hivra_provider_resize_shutdown($1,$2,$3) as result',
    ['owner',agent,operation])).rows[0].result;
  assert.equal(await oldBegin(), 'rejected');
  assert.equal(await begin(null), 'rejected');
  assert.equal(await record(null, 'foreign'), false);
  assert.equal(await record(null), true);
  const wait = (await db.query('select shutdown_wait_started_at from hivra_provider_resize_operations')).rows[0].shutdown_wait_started_at;
  assert.equal(await record(null), true);
  assert.equal(String((await db.query('select shutdown_wait_started_at from hivra_provider_resize_operations')).rows[0].shutdown_wait_started_at), String(wait));
  await assert.rejects(db.exec('update hivra_provider_resize_operations set shutdown_attempted_at=clock_timestamp()'), /enrolled guest readiness/);
  const readiness = { version: 1, observedAt: new Date().toISOString(), bootId: attempt, powerHandlerPid: 649, hostFingerprintSha256: pin };
  for (const bad of [{ ...readiness, hostFingerprintSha256: 'wrong' }, { ...readiness, bootId: 'invalid' },
    { ...readiness, observedAt: new Date(Date.now()-16_000).toISOString() }, { ...readiness, powerHandlerPid: 0 },
    { ...readiness, extra: true }]) await assert.rejects(record(bad));
  await db.exec("update infrastructure_first_boot_enrollments set phase='revoked'");
  await assert.rejects(record(readiness), /original enrolled host/);
  await db.exec("update infrastructure_first_boot_enrollments set phase='enrolled'");
  assert.equal(await record(readiness), true);
  assert.equal(await oldBegin(), 'rejected');
  assert.equal(await begin({ ...readiness, bootId: connection }), 'rejected');
  await db.exec("update hivra_agents set desired_state='deleted'");
  assert.equal(await begin(readiness), 'rejected');
  await db.exec("update hivra_agents set desired_state='stopped'");
  await db.exec("update infrastructure_first_boot_enrollments set phase='revoked'");
  await assert.rejects(begin(readiness), /original enrolled host/);
  await db.exec("update infrastructure_first_boot_enrollments set phase='enrolled'");
  assert.equal(await begin(readiness), 'dispatch');
  assert.equal(await begin(readiness), 'observe');
  assert.equal(await record(null), false);
  await assert.rejects(db.exec('update hivra_provider_resize_operations set shutdown_readiness=null'), /Retain dispatched/);
  // Seed an aged, undispatched journal only in the local fixture. The trigger
  // is re-enabled before testing expiry; this never touches a live database.
  await db.exec(`alter table hivra_provider_resize_operations disable trigger hivra_provider_resize_readiness_guard;
    alter table hivra_provider_resize_operations disable trigger hivra_provider_resize_shutdown_guard;
    update hivra_provider_resize_operations set shutdown_attempted_at=null,shutdown_readiness=null,
      shutdown_wait_started_at=clock_timestamp()-interval '121 seconds';
    alter table hivra_provider_resize_operations enable trigger hivra_provider_resize_readiness_guard;
    alter table hivra_provider_resize_operations enable trigger hivra_provider_resize_shutdown_guard;`);
  assert.equal(await record(readiness), false);
  assert.equal((await db.query('select status from hivra_provider_resize_operations')).rows[0].status, 'manual_attention');
  const grants = (await db.query(`select
    has_function_privilege('service_role','begin_hivra_provider_resize_shutdown(text,uuid,uuid)','EXECUTE') as old,
    has_function_privilege('service_role','begin_hivra_provider_resize_shutdown_v2(text,uuid,uuid,jsonb)','EXECUTE') as current,
    has_function_privilege('authenticated','begin_hivra_provider_resize_shutdown_v2(text,uuid,uuid,jsonb)','EXECUTE') as browser`)).rows[0];
  assert.deepEqual(grants, { old: false, current: true, browser: false });
  console.log('PASS: readiness freshness/pin/lease, fixed deadline, old handler hold and one-use shutdown boundary');
} finally { await db.close(); }
