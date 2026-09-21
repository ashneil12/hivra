// Opt-in real PostgreSQL sessions. Uses only an already-present image, no
// network, host ports, host mounts, credentials, or persistent database volume.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { migration, legacySchema } = require('./lib/canonical-postgres-fixture.cjs');

function cleanupOwnedContainer(docker, name, owner) {
  const id = docker(['ps','--all','--no-trunc','--quiet','--filter',`name=^/${name}$`]);
  if (!id) return;
  assert.match(id, /^[a-f0-9]{64}$/, 'exactly one full container ID required');
  assert.equal(docker(['inspect',id,'--format','{{index .Config.Labels "hivra.test.owner"}}']), owner);
  docker(['stop','--time','3',id]);
  // --rm is not triggered for a created-but-never-started container. Remove
  // only this already owner-validated ID; non-force rm refuses a running race.
  if (docker(['ps','--all','--quiet','--filter',`id=${id}`])) docker(['rm',id]);
  assert.equal(docker(['ps','--all','--quiet','--filter',`id=${id}`]), '');
}

async function main(runDocker) {
  const owner = randomUUID();
  const name = `hivra-authority-${owner}`;
  const docker = runDocker || (args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000 }).trim());
  const image = docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const sessions = [];
  let attempted = false;
  function session(label) {
    const app = `${owner}-${label}`;
    const child = spawn('docker', ['exec','-e',`PGAPPNAME=${app}`,'-i',name,
      'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres']);
    let pending = null, output = '', errors = '', exited = false;
    child.stdout.on('data', data => {
      output += data;
      if (pending && output.includes(`${pending.marker}\n`)) {
        const result = output.slice(0, output.indexOf(`${pending.marker}\n`)).trim();
        output = output.slice(output.indexOf(`${pending.marker}\n`) + pending.marker.length + 1);
        clearTimeout(pending.timer);
        const resolve = pending.resolve;
        pending = null;
        resolve(result);
      }
    });
    child.stderr.on('data', data => { errors += data; });
    child.stdin.on('error', error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending=null; } });
    child.on('error', error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending=null; } });
    child.on('exit', code => {
      exited = true;
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error(`psql ${label} exited ${code}: ${errors}`)); pending=null; }
    });
    const s = { app, child, run(sql) {
      assert.equal(exited, false, 'session must be live');
      assert.equal(pending, null, 'one query per session');
      return new Promise((resolve,reject) => {
        const marker = `DONE_${randomUUID().replaceAll('-','')}`;
        const timer = setTimeout(() => { pending=null; reject(new Error(`session ${label} exceeded 12s`)); },12_000);
        pending = { marker, resolve, reject, timer };
        child.stdin.write(`${sql};\n\\echo ${marker}\n`);
      });
    }};
    sessions.push(s);
    return s;
  }
  try {
    // A failed acknowledgement does not prove creation failed. Reconcile the
    // exact name and immutable owner label even when docker run throws.
    attempted = true;
    docker(['run','--detach','--rm','--name',name,'--label',`hivra.test.owner=${owner}`,
      '--network','none','--memory','256m','--cpus','1','--pids-limit','128',
      '--tmpfs','/var/lib/postgresql/data:rw,size=256m',
      '-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);
    const deadline = Date.now()+15_000;
    while (true) {
      try {
        // initdb starts a temporary server which pg_isready also accepts.
        // Wait for the final PID 1 postgres, not that about-to-restart server.
        if (docker(['exec',name,'cat','/proc/1/comm']) === 'postgres') {
          docker(['exec',name,'pg_isready','-U','postgres']); break;
        }
        if (Date.now()>deadline) throw new Error('final PostgreSQL process did not start');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      catch (error) { if (Date.now()>deadline) throw error; await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    const observer = session('observe');
    const initial = session('holder');
    const files = ['20260904100000_hivra_canonical_resource_shadow.sql',
      '20260906150000_hivra_canonical_binding_provenance.sql',
      '20260906160000_hivra_canonical_parity_coverage.sql',
      '20260906170000_hivra_canonical_relationship_authority.sql'];
    await observer.run(legacySchema+'\n'+files.map(migration).join('\n'));
    await observer.run(`insert into public.hivra_agents(id,user_id,name,status,desired_state,type,computer_profile)
      values('11111111-1111-4111-8111-111111111111','owner','Ubuntu','running','running','linux-desktop','ubuntu-desktop'),
      ('22222222-2222-4222-8222-222222222222','owner','Other Ubuntu','running','running','linux-desktop','ubuntu-desktop')`);
    const rows = JSON.parse(await observer.run(`select json_agg(m order by source_id) from public.hivra_canonical_source_mappings m`));
    const transfer = (row,id) => `select public.transfer_hivra_canonical_relationship_authority('owner','${row.computer_id}',${row.last_source_event_id},1,'${id}')`;
    const command = '33333333-3333-4333-8333-333333333333';
    const settled = promise => promise.then(value=>({value}), error=>({error}));
    const value = result => { if (result.error) throw result.error; return result.value; };
    async function locked(s) {
      const end = Date.now()+3_000;
      while (Date.now()<end) {
        if (await observer.run(`select exists(select 1 from pg_stat_activity where application_name='${s.app}' and wait_event_type='Lock')`) === 't') return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('expected a live PostgreSQL lock waiter');
    }
    // Read mode wins first: transfer waits, observes shadow and makes no write.
    await initial.run("begin; select public.set_hivra_canonical_inventory_read_mode('shadow')");
    const waiter = session('transfer');
    const refused = settled(waiter.run(transfer(rows[0],command)));
    await locked(waiter);
    await initial.run('commit');
    assert.equal(value(await refused), '');
    assert.equal(await observer.run('select count(*) from public.hivra_canonical_authority_commands'), '0');
    await observer.run("select public.set_hivra_canonical_inventory_read_mode('legacy')");
    // Transfer wins first: replay returns the same receipt; the obsolete read
    // switch waits then rejects. Catch expected process rejection immediately.
    await initial.run('begin; '+transfer(rows[0],command));
    const replay = settled(waiter.run(transfer(rows[0],command)));
    const reader = session('reader');
    const readFailure = reader.run("select public.set_hivra_canonical_inventory_read_mode('shadow')")
      .then(value=>({value}), error=>({error}));
    await locked(waiter);
    await locked(reader);
    await initial.run('commit');
    assert.equal(JSON.parse(value(await replay)).resumed, true);
    assert.match((await readFailure).error?.message || '', /parity gate is not ready/);
    assert.equal(await observer.run('select count(*) from public.hivra_canonical_authority_outbox'), '1');
    // A committed legacy source update makes a queued transfer's expected
    // event stale. Neither command nor authority may be partially installed.
    await initial.run(`begin; update public.hivra_agents set name='Changed while transfer waits' where id='${rows[1].source_id}'`);
    const stale = settled(waiter.run(transfer(rows[1],'44444444-4444-4444-8444-444444444444')));
    await locked(waiter);
    await initial.run('commit');
    assert.equal(value(await stale), '');
    assert.equal(await observer.run(`select write_authority from public.hivra_canonical_relationship_authority where computer_id='${rows[1].computer_id}'`), 'legacy');
    assert.equal(await observer.run('select count(*) from public.hivra_canonical_authority_commands'), '1');
    console.log(`PASS real PostgreSQL lock contention, exact replay, read-switch serialization and stale legacy source; image ${image}`);
  } finally {
    for (const s of sessions) s.child.stdin.end();
    if (attempted) {
      cleanupOwnedContainer(docker,name,owner);
      console.log(`${runDocker ? 'SIMULATED cleanup' : 'CLEANUP verified'}: owned container absent; tmpfs database removed; no host ports or persistent volumes`);
    }
  }
}
if (require.main === module) main().catch(error=>{ console.error(error); process.exitCode=1; });
module.exports = { cleanupOwnedContainer, main };
