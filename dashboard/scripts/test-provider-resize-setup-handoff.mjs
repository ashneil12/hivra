import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const extract = (sql, name) => {
  const start = sql.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0);
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4);
};
try {
  await db.exec(`
    create table infrastructure_capacity_orders(id uuid primary key,user_id text,connection_id uuid,
      connection_revision bigint,provider_resource_id text,status text,quote_fingerprint_sha256 text,
      current_server_shape jsonb,current_server_shape_fingerprint_sha256 text,updated_at timestamptz,
      provider_observed_at timestamptz,observed_server_status text,last_error_code text,
      cleanup_firewall_receipt jsonb,cleanup_lease_id uuid,cleanup_lease_expires_at timestamptz);
    create table infrastructure_first_boot_operations(order_id uuid,lease_expires_at timestamptz,
      firewall_post_attempted_at timestamptz,firewall_receipt jsonb,abandoned_at timestamptz);
    create table hivra_provider_resize_operations(operation_id uuid,capacity_order_id uuid,user_id text,
      connection_id uuid,connection_revision bigint,provider_server_id text,status text,
      source_shape_fingerprint_sha256 text,quote_fingerprint_sha256 text,provider_observed_server_type_id bigint,
      provider_observed_server_type text,provider_observed_architecture text,provider_observed_cores integer,
      provider_observed_memory_gb integer,provider_observed_advertised_disk_gb bigint,provider_observed_cpu_type text,
      provider_observed_disk_gb bigint,provider_observed_at timestamptz,provider_observed_status text,
      quote_snapshot jsonb,provider_action jsonb);
  `);
  const base = await migration('20260904130000_hivra_provider_resize_operations.sql');
  await db.exec(extract(base, 'hivra_provider_current_shape_valid'));
  await db.exec(extract(base, 'guard_hivra_provider_current_shape'));
  const old = await migration('20260827210000_hetzner_first_boot_cleanup.sql');
  const start = old.indexOf('create or replace function public.guard_first_boot_operation_order()');
  await db.exec(old.slice(start, old.indexOf('\n$$;', start) + 4));
  await db.exec(`create trigger first_boot_guard before update or delete on infrastructure_capacity_orders
    for each row execute function guard_first_boot_operation_order();
    create trigger resize_shape_guard before update on infrastructure_capacity_orders
    for each row execute function guard_hivra_provider_current_shape();`);
  const order='11111111-1111-4111-8111-111111111111', connection='22222222-2222-4222-8222-222222222222';
  const operation='33333333-3333-4333-8333-333333333333', observed='2026-09-05T10:00:00.000Z';
  const previous='a'.repeat(64), quote='b'.repeat(64);
  const type={id:109,name:'cpx22',architecture:'x86',cores:2,memoryGb:4,advertisedDiskGb:80,cpuType:'shared'};
  const shape={version:1,provider:'hetzner-cloud',capacityOrderId:order,connectionId:connection,connectionRevision:7,
    providerServerId:'42',resizeOperationId:operation,resizeQuoteFingerprintSha256:quote,
    previousShapeFingerprintSha256:previous,serverType:type,primaryDiskGb:40,observedAt:observed};
  await db.query(`insert into infrastructure_capacity_orders(id,user_id,connection_id,connection_revision,
    provider_resource_id,status,quote_fingerprint_sha256) values ($1,'owner',$2,7,'42','created_off',$3)`,[order,connection,previous]);
  await db.query(`insert into infrastructure_first_boot_operations values ($1,null,now(),'{}',null)`,[order]);
  await db.query(`insert into hivra_provider_resize_operations values
    ($1,$2,'owner',$3,7,'42','succeeded',$4,$5,109,'cpx22','x86',2,4,80,'shared',40,$6,'off',$7,'{"status":"success"}')`,
    [operation,order,connection,previous,quote,observed,JSON.stringify({target:{serverTypeId:109,serverType:'cpx22',
      architecture:'x86',cores:2,memoryGb:4,advertisedDiskGb:80,cpuType:'shared'},existingDiskGb:40})]);
  const publish = value => db.query(`update infrastructure_capacity_orders set current_server_shape=$1::jsonb,
    current_server_shape_fingerprint_sha256=encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'),updated_at=now() where id=$2`,
    [JSON.stringify(value),order]);
  await assert.rejects(publish(shape), /First-boot setup owns/);
  await db.exec(await migration('20260905190000_provider_resize_setup_handoff.sql'));
  await db.exec("update infrastructure_first_boot_operations set lease_expires_at=now()+interval '5 minutes'");
  await assert.rejects(publish(shape), /First-boot setup owns/);
  await db.exec('update infrastructure_first_boot_operations set lease_expires_at=null');
  for (const bad of [{...shape,primaryDiskGb:80},{...shape,providerServerId:'43'},
    {...shape,previousShapeFingerprintSha256:'c'.repeat(64)}]) await assert.rejects(publish(bad));
  await db.exec("update hivra_provider_resize_operations set status='provider_pending'");
  await assert.rejects(publish(shape), /terminal resize evidence/);
  await db.exec("update hivra_provider_resize_operations set status='succeeded',user_id='foreign'");
  await assert.rejects(publish(shape), /terminal resize evidence/);
  await db.exec("update hivra_provider_resize_operations set user_id='owner'");
  await assert.rejects(db.query(`update infrastructure_capacity_orders set provider_resource_id='43',
    current_server_shape=$1::jsonb,current_server_shape_fingerprint_sha256=repeat('d',64)`,[JSON.stringify(shape)]), /First-boot setup owns/);
  await publish(shape);
  assert.deepEqual((await db.query('select current_server_shape from infrastructure_capacity_orders')).rows[0].current_server_shape,shape);
  await assert.rejects(db.exec("update infrastructure_capacity_orders set cleanup_firewall_receipt='{\"foreign\":true}'"), /First-boot setup owns/);
  await assert.rejects(db.exec('delete from infrastructure_capacity_orders'), /Retain first-boot resource evidence/);
  console.log('PASS provider resize/setup handoff: old failure, exact successor, active lease, wrong owner/disk/server/chain, receipt and deletion guards');
} finally { await db.close(); }
