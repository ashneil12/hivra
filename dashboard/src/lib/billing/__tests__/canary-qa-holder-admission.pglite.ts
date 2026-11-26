import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FIXTURE_SQL } from "./holder-admission-schema.fixture";

const migrations = path.resolve(__dirname, "../../../../supabase/migrations");
const db = new PGlite();
const writerHashes = async () => (await db.query(
  `select proname, md5(prosrc) from pg_proc
    where oid in (
      'public.insert_hivra_managed_agent(jsonb,integer,numeric,boolean)'::regprocedure,
      'public.enforce_hivra_agent_seat_funding()'::regprocedure,
      'public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric)'::regprocedure,
      'public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean,boolean,boolean)'::regprocedure,
      'public.advance_holder_admissions(text[],numeric,boolean,jsonb)'::regprocedure
    ) order by proname`,
)).rows;
let originalWriterHashes: Awaited<ReturnType<typeof writerHashes>>;

const owner = "user_fixture1";
const qa = {
  user_id: owner, name: "Canary holder QA", type: "hermes", status: "provisioning",
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
  seat_funding: "holder", proxmox_host: "fixture", cpu: 2, ram: 4, cpu_max: 2, ram_max: 4,
  operation_kind: "provision",
};

async function insert(row: Partial<typeof qa> = {}, deadline = "1 hour", targets = ["fixture"]) {
  return (await db.query<{ result: { status: string; row?: { id: string } } }>(
    `select public.insert_canary_qa_holder_agent($1,now()+$2::interval,$3,1,false) result`,
    [JSON.stringify({ ...qa, ...row }), deadline, targets],
  )).rows[0].result;
}

beforeAll(async () => {
  await db.exec(FIXTURE_SQL);
  await db.exec(`
    alter table public.hivra_agents add column name text, add column type text, add column computer_substrate text;
    create or replace function public.hivra_owner_agent_slot_count(p_owner text)
    returns integer language sql stable as $$
      select count(*)::integer from public.hivra_agents g where g.user_id=p_owner
        and g.status in ('provisioning','running','stopped')
    $$;
  `);
  for (const file of [
    "20261124230000_holder_admissions.sql",
    "20261125010000_hermes_holder_idle_claim.sql",
    "20261125020000_holder_allocation_updates.sql",
    "20261125030000_classic_holder_sleep.sql",
    "20261125040000_durable_proxmox_placement.sql",
  ]) await db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
  originalWriterHashes = await writerHashes();
  await db.exec(fs.readFileSync(path.join(migrations, "20261126213000_canary_qa_holder_admission.sql"), "utf8"));
}, 60_000);

afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec(`
    truncate public.holder_admissions, public.token_tier_qualifications, public.hermes_subscriptions,
      public.apple_iap_subscriptions, public.yearly_token_subscriptions, public.hivra_agents,
      public.hermes_instances, public.proxmox_hosts;
    insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio)
      values('fixture',22,114688,1);
  `);
});

it("preserves the checked writers and creates one auditable holder seat without durable billing or admission data", async () => {
  expect(await writerHashes()).toEqual(originalWriterHashes);
  const result = await insert();
  expect(result).toMatchObject({ status: "inserted", row: {
    user_id: owner, seat_funding: "holder", status: "provisioning",
    canary_qa_holder_expires_at: expect.any(String),
  } });
  expect((await db.query("select * from holder_admissions")).rows).toEqual([]);
  expect((await db.query("select * from token_tier_qualifications")).rows).toEqual([]);
  expect((await db.query("select * from hermes_subscriptions")).rows).toEqual([]);
  const state = await db.query("select holder_admission_state($1) state, holder_admission_current_tier($1) tier", [owner]);
  expect(state.rows).toEqual([{ state: { state: "none", tier: null }, tier: null }]);
  expect((await db.query("select * from holder_admission_cohort_usage()")).rows).toEqual([
    { user_id: owner, cpu: "2", ram_mb: "4096" },
  ]);
  expect((await db.query("select advance_holder_admissions() result")).rows).toEqual([
    { result: expect.objectContaining({ advanced: 0, inserted: 0, released: 0 }) },
  ]);
  await expect(insert({ user_id: "user_fixture2" })).rejects.toMatchObject({ code: "P0057" });
  await db.query("update hivra_agents set status='deleted',operation_kind=null where id=$1", [result.row!.id]);
  expect(await insert({ user_id: "user_fixture2" })).toMatchObject({ status: "inserted" });
});

it("rejects unscoped marker writes and a second ordinary holder seat", async () => {
  await expect(db.query(
    "insert into hivra_agents (user_id,canary_qa_holder_expires_at) values($1,now()+interval '1 hour')", [owner],
  )).rejects.toMatchObject({ code: "P0057" });
  const result = await insert();
  await expect(db.query("update hivra_agents set canary_qa_holder_expires_at=null where id=$1", [result.row!.id]))
    .rejects.toMatchObject({ code: "P0057" });
  await expect(db.query("update hivra_agents set cpu=3 where id=$1", [result.row!.id]))
    .rejects.toMatchObject({ code: "P0057" });
  await expect(db.query(
    "insert into hivra_agents (user_id,seat_funding,deployment_mode,status,cpu,ram) values ($1,'holder','hivra-managed','running',1,2)", [owner],
  )).rejects.toMatchObject({ code: "P0057" });
});

