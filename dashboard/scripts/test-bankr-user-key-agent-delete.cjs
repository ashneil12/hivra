// Apply the real agent-wallet migrations on top of the base agent tables, in
// PostgreSQL/WASM, and check that an agent reaching its terminal soft delete
// (hivra_agents.status or hermes_instances.status = 'deleted') drops Hivra's
// copy of a key the user connected from their own Bankr account, while a
// Hivra-provisioned wallet row keeps its key so its funds can still be
// withdrawn. Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const APPLY = [
  "20260325000003_hermes_instances.sql",
  "20260502123000_instance_bankr_wallets.sql",
  "20260605120000_hivra_agents.sql",
  "20260611123000_instance_bankr_wallets_hivra_owner.sql",
  "20260924090000_drop_user_bankr_key_on_agent_delete.sql",
];
const USER_CONNECTED = "user_owned_bankr_account";
const PROVISIONED = "bankr_custodied_agent_wallet";

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    `);
    for (const name of APPLY) {
      // gen_random_uuid() is built in; PGlite ships without pgcrypto.
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*pgcrypto[^;]*;/i, ""));
    }

    let seq = 0;
    const address = () => `0x${String(++seq).padStart(40, "0")}`;
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const newInstance = async (status = "running") =>
      (await one("insert into public.hermes_instances(user_id,name,status) values('owner','h',$1) returning id", [status])).id;
    const newHivraAgent = async (status = "running") =>
      (await one("insert into public.hivra_agents(user_id,type,name,status) values('owner','codex','a',$1) returning id", [status])).id;
    const newWallet = async (column, ownerId, custodyModel) =>
      (
        await one(
          `insert into public.instance_bankr_wallets(${column},user_id,bankr_wallet_id,evm_address,api_key_encrypted,api_key_preview,api_key_status,status,metadata)
           values($1,'owner',$2,$3,'sealed-key-fixture','bk_…1234','active','active',jsonb_build_object('custodyModel',$4::text))
           returning id`,
          [ownerId, custodyModel === USER_CONNECTED ? `user:${seq}` : `wallet_${seq}`, address(), custodyModel]
        )
      ).id;
    const wallet = (id) => one("select * from public.instance_bankr_wallets where id=$1", [id]);
    const assertDropped = async (id, lane) => {
      const row = await wallet(id);
      assert.equal(row.api_key_encrypted, null, `${lane}: encrypted user key dropped`);
      assert.equal(row.api_key_preview, null, `${lane}: key preview dropped`);
      assert.equal(row.api_key_status, "revoked", `${lane}: api_key_status revoked`);
      assert.equal(row.status, "revoked", `${lane}: status revoked`);
      assert.equal(row.metadata.custodyModel, USER_CONNECTED, `${lane}: custody model kept`);
      assert.equal(row.metadata.disconnectReason, "agent_deleted", `${lane}: reason recorded`);
      assert.ok(row.metadata.disconnectedAt, `${lane}: disconnectedAt recorded`);
      return row;
    };
    const assertKept = async (id, lane) => {
      const row = await wallet(id);
      assert.equal(row.api_key_encrypted, "sealed-key-fixture", `${lane}: key kept`);
      assert.equal(row.api_key_status, "active", `${lane}: api_key_status kept`);
      assert.equal(row.status, "active", `${lane}: status kept`);
      assert.equal(row.metadata.disconnectReason, undefined, `${lane}: untouched`);
    };

    for (const lane of [
      { name: "hermes", table: "hermes_instances", column: "instance_id", create: newInstance },
      { name: "hivra", table: "hivra_agents", column: "hivra_agent_id", create: newHivraAgent },
    ]) {
      // A user-connected wallet loses Hivra's copy of its key on terminal delete.
      const connectedOwner = await lane.create();
      const connected = await newWallet(lane.column, connectedOwner, USER_CONNECTED);
      await db.query(`update public.${lane.table} set status='stopped' where id=$1`, [connectedOwner]);
      await assertKept(connected, `${lane.name} stop`);
      await db.query(`update public.${lane.table} set status='deleted' where id=$1`, [connectedOwner]);
      const dropped = await assertDropped(connected, lane.name);

      // A repeated terminal write leaves the first disconnect stamp alone.
      await db.query(`update public.${lane.table} set status='deleted' where id=$1`, [connectedOwner]);
      assert.equal((await wallet(connected)).metadata.disconnectedAt, dropped.metadata.disconnectedAt);

      // A Hivra-provisioned wallet keeps its key: funds may still need withdrawing.
      const provisionedOwner = await lane.create();
      const provisioned = await newWallet(lane.column, provisionedOwner, PROVISIONED);
      await db.query(`update public.${lane.table} set status='deleted' where id=$1`, [provisionedOwner]);
      await assertKept(provisioned, `${lane.name} provisioned`);

      // Deleting one agent never touches another agent's connected key.
      const otherOwner = await lane.create();
      const other = await newWallet(lane.column, otherOwner, USER_CONNECTED);
      const deletedOwner = await lane.create();
      await newWallet(lane.column, deletedOwner, USER_CONNECTED);
      await db.query(`update public.${lane.table} set status='deleted' where id=$1`, [deletedOwner]);
      await assertKept(other, `${lane.name} other agent`);
    }

    // Best effort: a failing wallet cleanup must never block the agent delete.
    const blockedOwner = await newHivraAgent();
    await newWallet("hivra_agent_id", blockedOwner, USER_CONNECTED);
    await db.exec(`
      create function public.fixture_reject_wallet_update() returns trigger language plpgsql as $$
      begin raise exception 'fixture wallet write failure'; end; $$;
      create trigger fixture_reject_wallet_update before update on public.instance_bankr_wallets
        for each row execute function public.fixture_reject_wallet_update();
    `);
    await db.query("update public.hivra_agents set status='deleted' where id=$1", [blockedOwner]);
    assert.equal((await one("select status from public.hivra_agents where id=$1", [blockedOwner])).status, "deleted");
    const blockedHermes = await newInstance();
    await newWallet("instance_id", blockedHermes, USER_CONNECTED);
    await db.query("update public.hermes_instances set status='deleted' where id=$1", [blockedHermes]);
    assert.equal((await one("select status from public.hermes_instances where id=$1", [blockedHermes])).status, "deleted");
    await db.exec("drop trigger fixture_reject_wallet_update on public.instance_bankr_wallets");

    // The trigger function is not callable by the API roles.
    const fn = "public.drop_user_bankr_key_after_agent_delete()";
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { allowed } = await one("select has_function_privilege($2, $1, 'EXECUTE') as allowed", [fn, role]);
      assert.equal(allowed, false, `${role} cannot execute ${fn}`);
    }
    const { granted } = await one(
      "select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0) as granted",
      [fn]
    );
    assert.equal(granted, false, `PUBLIC cannot execute ${fn}`);

    // The migration's backfill drops keys already left behind by earlier deletes.
    await db.exec("drop trigger drop_user_bankr_key_after_hivra_agent_delete on public.hivra_agents");
    await db.exec("drop trigger drop_user_bankr_key_after_hermes_instance_delete on public.hermes_instances");
    const staleHivra = await newHivraAgent();
    const staleHivraWallet = await newWallet("hivra_agent_id", staleHivra, USER_CONNECTED);
    const staleHermes = await newInstance();
    const staleHermesWallet = await newWallet("instance_id", staleHermes, USER_CONNECTED);
    const staleProvisionedOwner = await newInstance();
    const staleProvisioned = await newWallet("instance_id", staleProvisionedOwner, PROVISIONED);
    await db.query("update public.hivra_agents set status='deleted' where id=$1", [staleHivra]);
    await db.query("update public.hermes_instances set status='deleted' where id in ($1,$2)", [staleHermes, staleProvisionedOwner]);
    await assertKept(staleHivraWallet, "stale before backfill");
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, APPLY[APPLY.length - 1]), "utf8"));
    await assertDropped(staleHivraWallet, "hivra backfill");
    await assertDropped(staleHermesWallet, "hermes backfill");
    await assertKept(staleProvisioned, "provisioned backfill");

    console.log("PASS bankr user key dropped on agent delete");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
