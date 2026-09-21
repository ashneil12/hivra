// Exercise the actual TypeScript coordinator/store/transport against PostgreSQL
// and the actual guest record. All keys, wallets, HTTP responses and rows are
// synthetic. No environment files, external network or provider operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const ts = require('typescript');
const { PGlite } = require('@electric-sql/pglite');
const { createLlmApplicationStore } = require('../provisioner/hivra-chat/llm-application.js');

const dashboard = path.resolve(__dirname, '..');
// Only unused production integrations are stubbed. Safety validation, payload
// canonicalization, SQL, owner filters and transport logic are real source.
const unavailable = () => { throw new Error('Unexpected production integration in isolated fixture'); };
const stubs = new Map([
  ['server-only', {}], ['@/lib/supabase', { supabaseAdmin: null }],
  ['@/lib/crypto', { encryptSecret: unavailable, decryptSecret: unavailable }],
  ['@/lib/ssrf-safe-fetch', { ssrfSafeFetch: unavailable }],
  ['@/lib/billing/managed-venice-wallets', { ensureManagedVeniceWalletAccount: unavailable }],
  ['@/lib/venice/proxy-keys', { generateManagedVenicePlaintextKey: unavailable, hashManagedVeniceProxyKey: unavailable }],
  ['@/lib/venice/managed-venice-starter-credit', { grantManagedVeniceStarterCredit: unavailable, isManagedVeniceStarterCreditEnabled: unavailable }],
  ['@/lib/venice/managed-endpoints', { getManagedVeniceProxyBaseUrl: unavailable }],
  ['@/lib/logger', { log: { warn: unavailable } }],
]);
const loaded = new Map();
function load(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const compiledModule = { exports: {} }; loaded.set(file, compiledModule);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = id => {
    if (stubs.has(id)) return stubs.get(id);
    if (id.startsWith('@/')) return load(path.join(dashboard, 'src', id.slice(2) + '.ts'));
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
    return require(id);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)(localRequire, compiledModule, compiledModule.exports, file, path.dirname(file));
  return compiledModule.exports;
}

