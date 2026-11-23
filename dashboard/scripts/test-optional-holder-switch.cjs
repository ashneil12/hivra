// Exercise the real RPC and Supabase role grants in an ephemeral PostgreSQL database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { prepareTokenFixture } = require("./test-dual-platform-token-foundation.cjs");

const migration = (file) => fs.readFileSync(path.resolve(__dirname, "../supabase/migrations", file), "utf8");
const legacy = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const hivra = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const now = "2026-11-23T00:00:00Z";
const grace = "2026-11-26T00:00:00Z";
const tiers = {
  pro: { amount: "25000000000000000001", code: "PRO_LAUNCH" },
  power: { amount: "100000000000000000001", code: "POWER_STANDARD" },
};
const proof = { address: wallet, balanceRaw: tiers.power.amount, balanceDisplay: "100.000000000000000001", blockNumber: 53_005_100 };
const signature = "public.switch_grandfathered_holder(text,jsonb,uuid,jsonb,timestamptz,timestamptz,text,text)";

async function main() {
  const db = new PGlite();
  try {
    await prepareTokenFixture(db);
    await db.exec(migration("20260923150000_dual_platform_token_foundation.sql"));
    const sql = migration("20261123220000_optional_holder_switch.sql");
    await db.exec(sql);
    await db.exec(sql);
    const rows = async (query, values) => (await db.query(query, values)).rows;
    const first = async (query, values) => (await rows(query, values))[0];
    const submit = async (user, expected, walletId, observed) =>
      (await first("select public.switch_grandfathered_holder($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [user, JSON.stringify(expected), walletId, observed == null ? null : JSON.stringify(observed), now, grace, hivra, legacy])).result;

    const grants = await first(`select has_function_privilege('anon',$1,'execute') as anon,
      has_function_privilege('authenticated',$1,'execute') as authenticated,
      has_function_privilege('service_role',$1,'execute') as service`, [signature]);
    assert.deepEqual(grants, { anon: false, authenticated: false, service: true });
    await db.query("select public.record_platform_token_activation('hivra',8453,$1,'HIVRA',18,$2,$3)",
      [hivra, "2026-10-01T00:00:00Z", now]);
    await db.exec(`insert into token_grandfather_cohort(user_id) values ('holder'),('account_only'),('suspended'),('in_grace'),('mixed'),('base');
      insert into hermes_subscriptions(user_id,plan,status,stripe_subscription_id,instance_limit,total_cpu_budget,total_ram_budget,updated_at)
      values ('account_only','pro','active','sub_fixture',2,4,4096,'2026-11-01T00:00Z');
      insert into yearly_token_subscriptions(user_id,tier,paid_at,expires_at,amount_received_raw,status)
      values ('account_only','power','2026-02-01T00:00Z','2027-02-01T00:00Z',12345,'active');`);
    const paidState = async () => [
      await rows("select * from hermes_subscriptions where user_id='account_only'"),
      await rows("select * from yearly_token_subscriptions where user_id='account_only'"),
    ];
    const originalPaidState = await paidState();
    const walletRow = await first(`insert into user_wallets(user_id,chain_type,chain_id,address,normalized_address,is_primary,verified_at,verification_method)
      values('holder','evm',8453,$1,$1,true,$2,'signature') returning id`, [wallet, now]);
    for (const [tier, { amount, code }] of Object.entries(tiers)) {
      await db.query(`insert into token_tier_qualifications(user_id,tier,token_key,qualifying_quantity,threshold_at_qualification,
        qualifying_threshold_tier,qualified_at,currently_eligible) values ('holder',$1,'hermesos',$2,$2,$3,'2026-09-15T00:00Z',true)`, [tier, amount, code]);
    }

    const holderState = async () => [
      await rows("select * from token_tier_qualifications where user_id='holder' order by tier"),
      await rows("select * from token_grandfather_cohort where user_id='holder'"),
      await rows("select * from token_holding_snapshots where user_id='holder'"),
    ];
    const originalHolderState = await holderState();
    for (const [expected, walletId, observed, status] of [
      [{ pro: tiers.pro }, walletRow.id, proof, "tier_changed"],
      [tiers, walletRow.id, { ...proof, balanceRaw: (BigInt(proof.balanceRaw) - 1n).toString(), balanceDisplay: "100" }, "insufficient_hivra"],
      [tiers, null, proof, "wallet_changed"],
    ]) {
      assert.equal((await submit("holder", expected, walletId, observed)).status, status);
      assert.deepEqual(await holderState(), originalHolderState, `${status} changed a row`);
    }

    // Fail the final write, after the proof snapshot and tier conversion. PostgreSQL must roll everything back.
    await db.exec(`create function fixture_fail_final_write() returns trigger language plpgsql as $$
      begin raise exception 'fixture: final cohort write failed'; end $$;
      create trigger fixture_fail_final_write before update on token_grandfather_cohort
      for each row execute function fixture_fail_final_write();`);
    await assert.rejects(submit("holder", tiers, walletRow.id, proof), /fixture: final cohort write failed/);
    assert.deepEqual(await holderState(), originalHolderState);
    await db.exec("drop trigger fixture_fail_final_write on token_grandfather_cohort");

    const converted = await submit("holder", tiers, walletRow.id, proof);
    assert.equal(converted.status, "converted");
    const migrated = await rows(`select tier,token_key,qualifying_quantity::text as amount,
      qualifying_threshold_tier as code,currently_eligible from token_tier_qualifications where user_id='holder' order by tier`);
    for (const [index, tier] of ["power", "pro"].entries()) {
      assert.deepEqual(migrated[index], { tier, token_key: "hivra", ...tiers[tier], currently_eligible: true });
    }
    assert.equal((await submit("holder", tiers, walletRow.id, proof)).status, "already_converted");
    assert.equal((await submit("outside", {}, null, null)).status, "not_grandfathered");
    assert.equal((await submit("account_only", {}, null, null)).status, "converted");
    assert.equal((await rows("select tier from token_tier_qualifications where user_id='account_only'")).length, 0);
    assert.deepEqual(await paidState(), originalPaidState);

    await db.exec(`insert into token_tier_qualifications(user_id,tier,token_key,qualifying_quantity,threshold_at_qualification,
      qualifying_threshold_tier,currently_eligible,last_breach_at,last_suspend_at)
      values('suspended','pro','hermesos',99,99,'PRO_STANDARD',false,'2026-09-18','2026-09-21')`);
    const suspended = () => rows("select * from token_tier_qualifications where user_id='suspended'");
    const originalSuspended = await suspended();
    assert.equal((await submit("suspended", {}, null, null)).status, "converted");
    assert.deepEqual(await suspended(), originalSuspended);
    // A second legacy/HIVRA row or a tier in breach grace makes the entire switch ineligible.
    for (const [user, token, breach, currentlyEligible] of [
      ["in_grace", "hermesos", "2026-11-22", false],
      ["mixed", "hivra", null, true],
    ]) {
      await db.query(`insert into token_tier_qualifications(user_id,tier,token_key,qualifying_quantity,threshold_at_qualification,
        qualifying_threshold_tier,currently_eligible,last_breach_at) values($1,'pro',$2,99,99,'PRO_STANDARD',$3,$4)`,
      [user, token, currentlyEligible, breach]);
      const unchanged = () => rows("select * from token_tier_qualifications where user_id=$1", [user]);
      const before = await unchanged();
      assert.equal((await submit(user, {}, null, null)).status, "tier_changed");
      assert.deepEqual(await unchanged(), before);
      assert.equal((await first("select converted_at from token_grandfather_cohort where user_id=$1", [user])).converted_at, null);
    }

    const baseAddress = "0x3333333333333333333333333333333333333333";
    // Legacy one-token snapshots survive removal of the hosted Starter tier.
    // They establish no wallet or balance requirement for an account-only switch.
    await db.query(`insert into token_holding_snapshots(user_id,wallet_address,normalized_wallet_address,chain_id,token_address,
      token_symbol,token_decimals,balance_raw,balance_display,qualifies_base_tier,source,checked_at)
      values('base',$1,$1,8453,$2,'HermesOS',18,'1000000000000000000','1',true,'base_rpc',$3)`,
    [baseAddress, legacy, now]);
    assert.equal((await submit("base", {}, null, null)).status, "converted");
    assert.deepEqual(await rows("select tier from token_tier_qualifications where user_id='base'"), []);
    // A refresh started before the switch may attempt its first qualification after commit.
    const firstQualification = (token) => db.query(`insert into token_tier_qualifications(user_id,tier,token_key,
      qualifying_quantity,threshold_at_qualification,qualifying_threshold_tier,currently_eligible)
      values('account_only','pro',$1,25,25,'PRO_STANDARD',true)`, [token]);
    await assert.rejects(firstQualification("hermesos"), error => error.code === "40001");
    assert.deepEqual(await rows("select tier from token_tier_qualifications where user_id='account_only'"), []);
    await firstQualification("hivra");
    assert.equal((await first("select token_key from token_tier_qualifications where user_id='account_only'")).token_key, "hivra");
    console.log("PASS optional holder switch");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
