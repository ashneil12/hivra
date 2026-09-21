// Isolated PostgreSQL/WASM verification. Synthetic ciphertext only; no env,
// network, live database, or production schema mutation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.user_api_keys(id uuid primary key,encrypted_key text,untouched text);
      create table public.hermes_instances(id uuid primary key,api_key_encrypted text,
        api_server_key_encrypted text,honcho_api_key_encrypted text,config jsonb,untouched text);
      create table public.hermes_conversations(id uuid primary key,title text,untouched text);
      create table public.hermes_messages(id uuid primary key,content text,tool_calls jsonb,
        attachments jsonb,artifacts jsonb,metadata jsonb,untouched text);
      create table public.infrastructure_connection_secrets(connection_id uuid primary key,
        encrypted_bundle text,key_version smallint);
      create table public.infrastructure_capacity_orders(id uuid primary key,encrypted_bootstrap_bundle text,untouched text);
      create table public.bankr_deposit_wallet_credentials(id uuid primary key,api_key_encrypted text,untouched text);
      create table public.instance_bankr_wallets(id uuid primary key,api_key_encrypted text,untouched text);
      create table public.hermes_chat_stream_jobs(id uuid primary key,stream_request jsonb,fallback_request jsonb,untouched text);
      create table public.hivra_agents(id uuid primary key,llm_api_key_encrypted text,status text,desired_state text);
      create table public.hivra_model_key_operations(operation_id uuid primary key,agent_id uuid,
        encrypted_key text,phase text,cipher_digest text,is_current boolean);
      grant all on all tables in schema public to service_role;`);
    const sql = fs.readFileSync(path.resolve(__dirname,
      "../supabase/migrations/20260829010000_legacy_encryption_rewrap_cas.sql"), "utf8");
    await db.exec(sql);
    await db.exec(fs.readFileSync(path.resolve(__dirname,
      "../supabase/migrations/20260830150000_complete_encryption_rotation_cas.sql"), "utf8"));
    const id = randomUUID();
    const call = (surface, expected, patch, rowId=id) => db.query(
      "select public.rewrap_legacy_encryption_row($1,$2,$3,$4) as result",
      [surface,rowId,expected,patch]).then(r => r.rows[0].result);
    await db.query("insert into public.user_api_keys values($1,'old','keep')",[id]);
    assert.equal(await call("user_api_keys",{encrypted_key:"old"},{encrypted_key:"new"}),true);
    assert.deepEqual((await db.query("select * from public.user_api_keys")).rows,
      [{id,encrypted_key:"new",untouched:"keep"}]);
    assert.equal(await call("user_api_keys",{encrypted_key:"old"},{encrypted_key:"stale"}),false);
    assert.equal(await call("user_api_keys",{encrypted_key:"new"},{encrypted_key:"bad",untouched:"overwrite"}),false);

    await db.query("insert into public.hermes_instances values($1,'a','b','c',$2,'keep')",
      [id,{agentSettings:{key:"old"},preference:"original"}]);
    const instanceExpected={api_key_encrypted:"a",api_server_key_encrypted:"b",honcho_api_key_encrypted:"c",
      config:{agentSettings:{key:"old"},preference:"original"}};
    await db.exec("update public.hermes_instances set config=config||'{\"preference\":\"concurrent\"}'::jsonb");
    assert.equal(await call("hermes_instances",instanceExpected,{config:{agentSettings:{key:"new"},preference:"original"}}),false);
    assert.equal((await db.query("select config->>'preference' preference from public.hermes_instances")).rows[0].preference,"concurrent");

    await db.query("insert into public.hermes_conversations values($1,'old','keep')",[id]);
    assert.equal(await call("hermes_conversations",{title:"old"},{title:"new"}),true);
    await db.query("insert into public.hermes_messages values($1,'old','[]','[]','[]','{}','keep')",[id]);
    const messageExpected={content:"old",tool_calls:[],attachments:[],artifacts:[],metadata:{}};
    assert.equal(await call("hermes_messages",messageExpected,{content:"new",metadata:{rotated:true}}),true);
    assert.equal((await db.query("select untouched from public.hermes_messages")).rows[0].untouched,"keep");

    const connection=randomUUID();
    await db.query("insert into public.infrastructure_connection_secrets values($1,'v2-old',2)",[connection]);
    const rotate=(version,bundle) => db.query(
      "select public.rotate_infrastructure_connection_secret($1,'v2-old',$2,$3) result",
      [connection,bundle,version]).then(r=>r.rows[0].result);
    assert.equal(await rotate(1,"downgraded"),false);
    assert.equal(await rotate(2,"v2-new"),true);
    assert.deepEqual((await db.query("select encrypted_bundle,key_version from public.infrastructure_connection_secrets")).rows,
      [{encrypted_bundle:"v2-new",key_version:2}]);

    const generic=(surface,rowId,expected,patch)=>db.query(
      "select public.rewrap_encryption_surface_v2($1,$2,$3,$4) result",
      [surface,rowId,expected,patch]).then(r=>r.rows[0].result);
    const stable=[
      ["infrastructure_capacity_orders","infrastructure_capacity_orders_bootstrap","encrypted_bootstrap_bundle"],
      ["bankr_deposit_wallet_credentials","bankr_deposit_wallet_credentials_key","api_key_encrypted"],
      ["instance_bankr_wallets","instance_bankr_wallets_key","api_key_encrypted"],
    ];
    for(const [table,surface,column] of stable) {
      const rowId=randomUUID();
      await db.query(`insert into public.${table}(id,${column},untouched) values($1,'old','keep')`,[rowId]);
      assert.equal(await generic(surface,rowId,{[column]:"old"},{[column]:"new"}),true);
      assert.deepEqual((await db.query(`select ${column},untouched from public.${table} where id=$1`,[rowId])).rows[0],
        {[column]:"new",untouched:"keep"});
      assert.equal(await generic(surface,rowId,{[column]:"old"},{[column]:"stale"}),false);
    }
    const job=randomUUID(),oldRequests={stream_request:{prompt:"old"},fallback_request:{prompt:"fallback"}};
    await db.query("insert into public.hermes_chat_stream_jobs values($1,$2,$3,'keep')",
      [job,oldRequests.stream_request,oldRequests.fallback_request]);
    assert.equal(await generic("hermes_chat_stream_jobs",job,oldRequests,{stream_request:{encrypted:"new"}}),true);
    assert.equal((await db.query("select untouched from public.hermes_chat_stream_jobs where id=$1",[job])).rows[0].untouched,"keep");
    assert.equal(await generic("hermes_chat_stream_jobs",job,oldRequests,{stream_request:{encrypted:"stale"}}),false);

    const agent=randomUUID(),operation=randomUUID();
    await db.query("insert into public.hivra_agents values($1,'old','running','running')",[agent]);
    await db.query("insert into public.hivra_model_key_operations values($1,$2,null,'applied',$3,true)",
      [operation,agent,require("node:crypto").createHash("sha256").update("old").digest("hex")]);
    const rotateAgent=(expected,replacement)=>db.query(
      "select public.rotate_hivra_agent_llm_secret($1,$2,$3) result",[agent,expected,replacement]).then(r=>r.rows[0].result);
    assert.equal(await rotateAgent("old","new"),true);
    assert.equal(await rotateAgent("old","stale"),false);
    assert.equal((await db.query("select llm_api_key_encrypted from public.hivra_agents where id=$1",[agent])).rows[0].llm_api_key_encrypted,"new");
    assert.equal((await db.query("select cipher_digest from public.hivra_model_key_operations where operation_id=$1",[operation])).rows[0].cipher_digest,
      require("node:crypto").createHash("sha256").update("new").digest("hex"));

    await db.exec("set role authenticated");
    await assert.rejects(() => call("user_api_keys",{encrypted_key:"new"},{encrypted_key:"forbidden"}),
      error => error.code === "42501");
    await assert.rejects(() => generic("bankr_deposit_wallet_credentials_key",randomUUID(),{api_key_encrypted:"old"},{api_key_encrypted:"forbidden"}),
      error => error.code === "42501");
    console.log("PASS encryption rewrap CAS: strict stable surfaces, journal-coupled agent secret, complete body fences, unrelated-field preservation, schema-version preservation, grants");
  } finally { await db.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