it("runs only in an empty normal slot and leaves the paid subscription untouched", async () => {
  await db.query("insert into hermes_subscriptions values ($1,'operator','active',4,null)", [owner]);
  const paidBefore = (await db.query("select * from hermes_subscriptions")).rows;
  await db.query("insert into hivra_agents(user_id,status) values ($1,'running')", [owner]);
  await expect(insert()).resolves.toMatchObject({ status: "plan_agent_limit" });
  expect((await db.query("select * from holder_admissions")).rows).toEqual([]);
  await db.exec("delete from hivra_agents");
  const result = await insert();
  expect(result).toMatchObject({ status: "inserted", row: { user_id: owner, seat_funding: "holder" } });
  await db.query("update hivra_agents set status='deleted',operation_kind=null where id=$1", [result.row!.id]);
  expect((await db.query("select * from hermes_subscriptions")).rows).toEqual(paidBefore);
  expect((await db.query("select * from holder_admissions")).rows).toEqual([]);
  expect((await db.query("select * from token_tier_qualifications")).rows).toEqual([]);
});

it("rejects the named account's real holder eligibility and does not jump the real queue", async () => {
  await db.query(
    "insert into token_tier_qualifications(user_id,tier,token_key,currently_eligible) values($1,'pro','hermesos',true)",
    [owner],
  );
  await expect(insert()).rejects.toMatchObject({ code: "P0057" });
  await db.exec(`
    delete from token_tier_qualifications;
    insert into token_tier_qualifications(user_id,tier,token_key,currently_eligible)
      values('real-user','pro','hermesos',true);
  `);
  await expect(insert()).rejects.toMatchObject({ code: "P0057" });
  expect((await db.query("select user_id,state from holder_admissions")).rows).toEqual([]);
  await db.exec("select sync_holder_admission_candidates()");
  await expect(insert()).rejects.toMatchObject({ code: "P0057" });
  expect((await db.query("select user_id,state from holder_admissions")).rows).toEqual([{ user_id: "real-user", state: "waitlisted" }]);
});

it("allows only the service role to submit a QA admission, not to call its private backing helpers", async () => {
  const permissions = await db.query(`
    select
      has_function_privilege('anon','public.insert_canary_qa_holder_agent(jsonb,timestamptz,text[],numeric,boolean)','execute') as anon,
      has_function_privilege('authenticated','public.insert_canary_qa_holder_agent(jsonb,timestamptz,text[],numeric,boolean)','execute') as authenticated,
      has_function_privilege('service_role','public.insert_canary_qa_holder_agent(jsonb,timestamptz,text[],numeric,boolean)','execute') as service,
      has_function_privilege('service_role','public.canary_qa_holder_validation_backing(text,text)','execute') as backing
  `);
  expect(permissions.rows).toEqual([{ anon: false, authenticated: false, service: true, backing: false }]);
});

it("rejects expired, oversized, sleep-ineligible and capacity-ineligible admissions", async () => {
  await expect(insert({}, "-1 second")).resolves.toMatchObject({ status: "invalid_request" });
  await expect(insert({}, "25 hours")).resolves.toMatchObject({ status: "invalid_request" });
  await expect(insert({ cpu: 4 })).resolves.toMatchObject({ status: "invalid_request" });
  await expect(insert({}, "1 hour", ["elsewhere"])).rejects.toMatchObject({ code: "P0057" });
  await db.exec("update proxmox_hosts set sleep_mode='off'");
  await expect(insert()).rejects.toMatchObject({ code: "P0057" });
  await db.exec("update proxmox_hosts set sleep_mode='on',total_cpu=7");
  await expect(insert()).rejects.toMatchObject({ code: "P0057" });
  expect((await db.query("select * from hivra_agents")).rows).toEqual([]);
});

it("respects the declared rotation and resolves its canonical host identity", async () => {
  await db.exec("update proxmox_hosts set id='fixture-node'");
  expect(await insert({ proxmox_host: "fixture_node" }, "1 hour", ["fixture_node"])).toMatchObject({
    status: "inserted", row: { proxmox_host: "fixture_node" },
  });
});

it("permits normal same-seat stop and start claims until expiry, then only cleanup", async () => {
  const result = await insert({}, "2 seconds");
  const id = result.row!.id;
  await db.query("update hivra_agents set status='running',operation_kind=null where id=$1", [id]);
  await db.query("update hivra_agents set status='stopped' where id=$1", [id]);
  await db.query("update hivra_agents set operation_kind='start',operation_id=gen_random_uuid() where id=$1", [id]);
  expect((await db.query("select * from holder_admissions")).rows).toEqual([]);
  await db.query("update hivra_agents set status='running',operation_kind=null where id=$1", [id]);
  await db.exec("select pg_sleep(2)");
  await expect(db.query("update hivra_agents set operation_kind='restart',operation_id=gen_random_uuid() where id=$1", [id]))
    .rejects.toMatchObject({ code: "P0057" });
  await db.query("update hivra_agents set status='stopped' where id=$1", [id]);
  await db.query("update hivra_agents set status='deleted' where id=$1", [id]);
});
