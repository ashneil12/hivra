const assert = require('node:assert/strict');
const { canonicalFixture, migration } = require('./lib/canonical-postgres-fixture.cjs');

async function main() {
  const db = await canonicalFixture();
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  try {
    const agent = '11111111-1111-4111-8111-111111111111';
    const desktop = '22222222-2222-4222-8222-222222222222';
    const command = '33333333-3333-4333-8333-333333333333';
    const otherCommand = '44444444-4444-4444-8444-444444444444';
    await db.query(`insert into public.hivra_agents(id,user_id,name,status,desired_state,type,computer_profile)
      values($1,'owner','Agent','running','running','agent-zero',null),
      ($2,'owner','Ubuntu','running','running','linux-desktop','ubuntu-desktop')`, [agent, desktop]);
    // Additive migration must also initialise resources projected before it.
    await db.exec(migration('20260906170000_hivra_canonical_relationship_authority.sql'));
    const mapping = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [agent]);
    const computer = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [desktop]);
    const transfer = async (owner = 'owner', target = mapping.computer_id, event = mapping.last_source_event_id, generation = 1, id = command) =>
      (await one('select public.transfer_hivra_canonical_relationship_authority($1,$2,$3,$4,$5) as result', [owner,target,event,generation,id])).result;
    assert.equal(await transfer('other-owner'), null);
    assert.equal(await transfer('owner', mapping.computer_id, 99999), null);
    assert.equal(await transfer('owner', mapping.computer_id, mapping.last_source_event_id, 2), null);
    await db.query("select public.set_hivra_canonical_inventory_read_mode('shadow')");
    assert.equal(await transfer(), null, 'old shadow reader must be deselected before transfer');
    assert.equal(Number((await one('select count(*) as count from public.hivra_canonical_authority_commands')).count), 0);
    assert.equal(Number((await one('select count(*) as count from public.hivra_canonical_authority_outbox')).count), 0);
    assert.equal((await one('select write_authority from public.hivra_canonical_relationship_authority where computer_id=$1', [mapping.computer_id])).write_authority, 'legacy');
    await db.query("select public.set_hivra_canonical_inventory_read_mode('legacy')");
    const originalSource = await one('select * from public.hivra_agents where id=$1', [agent]);
    const result = await transfer();
    assert.equal(result.generation, 2);
    assert.equal(result.commandId, command);
    assert.equal(result.resumed, false);
    assert.equal((await one('select write_authority from public.hivra_canonical_shadow_control')).write_authority, 'mixed');
    assert.deepEqual(await one('select * from public.hivra_agents where id=$1', [agent]), originalSource, 'transfer does not mutate a guest or its lifecycle row');
    assert.equal((await one('select write_authority from public.hivra_canonical_computers where id=$1', [mapping.computer_id])).write_authority, 'legacy');
    assert.equal((await transfer()).resumed, true);
    assert.equal(await transfer('owner', computer.computer_id, computer.last_source_event_id, 1, command), null);
    assert.equal(await transfer('owner', mapping.computer_id, mapping.last_source_event_id, 1, otherCommand), null);
    assert.equal(Number((await one('select count(*) as count from public.hivra_canonical_authority_outbox')).count), 1, 'completed replay emits no second event');
    const related = async () => {
      const rows = {};
      for (const [table, id] of [['agent_identities',mapping.agent_identity_id],
        ['runtime_installations',mapping.runtime_installation_id], ['primary_bindings',mapping.primary_binding_id]]) {
        rows[table] = await one(`select * from public.hivra_canonical_${table} where id=$1`, [id]);
        assert.equal(rows[table].write_authority, 'canonical');
        assert.equal(Number(rows[table].authority_generation), 2);
      }
      return rows;
    };
    // DB-owner fixture represents a future canonical command, not an exposed
    // application writer or a claim that detach/revocation is implemented.
    await db.query("update public.hivra_canonical_primary_bindings set status='detached',detached_at=now() where id=$1", [mapping.primary_binding_id]);
    const saved = await related();
    await db.query("update public.hivra_agents set name='Computer renamed',status='stopped',desired_state='stopped' where id=$1", [agent]);
    assert.deepEqual(await related(), saved, 'legacy projection cannot erase canonical relationships');
    assert.equal((await one('select observed_state from public.hivra_canonical_computers where id=$1', [mapping.computer_id])).observed_state, 'stopped');
    const parity = (await one('select public.hivra_canonical_shadow_parity() as result')).result;
    assert.equal(parity.projectionMismatchCount, 0);
    assert.equal(parity.authorityMismatchCount, 0);
    assert.equal(parity.unsupportedAuthorityCount, 1);
    assert.equal(parity.ready, false, 'old reader cannot be enabled after transfer');
    await assert.rejects(() => db.query("select public.set_hivra_canonical_inventory_read_mode('shadow')"), { code: '55000' });
    await assert.rejects(() => db.query('update public.hivra_canonical_primary_bindings set authority_generation=3 where id=$1', [mapping.primary_binding_id]), { code: '23503' });
    // Command and every ownership update must roll back if event insertion
    // fails. An outbox failure cannot leave a transferred-but-unrecorded epoch.
    await db.exec(`create function public.fixture_reject_authority_event() returns trigger language plpgsql as $$
      begin raise exception 'fixture event failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_authority_event before insert on public.hivra_canonical_authority_outbox
      for each row execute function public.fixture_reject_authority_event();`);
    await assert.rejects(() => transfer('owner',computer.computer_id,computer.last_source_event_id,1,otherCommand), { code: '55000' });
    assert.equal(await one('select id from public.hivra_canonical_authority_commands where id=$1', [otherCommand]), undefined);
    assert.equal((await one('select write_authority from public.hivra_canonical_relationship_authority where computer_id=$1', [computer.computer_id])).write_authority, 'legacy');
    await db.exec('drop trigger fixture_reject_authority_event on public.hivra_canonical_authority_outbox; drop function public.fixture_reject_authority_event()');
    await db.query("update public.hivra_agents set operation_id=$2,operation_kind='restart' where id=$1", [desktop,otherCommand]);
    let current = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [desktop]);
    assert.equal(await transfer('owner',computer.computer_id,current.last_source_event_id,1,otherCommand), null, 'active legacy lifecycle operation blocks transfer');
    await db.query('update public.hivra_agents set operation_id=null,operation_kind=null where id=$1', [desktop]);
    current = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [desktop]);
    assert.equal((await transfer('owner',computer.computer_id,current.last_source_event_id,1,otherCommand)).generation, 2);
    assert.equal(Number((await one('select count(*) as count from public.hivra_canonical_agent_identities')).count), 1, 'bare-computer transfer does not fabricate an agent');
    await db.query('delete from public.hivra_agents where id=$1', [agent]);
    assert.deepEqual(await related(), saved, 'legacy deletion does not archive an independently owned agent identity');
    assert.equal((await one('select public.hivra_canonical_shadow_parity() as result')).result.historicalMismatchCount, 0);
    const hermes = '55555555-5555-4555-8555-555555555555';
    const hermesCommand = '66666666-6666-4666-8666-666666666666';
    await db.query("insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,agent_type) values($1,'hermes-owner','Hermes','running','active','hermes')", [hermes]);
    const hm = await one('select * from public.hivra_canonical_source_mappings where source_id=$1', [hermes]);
    assert.equal((await transfer('hermes-owner',hm.computer_id,hm.last_source_event_id,1,hermesCommand)).generation, 2, 'new projections initialise their own authority row');
    await assert.rejects(() => db.query('update public.hivra_canonical_agent_identities set authority_command_id=$2 where id=$1', [mapping.agent_identity_id,hermesCommand]), { code: '23503' });
    await db.query("update public.hermes_instances set name='New computer name' where id=$1", [hermes]);
    assert.equal((await one('select name from public.hivra_canonical_agent_identities where id=$1', [hm.agent_identity_id])).name, 'Hermes');
    await db.exec('set role service_role');
    await assert.rejects(() => transfer('owner',computer.computer_id,computer.last_source_event_id,1,otherCommand), { code: '42501' });
    await db.exec('reset role');
    console.log('PASS canonical relationship authority transfer, replay, generation fencing and legacy projection ownership');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
