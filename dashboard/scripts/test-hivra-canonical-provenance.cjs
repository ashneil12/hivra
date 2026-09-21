// Execute the actual migrations in isolated PostgreSQL; no live credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  const db = new PGlite();
  const migration = name => fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', name), 'utf8');
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.hermes_instances(id uuid primary key,user_id text,name text,status text,
        lifecycle_state text,backend text,agent_type text,host_id uuid,pool_id uuid,product_surface text,
        infrastructure_provider text,proxmox_node text,proxmox_vmid integer,cpu_limit integer,ram_limit integer);
      create table public.hivra_agents(id uuid primary key,user_id text,name text,status text,desired_state text,
        operation_id uuid,operation_kind text,type text,computer_profile text,deployment_mode text,
        computer_substrate text,pool_id uuid,infrastructure_connection_id uuid,infrastructure_connection_revision bigint,
        deployment_target_id uuid,provider_capacity_order_id uuid,provider_server_id text,proxmox_host text,
        vmid integer,cpu integer,ram integer);`);
    await db.exec(migration('20260904100000_hivra_canonical_resource_shadow.sql'));
    const addition = path.resolve(__dirname, '../supabase/migrations/20260906150000_hivra_canonical_binding_provenance.sql');
    await db.exec(fs.readFileSync(addition, 'utf8'));
    const parityMigration = path.resolve(__dirname, '../supabase/migrations/20260906160000_hivra_canonical_parity_coverage.sql');
    await db.exec(fs.readFileSync(parityMigration, 'utf8'));
    await db.exec(migration('20260906170000_hivra_canonical_relationship_authority.sql'));
    const agent = '11111111-1111-4111-8111-111111111111';
    const desktop = '22222222-2222-4222-8222-222222222222';
    await db.query(`insert into public.hermes_instances(id,user_id,name,status,agent_type)
      values($1,'owner','Hermes','running','hermes')`, [agent]);
    await db.query(`insert into public.hivra_agents(id,user_id,name,status,desired_state,type,computer_profile)
      values($1,'owner','Ubuntu','running','running','linux-desktop','ubuntu-desktop')`, [desktop]);
    const original = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [agent]);
    const computer = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [desktop]);
    assert.ok(original, 'Hermes source projects synchronously');
    assert.ok(computer, 'Ubuntu source projects synchronously');
    const otherAgent = '33333333-3333-4333-8333-333333333333';
    await db.query(`insert into public.hivra_agents(id,user_id,name,status,desired_state,type)
      values($1,'other-owner','Agent Zero','running','running','agent-zero')`, [otherAgent]);
    const other = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [otherAgent]);
    assert.ok(other.agent_identity_id, 'Hivra agent has a projected identity');
    await assert.rejects(() => db.query(`insert into public.hivra_canonical_primary_bindings
      (id,user_id,computer_id,agent_identity_id,status,source_event_id,detached_at)
      values(gen_random_uuid(),'owner',$1,$2,'detached',$3,now())`,
    [computer.computer_id, other.agent_identity_id, original.last_source_event_id]), { code: '23503' });
    await assert.rejects(() => db.query(`insert into public.hivra_canonical_primary_bindings
      (id,user_id,computer_id,agent_identity_id,status,source_event_id)
      values(gen_random_uuid(),'owner',$1,$2,'active',$3)`,
    [computer.computer_id, original.agent_identity_id, original.last_source_event_id]),
    { code: '23505' }, 'one identity cannot be active on two computers');
    for (const mutation of ["source_kind='hivra'", 'source_id=gen_random_uuid()', "user_id='different-owner'",
      "resource_kind='computer'", "compatibility_alias='changed'", 'computer_id=gen_random_uuid()',
      'agent_identity_id=gen_random_uuid()', 'runtime_installation_id=gen_random_uuid()',
      'agent_identity_id=null', 'runtime_installation_id=null', 'primary_binding_id=null',
      'primary_binding_id=gen_random_uuid()', 'first_source_event_id=first_source_event_id+1',
      "created_at=created_at+interval '1 second'"]) {
      await assert.rejects(() => db.query(`update public.hivra_canonical_source_mappings
        set ${mutation} where source_id=$1`, [agent]), { code: '23514' }, `immutable ${mutation}`);
    }
    await assert.rejects(() => db.query('delete from public.hivra_canonical_source_mappings where source_id=$1', [agent]),
      { code: '23514' }, 'source lineage cannot be deleted');
    await db.query("update public.hermes_instances set name='Renamed',status='stopped' where id=$1", [agent]);
    const after = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [agent]);
    for (const key of Object.keys(original).filter(key => !['last_source_event_id', 'updated_at'].includes(key))) {
      assert.deepEqual(after[key], original[key], `stable ${key}`);
    }
    assert.ok(Number(after.last_source_event_id) > Number(original.last_source_event_id));
    // Force replay of the old event, including the out-of-order rather than
    // merely already-processed path. It must not roll back names or IDs.
    await db.query('update public.hivra_canonical_source_events set processed_at=null where event_id=$1', [original.last_source_event_id]);
    assert.equal((await one('select public.apply_hivra_canonical_source_event($1) as result', [original.last_source_event_id])).result, 'superseded');
    assert.deepEqual(await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [agent]), after);
    await assert.rejects(() => db.query('update public.hivra_canonical_source_mappings set last_source_event_id=$1 where source_id=$2',
      [original.last_source_event_id, agent]), { code: '23514' });
    assert.equal((await one('select public.hivra_canonical_shadow_parity() as result')).result.ready, true);
    // An extra canonical row must not disappear from the cutover gate simply
    // because it is unreachable through the legacy source mapping join.
    for (const [table, counter, fields] of [
      ['computers', 'unmappedComputerCount', {}],
      ['agent_identities', 'unmappedIdentityCount', {}],
      ['runtime_installations', 'unmappedInstallationCount', {}],
      ['primary_bindings', 'unmappedBindingCount', { status: 'detached', detached_at: new Date().toISOString() }],
    ]) {
      await db.exec('begin');
      try {
        await db.query(`insert into public.hivra_canonical_${table}
          select (jsonb_populate_record(null::public.hivra_canonical_${table},
            to_jsonb(original) || $1::jsonb || jsonb_build_object('id',gen_random_uuid()))).*
          from public.hivra_canonical_${table} original limit 1`, [JSON.stringify(fields)]);
        const parity = (await one('select public.hivra_canonical_shadow_parity() as result')).result;
        assert.equal(parity.ready, false, `unmapped ${table} must block cutover`);
        assert.equal(parity[counter], 1);
        const legacy = (await one("select public.set_hivra_canonical_inventory_read_mode('legacy') as result")).result;
        assert.equal(legacy.inventoryReadMode, 'legacy', 'presentation rollback remains available before authority cutover');
        assert.equal(legacy.ready, false, 'rollback does not claim the inconsistent shadow is ready');
        assert.equal(legacy[counter], 1, 'gate does not delete the extra row');
        await assert.rejects(() => db.query("select public.set_hivra_canonical_inventory_read_mode('shadow')"), { code: '55000' });
      } finally { await db.exec('rollback'); }
    }
    await db.exec('set role service_role');
    assert.equal((await one('select public.hivra_canonical_shadow_parity() as result')).result.ready, true);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(() => db.query('select public.hivra_canonical_shadow_parity()'), { code: '42501' });
    await db.exec('reset role');
    for (const mode of ['shadow', 'legacy']) {
      assert.equal((await one('select public.set_hivra_canonical_inventory_read_mode($1) as result', [mode])).result.inventoryReadMode, mode);
    }
    await db.query('delete from public.hermes_instances where id=$1', [agent]);
    assert.equal((await one('select status from public.hivra_canonical_primary_bindings where id=$1', [original.primary_binding_id])).status, 'detached');
    assert.equal((await one('select computer_id from public.hivra_canonical_source_mappings where source_id=$1', [agent])).computer_id, original.computer_id);
    // Detached history is allowed; only active duplication is prohibited.
    await db.query(`insert into public.hivra_canonical_primary_bindings
      (id,user_id,computer_id,agent_identity_id,status,source_event_id,detached_at)
      values(gen_random_uuid(),'owner',$1,$2,'detached',$3,now())`,
    [computer.computer_id, original.agent_identity_id, original.last_source_event_id]);
    await db.exec('set role service_role');
    await assert.rejects(() => db.query('delete from public.hivra_canonical_source_mappings'), { code: '42501' });
    await db.exec('reset role');
    // Re-run admission against deliberately inconsistent pre-existing data.
    // This is an isolated DB owner fixture, not an application writer path.
    await db.exec('drop index public.hivra_canonical_one_active_computer_per_identity');
    await db.query("update public.hivra_canonical_primary_bindings set status='active',detached_at=null where agent_identity_id=$1", [original.agent_identity_id]);
    const countBefore = await one('select count(*) as count from public.hivra_canonical_primary_bindings');
    await assert.rejects(() => db.exec(fs.readFileSync(addition, 'utf8')), { code: '23505' });
    assert.deepEqual(await one('select count(*) as count from public.hivra_canonical_primary_bindings'), countBefore);
    await db.query("update public.hivra_canonical_primary_bindings set status='detached',detached_at=now() where computer_id=$1", [computer.computer_id]);
    await db.exec(`create unique index hivra_canonical_one_active_computer_per_identity
      on public.hivra_canonical_primary_bindings(agent_identity_id) where status='active'`);
    await assert.rejects(() => db.query("update public.hivra_canonical_primary_bindings set status='active',detached_at=null where computer_id=$1", [computer.computer_id]), { code: '23505' });
    console.log('PASS canonical identity uniqueness, immutable provenance, projection, tombstones, read rollback and ACL');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
