import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const id = "00000000-0000-0000-0000-000000000001";
const nativeId = "00000000-0000-0000-0000-000000000002";
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 27, 12, minutes)).toISOString();
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table hermes_instances (
      id uuid primary key, created_at timestamptz, last_lifecycle_transition_at timestamptz,
      status text, lifecycle_state text, deleted_at timestamptz, proxmox_node text, host_id uuid,
      hetzner_server_id integer
    );
    create table hivra_agents (
      id uuid primary key, created_at timestamptz, status text, sleep_state text,
      proxmox_host text, operation_started_at timestamptz, provisioned_at timestamptz,
      sleep_tier_changed_at timestamptz
    );
    create table ops_events (
      id uuid default gen_random_uuid(), instance_id text, source text,
      first_seen_at timestamptz, last_seen_at timestamptz, archived_at timestamptz
    );
  `);
  const migration = fs.readFileSync(path.resolve(
    __dirname, "../../../../supabase/migrations/20261127154500_computer_stall_monitor.sql",
  ), "utf8");
  await pg.exec(migration);
  await pg.exec(migration);
});

afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec("truncate hermes_instances, ops_computer_health, hivra_agents, ops_events");
});

async function scan(now: number) {
  return (await pg.query("select * from list_computer_stalls($1) order by signal_key", [at(now)])).rows;
}

async function instance(lifecycle: string, transition: number | null) {
  await pg.query(
    `insert into hermes_instances
      (id, created_at, last_lifecycle_transition_at, lifecycle_state, status, proxmox_node)
      values ($1, $2, $3, $4, $5, 'fixture-node')`,
    [id, at(-600), transition == null ? null : at(transition), lifecycle,
      lifecycle === "active" ? "running" : "provisioning"],
  );
}

async function probe(now: number, healthy = false, lifecycle = 0) {
  await pg.query("select record_computer_health_observations($1, $2::jsonb)", [
    at(now), JSON.stringify([{ instance_id: id, lifecycle_at: at(lifecycle), healthy }]),
  ]);
}

async function openHealthIncident(instanceId = id) {
  await pg.query("insert into ops_events (source, instance_id) values ('synthetic.computer-stall.health', $1)",
    [instanceId]);
}

it("uses time in provisioning, not the age of an old computer, and drops the finding on transition", async () => {
  await instance("provisioning", 0);
  expect(await scan(60)).toEqual([]);
  expect(await scan(61)).toEqual([expect.objectContaining({
    instance_id: id, reason: "provisioning", verdict: "open", host: "fixture-node",
  })]);
  await pg.query("update hermes_instances set lifecycle_state='active', status='running' where id=$1", [id]);
  expect(await scan(62)).toEqual([]);
});

it("uses creation for legacy provisions without a transition stamp and ignores deleted rows", async () => {
  await instance("provisioning", null);
  expect(await scan(0)).toHaveLength(1);
  await pg.exec("update hermes_instances set deleted_at=now()");
  expect(await scan(0)).toHaveLength(0);
});

it("opens after more than an hour of sampled failures and clears on the first healthy verdict", async () => {
  await instance("active", 0);
  for (let tick = 0; tick <= 60; tick += 5) await probe(tick);
  expect(await scan(60)).toEqual([]);
  expect(await scan(61)).toEqual([expect.objectContaining({
    instance_id: id, reason: "health", verdict: "open",
  })]);
  await openHealthIncident();
  await probe(65, true);
  await probe(64);
  expect(await scan(66)).toEqual([expect.objectContaining({ verdict: "cleared" })]);
  await probe(70);
  expect(await scan(71)).toEqual([expect.objectContaining({ verdict: "pending" })]);
});

it("does not infer recovery when probes go silent or count silence toward a fresh outage", async () => {
  await instance("active", 0);
  for (let tick = 0; tick <= 65; tick += 5) await probe(tick);
  expect(await scan(81)).toEqual([expect.objectContaining({ verdict: "unknown" })]);
  await openHealthIncident();
  await probe(82);
  expect(await scan(83)).toEqual([expect.objectContaining({ verdict: "pending", since: new Date(at(82)) })]);
});

it("cannot carry a health failure into a restarted or stopped computer", async () => {
  await instance("active", 0);
  for (let tick = 0; tick <= 65; tick += 5) await probe(tick);
  await openHealthIncident();
  await pg.query("update hermes_instances set last_lifecycle_transition_at=$1 where id=$2", [at(66), id]);
  await probe(67);
  expect(await scan(68)).toEqual([expect.objectContaining({ verdict: "cleared" })]);
  await pg.query("update hermes_instances set lifecycle_state='paused' where id=$1", [id]);
  expect(await scan(69)).toEqual([]);
});

it("uses native computer provisioning and public health evidence without reading customer data", async () => {
  await pg.query(`insert into hivra_agents (id, created_at, status, sleep_state, proxmox_host)
    values ($1, $2, 'provisioning', 'awake', 'native-node')`, [nativeId, at(0)]);
  expect(await scan(61)).toEqual([expect.objectContaining({ instance_id: nativeId, verdict: "open" })]);
  await pg.exec("update hivra_agents set status='running'");
  await pg.query(`insert into ops_events (source, instance_id, first_seen_at, last_seen_at)
    values ('box.public_probe.unreachable', $1, $2, $3)`, [nativeId, at(0), at(60)]);
  expect(await scan(61)).toEqual([expect.objectContaining({ reason: "health", verdict: "open", host: "native-node" })]);
  await openHealthIncident(nativeId);
  await pg.query("update ops_events set archived_at=$1 where source='box.public_probe.unreachable'", [at(65)]);
  expect(await scan(66)).toEqual([expect.objectContaining({ verdict: "cleared" })]);
});

it("restricts both RPCs and the observation table to the service role", async () => {
  await expect(pg.exec("set role authenticated; select * from list_computer_stalls(now())"))
    .rejects.toThrow(/permission denied/);
  await expect(pg.exec("set role authenticated; select record_computer_health_observations(now(), '[]')"))
    .rejects.toThrow(/permission denied/);
  await expect(pg.exec("set role authenticated; select * from ops_computer_health"))
    .rejects.toThrow(/permission denied/);
});