async function main() {
  const db = new PGlite();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hivra-model-coordinator-'));
  let checks = 0;
  const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;`);
    const dir = path.join(dashboard, 'supabase/migrations');
    const migration = name => fs.readFileSync(path.join(dir, name), 'utf8');
    const wallet = migration('20260512180000_managed_venice_wallets.sql');
    for (const table of ['managed_venice_wallet_accounts', 'managed_venice_proxy_keys']) {
      const ddl = wallet.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(ddl); await db.exec(ddl[0]);
    }
    await db.exec(migration('20260605120000_hivra_agents.sql'));
    await db.exec(migration('20260607130000_hivra_agent_half_cpu.sql'));
    await db.exec('alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text');
    const pools=migration('20260605130000_pools_and_agent_type.sql');
    await db.exec(pools.match(/create table if not exists public\.pools \([\s\S]*?\n\);/)[0]);
    await db.exec(pools.match(/alter table public\.hivra_agents[^;]+;/)[0]);
    await db.exec(migration('20260606120000_hivra_agent_bootstrap.sql'));
    await db.exec(migration('20260612190000_hivra_agents_managed_venice.sql'));
    for(const statement of migration('20260613193000_agent_template_skills.sql').matchAll(/alter table public\.hivra_agents[^;]+;/g)) await db.exec(statement[0]);
    for (const file of fs.readdirSync(dir).filter(name => /^2026082[5678]/.test(name)).sort()) await db.exec(migration(file));
    await db.exec(migration('20260830132000_launch_fingerprint_key_separation.sql'));
    await db.exec(migration('20260905140000_managed_provisioner_channels.sql'));
    const id = randomUUID(), token = 'a'.repeat(64), accountId = randomUUID();
    await db.query("insert into public.managed_venice_wallet_accounts(id,user_id) values($1,'owner')", [accountId]);
    await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,vmid,api_token,cf_hostname,cf_tunnel_id,chat_url)
      values($1,'owner','codex','Fixture','running','running',501,$2,'computer.hivra.test','fixture-tunnel','https://computer.hivra.test')`, [id, token]);
    await db.exec('set role service_role');
    // A small PostgREST adapter for the actual store's select/filter/RPC calls.
    // SQL identifiers are strictly allowlisted; values remain bound parameters.
    const identifier = name => { assert.match(name, /^[a-z_]+$/); return '"' + name + '"'; };
    let loseAdmission = false, loseSettlement = false, loseReservation = false, losePromotion = false, rpcCalls = [];
    const client = {
      from(table) {
        assert.ok(['hivra_agents', 'hivra_model_key_operations', 'hivra_launch_model_requests'].includes(table));
        let columns, filters = [];
        const query = {
          select(value) { columns = value.split(',').map(identifier).join(','); return query; },
          eq(column, value) { filters.push([identifier(column), value]); return query; },
          async maybeSingle() {
            try {
              const result = await db.query(`select ${columns} from public.${identifier(table)} where ${filters.map(([column], i) => `${column}=$${i+1}`).join(' and ')}`, filters.map(([,value]) => value));
              // PostgREST is JSON: timestamps arrive as ISO strings, unlike
              // PGlite's direct Date values. Preserve that actual wire shape.
              assert.ok(result.rows.length <= 1); return { data: JSON.parse(JSON.stringify(result.rows[0] ?? null)), error: null };
            } catch (error) { return { data: null, error }; }
          },
        };
        return query;
      },
      async rpc(name, args) {
        const parameters = {
          admit_hivra_model_key_operation: ['p_user_id', 'p_agent_id', 'p_operation_id', 'p_binding', 'p_request'],
          claim_hivra_model_key_delivery: ['p_user_id', 'p_agent_id', 'p_operation_id'],
          settle_hivra_model_key_operation: ['p_user_id', 'p_agent_id', 'p_operation_id', 'p_lease_id', 'p_receipt'],
          reserve_hivra_launch_model_request: ['p_user_id','p_request_id','p_fingerprints','p_model_operation_id','p_agent','p_selection','p_encrypted_key'],
          claim_hivra_launch_model_attempt: ['p_user_id','p_agent_id','p_request_id','p_automatic'],
          promote_hivra_launch_model_request: ['p_user_id','p_agent_id','p_request_id','p_attempt_id','p_binding','p_request'],
          cancel_hivra_launch_model_request: ['p_user_id','p_agent_id','p_request_id'],
        }[name];
        assert.ok(parameters); equal(Object.keys(args), parameters); rpcCalls.push(name);
        try {
          const result = await db.query(`select public.${identifier(name)}(${parameters.map((_,i) => '$'+(i+1)).join(',')}) as result`, parameters.map(key => args[key]));
          if (name === 'admit_hivra_model_key_operation' && loseAdmission) { loseAdmission = false; throw new Error('Synthetic lost admission reply'); }
          if (name === 'settle_hivra_model_key_operation' && loseSettlement) { loseSettlement = false; throw new Error('Synthetic lost settlement reply'); }
          if (name === 'reserve_hivra_launch_model_request' && loseReservation) { loseReservation = false; throw new Error('Synthetic lost reservation reply'); }
          if (name === 'promote_hivra_launch_model_request' && losePromotion) { losePromotion = false; throw new Error('Synthetic lost promotion reply'); }
          return { data: result.rows[0].result, error: null };
        } catch (error) { return { data: null, error }; }
      },
    };
    const { createModelKeyStore, modelKeyBinding } = load(path.join(dashboard, 'src/lib/hivra/model-key-store.ts'));
    const { createModelKeyCoordinator } = load(path.join(dashboard, 'src/lib/hivra/model-key-coordinator.ts'));
    const { inspectGuestLlmApplication, applyGuestLlmApplication } = load(path.join(dashboard, 'src/lib/hivra/guest-llm-transport.ts'));
    const store = createModelKeyStore(client);
    const original = await store.agent('owner', id);
    equal(modelKeyBinding(original), (await db.query('select public.hivra_model_key_binding(a) as binding from public.hivra_agents a where id=$1', [id])).rows[0].binding);
    const directory = path.join(root, 'guest');
    let guest = createLlmApplicationStore({ directory, apiToken: token, runtime: 'codex' });
    let posts = 0, candidates = 0, loseGuestReply = false, guestSupported = true;
    const fetcher = async (url, init) => {
      equal(new URL(url).origin, 'https://computer.hivra.test');
      if (url.endsWith('/api/meta')) return Response.json({ agentKind: 'codex', surfaceAuth: 'post-cookie-v1', ...(guestSupported ? { llmApplication: 'hivra-llm-apply-v1' } : {}) });
      equal(new URL(url).pathname, '/api/llm/application');
      if (!init.headers.Authorization) return Response.json({ error: 'unauthorized' }, { status: 401 });
      equal(init.headers.Authorization, 'Bearer ' + token);
      if (init.method === 'POST') {
        posts++; const receipt = guest.apply(JSON.parse(init.body));
        if (loseGuestReply) { loseGuestReply = false; throw new Error('Synthetic lost guest reply'); }
        return Response.json({ ok: true, ...receipt }, { headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json({ ok: true, ...guest.inspect() }, { headers: { 'Cache-Control': 'no-store' } });
    };
    const encryptionKey = Buffer.alloc(32, 7);
    const encrypt = text => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    };
    const decrypt = text => {
      const buffer = Buffer.from(text, 'base64'), decipher = createDecipheriv('aes-256-gcm', encryptionKey, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    };
    const deps = { store, encrypt, decrypt,
      inspect: target => inspectGuestLlmApplication(target, fetcher),
      deliver: (input, signal) => applyGuestLlmApplication(input, fetcher, signal),
      managedBaseUrl: () => 'https://dashboard.hivra.test/api/managed-venice/v1',
      prepareManaged: async () => {
        candidates++; const plaintext = 'hven_live_fixture_' + randomUUID().replaceAll('-', '');
        return { plaintext, encryptedKey: encrypt(plaintext), record: { id: randomUUID(), accountId,
          hash: createHash('sha256').update(plaintext).digest('hex'), prefix: plaintext.slice(0, 14) } };
      },
    };
    let coordinator = createModelKeyCoordinator(deps);
    const start = (operation, selection) => coordinator.start('owner', id, operation, selection);
    const summary = () => coordinator.summary('owner', id);
    const statuses = async () => (await db.query('select status from public.managed_venice_proxy_keys order by created_at')).rows.map(row => row.status);
    const managed = { provider: 'venice', mode: 'managed', model: 'fixture-model', walletType: 'card' };
    const first = randomUUID();
    equal(await start(first, managed), { operationId: first, status: 'applied' });
    equal(await statuses(), ['active']); equal(posts, 1); equal(candidates, 1);
    equal((await summary()).llm.walletType, 'card');
    equal((await store.operation('owner', id, first)).encrypted_key, null);
    const second = randomUUID(); loseGuestReply = true;
    equal(await start(second, managed), { operationId: second, status: 'pending', reason: 'delivery_unconfirmed' });
    equal(await statuses(), ['active', 'paused']); equal(posts, 2); equal(candidates, 2);
    equal((await summary()).pending.operationId, second);
    const oldSummary = (await summary()).llm;
    // Restart both caller and guest. The durable same-op record must be read,
    // not posted again, after the genuine DB-clock delivery lease expires.
    coordinator = createModelKeyCoordinator({ ...deps, managedBaseUrl: unavailable, prepareManaged: unavailable });
    guest = createLlmApplicationStore({ directory, apiToken: token, runtime: 'codex' });
    equal(await coordinator.resume('owner', id, second), { operationId: second, status: 'pending', reason: 'computer_busy' });
    equal((await summary()).llm, oldSummary);
    const lease = await store.operation('owner', id, second);
    const remaining = Date.parse(lease.lease_expires_at) - Date.now() + 100;
    assert.ok(remaining > 0 && remaining < 21_000);
    await new Promise(resolve => setTimeout(resolve, remaining));
    equal(await coordinator.resume('owner', id, second), { operationId: second, status: 'applied' });
    equal(await statuses(), ['revoked', 'active']); equal(posts, 2); equal(candidates, 2);
    // Lost DB acknowledgement AFTER actual commit must reconcile current state,
    // not deliver again or revoke the now-active credential.
    coordinator = createModelKeyCoordinator(deps);
    const third = randomUUID(); loseSettlement = true;
    equal(await start(third, { provider: 'venice', mode: 'byok', apiKey: 'synthetic-owner-key', model: 'fixture-model' }),
      { operationId: third, status: 'pending', reason: 'settlement_unconfirmed' });
    equal(await statuses(), ['revoked', 'revoked']); equal(posts, 3);
    equal(await coordinator.resume('owner', id, third), { operationId: third, status: 'applied' });
    equal(posts, 3); equal((await summary()).llm.mode, 'byok');
    // Admission uncertainty can be discovered and resumed with no browser key.
    const clear = randomUUID(); loseAdmission = true;
    await assert.rejects(() => start(clear, null), error => error.code === 'save_unconfirmed'); checks++;
    equal(posts, 3); equal((await summary()).pending.requested, null);
    equal(await coordinator.resume('owner', id, clear), { operationId: clear, status: 'applied' });
    equal(posts, 4); equal(guest.readProvider(), null); equal((await summary()).llm, null);
    await assert.rejects(() => coordinator.resume('owner', id, first), error => error.code === 'operation_conflict'); checks++;
    await assert.rejects(() => coordinator.summary('foreign', id), error => error.code === 'not_found'); checks++;
    equal((await db.query('select count(*)::int as count from public.managed_venice_proxy_keys')).rows[0].count, 2);
    equal((await db.query('select count(*)::int as count from public.hivra_model_key_operations where encrypted_key is not null')).rows[0].count, 0);
    assert.ok(!JSON.stringify(await summary()).includes('synthetic')); checks++;
    console.log(`PASS model-key coordinator integration: ${checks} assertions; real source, PostgreSQL service role, guest receipt/restart, lost guest/admission/settlement replies, replacement and clear`);

    // The original launch now has separate pre-readiness custody, but still
    // uses the SAME coordinator, transport, journal and guest application.
    const { createLaunchModelStore, launchModelFingerprints } = load(path.join(dashboard,'src/lib/hivra/launch-model-store.ts'));
    const { createLaunchModelCoordinator } = load(path.join(dashboard,'src/lib/hivra/launch-model-coordinator.ts'));
    const launches=createLaunchModelStore(client), launchCoordinator=createLaunchModelCoordinator({...deps,launches});
    let vmid=601;
    function launchFixture(llm={provider:'venice',mode:'byok',apiKey:'synthetic-launch-key',model:'fixture-model'}) {
      const requestId=randomUUID(),agentId=randomUUID(),provisionId=randomUUID(),modelId=randomUUID();
      const intent={type:'codex',name:'Launch fixture',cpu:0.5,ram:1,browser:false,goal:null,context:null,personality:null,emoji:null,
        templateSkills:[],deployment:{mode:'hivra-managed'},llm};
      const fingerprints=launchModelFingerprints('owner',requestId,intent,[encryptionKey]);
      const reservation={id:agentId,type:'codex',name:intent.name,cpu:intent.cpu,ram:intent.ram,proxmox_host:'fixture-host',
        deployment_mode:'hivra-managed',computer_substrate:'proxmox-kvm',operation_id:provisionId,infrastructure_binding_token_hash:'c'.repeat(64)};
      reservation.managed_provisioner_channel='default';
      return {requestId,agentId,provisionId,modelId,intent,fingerprints,
        input:{userId:'owner',requestId,modelOperationId:modelId,fingerprints,agent:reservation,llm}};
    }
    async function launchReady(f) {
      await db.query("select public.persist_hivra_agent_provision_identity('owner',$1,$2,$3,'10.240.0.4')",[f.agentId,f.provisionId,vmid++]);
      await db.query("update public.hivra_agents set api_token=$2,cf_hostname='computer.hivra.test',cf_tunnel_id='fixture-tunnel',chat_url='https://computer.hivra.test' where id=$1",[f.agentId,token]);
      await db.query("select public.complete_hivra_agent_operation('owner',$1,$2,'running','running',null,null)",[f.agentId,f.provisionId]);
      guest=createLlmApplicationStore({directory:path.join(root,f.agentId),apiToken:token,runtime:'codex'});
    }
    const launchByok=launchFixture();
    loseReservation=true;
    equal(await launches.reserve(launchByok.input,encrypt),{created:false,agentId:launchByok.agentId,phase:'waiting'});
    const retained=await launches.byRequest('owner',launchByok.requestId), beforePosts=posts, beforeCandidates=candidates;
    equal((await launchCoordinator.summary('owner',launchByok.agentId)).state,'waiting_for_computer');
    equal(await launchCoordinator.continue('owner',launchByok.agentId,launchByok.requestId,true),
      {requestId:launchByok.requestId,operationId:launchByok.modelId,status:'waiting',reason:'computer_not_ready'});
    equal(posts,beforePosts); equal(candidates,beforeCandidates);
    equal((await store.agent('owner',launchByok.agentId)).llm_config,null);
    assert.ok(!JSON.stringify(await launchCoordinator.summary('owner',launchByok.agentId)).includes('synthetic-launch-key'));checks++;
    await assert.rejects(()=>launchCoordinator.assertNoPendingLaunch('owner',launchByok.agentId),e=>e.code==='pending_change');checks++;
    await launchReady(launchByok);
    equal((await launchCoordinator.summary('owner',launchByok.agentId)).state,'ready_to_apply');
    equal(await launchCoordinator.continue('owner',launchByok.agentId,launchByok.requestId,true),
      {requestId:launchByok.requestId,operationId:launchByok.modelId,status:'applied'});
    equal(posts,beforePosts+1); equal(candidates,beforeCandidates);
    equal((await store.agent('owner',launchByok.agentId)).llm_api_key_encrypted,retained.encrypted_key);
    equal((await launches.byRequest('owner',launchByok.requestId)).encrypted_key,null);
    equal(await launchCoordinator.summary('owner',launchByok.agentId),null);
    equal((await launchCoordinator.continue('owner',launchByok.agentId,launchByok.requestId,true)).status,'applied');
    equal(posts,beforePosts+1);
    equal((await launches.reserve({...launchByok.input,agent:{...launchByok.input.agent,id:randomUUID()}},encrypt)).created,false);
    equal((await launches.existing('owner',launchByok.requestId,launchByok.fingerprints)).agent_id,launchByok.agentId);

    const launchManaged=launchFixture(managed); await launches.reserve(launchManaged.input,encrypt); await launchReady(launchManaged);
    const managedPosts=posts, managedCandidates=candidates; losePromotion=true;
    await assert.rejects(()=>launchCoordinator.continue('owner',launchManaged.agentId,launchManaged.requestId,true),e=>e.code==='save_unconfirmed');checks++;
    equal(posts,managedPosts); equal(candidates,managedCandidates+1);
    equal((await launches.byAgent('owner',launchManaged.agentId)).phase,'promoted');
    equal((await store.agent('owner',launchManaged.agentId)).llm_config,null);
    equal((await statuses()).at(-1),'paused');
    equal(await launchCoordinator.continue('owner',launchManaged.agentId,launchManaged.requestId,true),
      {requestId:launchManaged.requestId,operationId:launchManaged.modelId,status:'pending',reason:'resume_required'});
    equal(posts,managedPosts); equal(candidates,managedCandidates+1);
    // A new process may resume without the original key, provider config or a
    // minting dependency. Recovery uses only the persisted original journal.
    const restarted=createLaunchModelCoordinator({...deps,launches,prepareManaged:unavailable,managedBaseUrl:unavailable});
    equal(await restarted.continue('owner',launchManaged.agentId,launchManaged.requestId,false),
      {requestId:launchManaged.requestId,operationId:launchManaged.modelId,status:'applied'});
    equal(posts,managedPosts+1); equal(candidates,managedCandidates+1); equal((await statuses()).at(-1),'active');

    const unsupported=launchFixture(managed); await launches.reserve(unsupported.input,encrypt); await launchReady(unsupported);
    const untouchedCandidates=candidates; guestSupported=false;
    await assert.rejects(()=>launchCoordinator.continue('owner',unsupported.agentId,unsupported.requestId,true),e=>e.code==='guest_upgrade_required');checks++;
    equal(candidates,untouchedCandidates); equal((await launches.byAgent('owner',unsupported.agentId)).phase,'waiting');
    guestSupported=true;
    equal((await launchCoordinator.continue('owner',unsupported.agentId,unsupported.requestId,true)).status,'waiting');
    equal(candidates,untouchedCandidates);
    equal(await launchCoordinator.cancel('owner',unsupported.agentId,unsupported.requestId),{requestId:unsupported.requestId,status:'cancelled'});
    equal((await launches.byAgent('owner',unsupported.agentId)).encrypted_key,null);
    await assert.rejects(()=>launchCoordinator.continue('owner',unsupported.agentId,unsupported.requestId,false),e=>e.code==='operation_conflict');checks++;
    await assert.rejects(()=>launchCoordinator.continue('foreign',launchManaged.agentId,launchManaged.requestId,false),e=>e.code==='not_found');checks++;
    console.log(`PASS launch model integration: ${checks} assertions; actual reservation, readiness, encrypted custody, guest application, lost reservation/promotion replies, no automatic redelivery, explicit recovery and cancellation`);
    console.log(`PASS model-key coordinator teardown: ${rpcCalls.length} scoped RPC calls, ${posts} guest writes, ${candidates} candidates; synthetic resources only`);
  } finally {
    await db.close(); fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
