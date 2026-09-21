const assert = require('node:assert/strict');
const { canonicalFixture, migration } = require('./lib/canonical-postgres-fixture.cjs');

async function main() {
  const db = await canonicalFixture();
  const one = async (sql,args=[]) => (await db.query(sql,args)).rows[0];
  try {
    await db.exec(migration('20260906170000_hivra_canonical_relationship_authority.sql'));
    await db.exec(migration('20260906180000_hivra_canonical_relationship_reader.sql'));
    const source = '11111111-1111-4111-8111-111111111111';
    const command = '22222222-2222-4222-8222-222222222222';
    const identity = '33333333-3333-4333-8333-333333333333';
    const installation = '44444444-4444-4444-8444-444444444444';
    const binding = '55555555-5555-4555-8555-555555555555';
    await db.query(`insert into public.hivra_agents(id,user_id,name,status,desired_state,type,computer_profile)
      values($1,'owner','Ubuntu','running','running','linux-desktop','ubuntu-desktop'),
      ('66666666-6666-4666-8666-666666666666','other-owner','Private agent','running','running','agent-zero',null)`, [source]);
    const m = await one('select * from public.hivra_canonical_source_mappings where source_id=$1',[source]);
    const read = async (owner='owner',id=m.computer_id) =>
      (await one('select public.read_hivra_canonical_computer_relationships($1,$2) as result',[owner,id])).result;
    const before = await read();
    assert.deepEqual(before.bindings, []);
    assert.deepEqual(before.identities, []);
    assert.deepEqual(before.installations, []);
    assert.equal(await read('other-owner'), null);
    assert.equal(await read('owner',command), null);
    await db.query('select public.transfer_hivra_canonical_relationship_authority($1,$2,$3,1,$4)',
      ['owner',m.computer_id,m.last_source_event_id,command]);
    // DB-owner fixtures model persisted canonical relationships, not an
    // implemented installer or a claim of actual runtime readiness.
    await db.query(`insert into public.hivra_canonical_agent_identities
      (id,user_id,name,status,source_event_id,write_authority,authority_generation,authority_command_id)
      values($1,'owner','Attached identity','active',$2,'canonical',2,$3)`,[identity,m.last_source_event_id,command]);
    await db.query(`insert into public.hivra_canonical_runtime_installations
      (id,user_id,computer_id,runtime_id,status,source_event_id,write_authority,authority_generation,authority_command_id)
      values($1,'owner',$2,'agent-zero','installing',$3,'canonical',2,$4)`,[installation,m.computer_id,m.last_source_event_id,command]);
    await db.query(`insert into public.hivra_canonical_primary_bindings
      (id,user_id,computer_id,agent_identity_id,status,detached_at,source_event_id,write_authority,authority_generation,authority_command_id)
      values($1,'owner',$2,$3,'detached',now(),$4,'canonical',2,$5)`,[binding,m.computer_id,identity,m.last_source_event_id,command]);
    await db.query(`insert into public.hivra_canonical_primary_bindings
      (id,user_id,computer_id,agent_identity_id,status,detached_at,source_event_id,write_authority,authority_generation,authority_command_id)
      values('77777777-7777-4777-8777-777777777777','owner',$1,$2,'detached',now(),$3,'canonical',2,$4)`,
      [m.computer_id,identity,m.last_source_event_id,command]);
    await db.query("update public.hivra_agents set name='Renamed computer' where id=$1",[source]);
    const after = await read();
    assert.equal(after.identities[0].id,identity);
    assert.equal(after.identities.length,1,'history deduplicates identities and excludes another owner');
    assert.equal(after.bindings.length,2,'reader includes relationship history, not only a primary mapping slot');
    assert.equal(after.installations.length,1);
    assert.equal(after.installations[0].id,installation);
    assert.equal(after.bindings[0].id,binding);
    assert.equal(after.installations[0].status,'installing');
    assert.equal(after.bindings[0].status,'detached');
    assert.equal(after.relationshipAuthority.writer,'canonical');
    assert.equal(after.relationshipAuthority.generation,'2');
    assert.equal(after.source.alias,`x-${source}`);
    assert.notEqual(after.lifecycle.sourceEventId,after.bindings[0].sourceEventId);
    assert.equal((await one('select agent_identity_id from public.hivra_canonical_source_mappings where source_id=$1',[source])).agent_identity_id,null,
      'reader must not require rewriting immutable launch provenance');
    await db.exec('set role service_role');
    assert.deepEqual(await read(),after);
    assert.equal(await read('different-owner'),null);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(()=>read(),{code:'42501'});
    await db.exec('reset role');
    if(process.argv.includes('--json')) console.log(JSON.stringify({before,after}));
    else console.log('PASS owner-scoped relationship reader preserves launch provenance and independent entity epochs');
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error.stack || String(error));process.exitCode=1;});
