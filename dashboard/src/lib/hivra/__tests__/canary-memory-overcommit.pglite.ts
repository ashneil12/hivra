import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const owner = "user_PilotFixture";
const host = "fixture-node-a";
const otherHost = "fixture-node-b";
const qaTemplate = 2100;
const lookup = "public.get_hivra_canary_memory_overcommit";
const boot = "00000000-0000-4000-8000-00000000000a";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create role unrelated;
    create table public.proxmox_hosts (id text primary key, status text, decommissioned_at timestamptz);
    create table public.hermes_instances (
      proxmox_node text, proxmox_vmid integer, infrastructure_provider text, lifecycle_state text, deleted_at timestamptz
    );
    create function public.holder_admission_normalize_host_id(p_host_id text) returns text
    language sql immutable strict as $$
      select nullif(btrim(regexp_replace(regexp_replace(lower(btrim(p_host_id)), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g')), '');
    $$;
    create table public.hivra_agents (
      user_id text, proxmox_host text, deployment_mode text, computer_substrate text,
      deployment_target_id uuid, managed_provisioner_channel text, computer_profile text,
      type text, seat_funding text, canary_qa_holder_expires_at timestamptz,
      status text, desired_state text, sleep_state text, sleep_generation bigint, operation_id uuid,
      operation_kind text, vmid integer, allocation_operation_id uuid,
      infrastructure_binding_token_enforced boolean, infrastructure_binding_token_hash text
    );
  `);
  const migration = readFileSync("supabase/migrations/20261128162400_canary_memory_overcommit.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    reset role;
    truncate public.hivra_canary_memory_overcommit, public.proxmox_hosts, public.hivra_agents, public.hermes_instances;
    insert into public.proxmox_hosts values ('${host}', 'active', null), ('${otherHost}', 'active', null);
  `);
});

afterAll(async () => {
  await db.close();
});

async function setPermit(measured: Record<string, number | string> = {}) {
  await db.query(`
    insert into public.hivra_canary_memory_overcommit
      (host_id, owner_id, ratio_milli, expires_at, measured_guest_generations,
        pressure_boot_id, pressure_pswpin, pressure_pswpout, pressure_oom_kill, pressure_swap_used_kib)
    values ($1, $2, 1100, statement_timestamp() + interval '15 minutes', $3::jsonb,
        $4::uuid, 1, 2, 3, 32)
  `, [host, owner, JSON.stringify(measured), boot]);
}

async function grant(pHost: string | null = host, pOwner: string | null = owner) {
  return (await db.query<{ permit: unknown }>(
    `select ${lookup}($1, $2) as permit`, [pHost, pOwner],
  )).rows[0].permit;
}

const cloneIdentity = (vmid: number, binding = "b".repeat(32)) => `${vmid}:hivra-qa-mem-${binding}`;

async function enableWithClones(clones: Array<string | null | string[]>) {
  await db.query(`update public.hivra_canary_memory_overcommit set enabled = true, customer_health_ok = true,
    customer_health_checked_at = statement_timestamp(), measured_qa_clones = $1::text[],
    qa_template_vmid = $2`, [clones, qaTemplate]);
}

it("is off by default and reserves the public RPC exclusively for the service role", async () => {
  expect(await grant()).toBeNull();
  await setPermit();
  await db.exec("set role service_role");
  expect(await grant()).toBeNull();
  await expect(db.query("select * from public.hivra_canary_memory_overcommit")).rejects.toMatchObject({ code: "42501" });
  await expect(db.exec("update public.hivra_canary_memory_overcommit set enabled = true")).rejects.toMatchObject({ code: "42501" });
  await expect(db.exec("update public.hivra_canary_memory_overcommit set measured_qa_clones = '{}'")).rejects.toMatchObject({ code: "42501" });
  for (const role of ["anon", "authenticated", "unrelated"]) {
    await db.exec(`reset role; set role ${role}`);
    await expect(grant()).rejects.toMatchObject({ code: "42501" });
    await expect(grant(null)).rejects.toMatchObject({ code: "42501" });
  }
});

it.each([
  "host_id = 'Fixture-Node-A'",
  "host_id = 'fixture-node-'",
  "host_id = 'fixture node'",
  "singleton = false",
  "owner_id = 'user_'",
  "owner_id = 'user_multiple owners'",
  "ratio_milli = 1000",
  "ratio_milli = 2001",
  "expires_at = 'infinity'",
  "customer_health_checked_at = '-infinity'",
  "measured_guest_generations = '[]'",
  "pressure_pswpin = -1",
  "pressure_pswpin = 9007199254740992",
  "pressure_pswpout = -1",
  "pressure_pswpout = 9007199254740992",
  "pressure_oom_kill = -1",
  "pressure_oom_kill = 9007199254740992",
  "pressure_swap_used_kib = -1",
  "pressure_swap_used_kib = 65",
  "qa_template_vmid = 99",
  "qa_template_vmid = 9300",
  "qa_template_vmid = 9302",
  "qa_template_vmid = 9399",
  "qa_template_vmid = 1000000000",
])("rejects unsafe settings: %s", async (change) => {
  await setPermit();
  await expect(db.exec(`update public.hivra_canary_memory_overcommit set ${change}`)).rejects.toMatchObject({ code: "23514" });
});

it("allows only one configured host and accepts bounded ratios above 1250 milli", async () => {
  await setPermit();
  await expect(db.exec(`
    insert into public.hivra_canary_memory_overcommit (host_id, owner_id, ratio_milli, expires_at)
    values ('${otherHost}', 'user_Other', 1500, statement_timestamp() + interval '15 minutes')
  `)).rejects.toMatchObject({ code: "23505" });
  await enableWithClones([]);
  for (const ratio of [1001, 1500, 2000]) {
    await db.exec(`update public.hivra_canary_memory_overcommit set ratio_milli = ${ratio}`);
    expect(await grant()).toMatchObject({ ratio_milli: ratio });
  }
});

it("resolves the enabled QA template without a host only for the exact pilot owner", async () => {
  await setPermit();
  const clone = cloneIdentity(9301);
  await enableWithClones([clone]);
  await db.exec(`update public.hivra_canary_memory_overcommit set enabled = false; set role service_role`);
  expect(await grant(null)).toBeNull();
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set enabled = true,
    qa_template_vmid = null; set role service_role`);
  expect(await grant(null)).toBeNull();
  expect(await grant()).toMatchObject({ host_id: host, qa_template_vmid: null, measured_guests: [] });
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set qa_template_vmid = ${qaTemplate}; set role service_role`);
  expect(await grant(null)).toMatchObject({ host_id: host, qa_template_vmid: qaTemplate, measured_guests: [clone] });
  expect(await grant()).toMatchObject({ host_id: host, qa_template_vmid: qaTemplate, measured_guests: [clone] });
  expect(await grant(otherHost)).toBeNull();
  expect(await grant(null, "user_Other")).toBeNull();
  expect(await grant(null, null)).toBeNull();
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set
    customer_health_checked_at = statement_timestamp() - interval '11 minutes'; set role service_role`);
  expect(await grant(null)).toBeNull();
});

it("requires every pressure baseline field and emits canonical values without precision loss", async () => {
  await setPermit();
  await enableWithClones([cloneIdentity(9301)]);
  await expect(db.exec("update public.hivra_canary_memory_overcommit set pressure_boot_id = 'not-a-uuid'"))
    .rejects.toMatchObject({ code: "22P02" });
  const baseline = {
    pressure_boot_id: `'${boot.toUpperCase()}'`,
    pressure_pswpin: "0",
    pressure_pswpout: "9007199254740991",
    pressure_oom_kill: "7",
    pressure_swap_used_kib: "64",
  };
  for (const [column, value] of Object.entries(baseline)) {
    await db.exec(`update public.hivra_canary_memory_overcommit set ${column} = null; set role service_role`);
    expect(await grant()).toBeNull();
    await db.exec(`reset role; update public.hivra_canary_memory_overcommit set ${column} = ${value}`);
  }
  await db.exec("set role service_role");
  expect(await grant()).toMatchObject({
    pressure_baseline: `${boot}:0:9007199254740991:7:64`,
    measured_guests: [cloneIdentity(9301)],
  });
});

it("requires exact host and owner, an active host, and fresh affirmative customer health", async () => {
  await setPermit();
  await db.exec(`update public.hivra_canary_memory_overcommit set enabled = true`);
  expect(await grant()).toBeNull();
  await db.exec(`update public.hivra_canary_memory_overcommit set customer_health_ok = true`);
  expect(await grant()).toBeNull();
  for (const checkTime of ["- 11 minutes", "+ 1 minute"]) {
    const sign = checkTime[0];
    await db.exec(`update public.hivra_canary_memory_overcommit set
      customer_health_checked_at = statement_timestamp() ${sign} interval '${checkTime.slice(2)}'`);
    expect(await grant()).toBeNull();
  }
  await db.exec(`update public.hivra_canary_memory_overcommit set customer_health_checked_at = statement_timestamp(),
    customer_health_ok = false`);
  expect(await grant()).toBeNull();
  await db.exec(`update public.hivra_canary_memory_overcommit set customer_health_ok = true`);
  expect(await grant()).toMatchObject({ ratio_milli: 1100, measured_guests: [] });
  for (const [wrongHost, wrongOwner] of [[otherHost, owner], [host.toUpperCase(), owner], [null, owner], [host, "user_Other"], [host, null]]) {
    expect(await grant(wrongHost, wrongOwner)).toBeNull();
  }
  await db.exec(`update public.proxmox_hosts set status = 'draining' where id = '${host}'`);
  expect(await grant()).toBeNull();
  await db.exec(`update public.proxmox_hosts set status = 'active', decommissioned_at = statement_timestamp() where id = '${host}'`);
  expect(await grant()).toBeNull();
  await db.exec(`delete from public.proxmox_hosts where id = '${host}'`);
  expect(await grant()).toBeNull();
});

it("rounds expiry down and caps it at the earliest setting, health, or grant deadline", async () => {
  await setPermit();
  await db.exec(`update public.hivra_canary_memory_overcommit set enabled = true, customer_health_ok = true,
    customer_health_checked_at = statement_timestamp()`);
  const checkExpiry = async (expression: string) => {
    const { rows: [row] } = await db.query<{ actual: unknown; expected: unknown }>(`
      select ${lookup}($1, $2) -> 'valid_until_epoch' as actual,
        floor(extract(epoch from ${expression}))::bigint::text as expected
      from public.hivra_canary_memory_overcommit
    `, [host, owner]);
    expect(row.actual).toBe(Number(row.expected));
  };
  await checkExpiry("statement_timestamp() + interval '90 seconds'");
  await db.exec(`update public.hivra_canary_memory_overcommit set
    customer_health_checked_at = statement_timestamp() - interval '9 minutes 45.4 seconds'`);
  await checkExpiry("customer_health_checked_at + interval '10 minutes'");
  await db.exec(`update public.hivra_canary_memory_overcommit set expires_at = statement_timestamp() + interval '5.4 seconds'`);
  await checkExpiry("expires_at");
  await db.exec(`update public.hivra_canary_memory_overcommit set expires_at = statement_timestamp() - interval '1 second'`);
  expect(await grant()).toBeNull();
});

it("qualifies only exact enrolled guest identities with a current ordinary allocation", async () => {
  const binding = "a".repeat(64);
  const allocation = "00000000-0000-4000-8000-000000000001";
  const identity = (vmid: number, hash = binding) => `${vmid}:hivra-bind-${hash.slice(0, 32)}`;
  const enrolled: Record<string, number | string> = {};
  const fixtures: Array<[number, Record<string, unknown>]> = [
    [1100, {}],
    [1101, { user_id: "user_Other" }],
    [1102, { proxmox_host: otherHost }],
    [1103, { deployment_mode: "self-managed" }],
    [1104, { computer_substrate: "proxmox-lxc" }],
    [1105, { deployment_target_id: allocation }],
    [1106, { managed_provisioner_channel: "default" }],
    [1107, { status: "deleted" }],
    [1108, { desired_state: "deleted" }],
    [1109, { status: "provisioning" }],
    [1110, { sleep_state: "draining" }],
    [1111, { sleep_state: "waking" }],
    [1112, { sleep_state: "hibernated" }],
    [1113, { operation_id: allocation }],
    [1114, { operation_kind: "wake" }],
    [1115, { infrastructure_binding_token_enforced: false }],
    [1116, { infrastructure_binding_token_hash: `${"a".repeat(32)}INVALID` }],
    [1117, { infrastructure_binding_token_hash: "b".repeat(64) }],
    [1118, { allocation_operation_id: null }],
    [1119, { sleep_generation: 4 }],
    [1120, {}],
    [1121, {}],
    [1122, { type: "windows", computer_profile: "windows" }],
    [1123, { seat_funding: "holder" }],
    [1124, { canary_qa_holder_expires_at: "2026-01-01T00:00:00Z" }],
    [9302, {}],
  ];
  for (const [vmid, overrides] of fixtures) {
    if (vmid !== 1120) enrolled[identity(vmid)] = vmid === 1121 ? "3" : 3;
    await db.query("insert into public.hivra_agents select * from jsonb_populate_record(null::public.hivra_agents, $1::jsonb)", [
      JSON.stringify({
        vmid, user_id: owner, proxmox_host: host, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
        managed_provisioner_channel: "canary", type: "hermes", seat_funding: "paid", status: "running",
        desired_state: "running", sleep_state: "awake", sleep_generation: 3, allocation_operation_id: allocation,
        infrastructure_binding_token_enforced: true, infrastructure_binding_token_hash: binding, ...overrides,
      }),
    ]);
  }
  await setPermit(enrolled);
  const fullCloneList = Array.from({ length: 64 }, (_, i) => cloneIdentity(9303 + i));
  await enableWithClones(fullCloneList);
  expect(await grant()).toMatchObject({ measured_guests: [identity(1100)] });
  await enableWithClones([cloneIdentity(9301)]);
  await db.exec("set role service_role");
  expect(await grant()).toMatchObject({ ratio_milli: 1100, measured_guests: [identity(1100), cloneIdentity(9301)] });
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set qa_template_vmid = null; set role service_role`);
  expect(await grant()).toMatchObject({ qa_template_vmid: null, measured_guests: [identity(1100)] });
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set qa_template_vmid = ${qaTemplate}; set role service_role`);
  await db.exec(`reset role; update public.hivra_agents set sleep_state = 'waking' where vmid = 1100; set role service_role`);
  expect(await grant()).toMatchObject({ measured_guests: [cloneIdentity(9301)] });
  await db.exec(`reset role; update public.hivra_agents set sleep_state = 'awake',
    sleep_generation = sleep_generation + 1 where vmid = 1100; set role service_role`);
  expect(await grant()).toMatchObject({ measured_guests: [cloneIdentity(9301)] });
});

it("does not credit a QA VMID with a retained Native or Classic tenant reference on the selected host", async () => {
  await setPermit();
  await enableWithClones([9300, 9301, 9303, 9304, 9305, 9306, 9307, 9308, 9309].map(vmid => cloneIdentity(vmid)));
  await db.exec(`
    insert into public.hivra_agents (vmid, proxmox_host, user_id, status, sleep_state) values
      (9300, '${host}', 'user_Other', 'running', 'hibernated'),
      (9301, ' ${host.toUpperCase()} ', 'user_Other', 'stopped', 'awake'),
      (9303, '${host}', 'user_Other', 'deleted', 'awake'),
      (9304, '${otherHost}', 'user_Other', 'running', 'awake');
    insert into public.hermes_instances values
      ('${host}', 9305, 'proxmox', 'paused', null),
      ('${host.toUpperCase()}', 9306, 'proxmox', 'cold_archived', null),
      ('${host}', 9307, 'proxmox', 'deleted', statement_timestamp()),
      ('${host}', 9308, 'proxmox', 'deleted', null),
      ('${host}', 9309, null, 'failed', null);
    set role service_role;
  `);
  expect(await grant()).toMatchObject({ measured_guests: [9303, 9304, 9307].map(vmid => cloneIdentity(vmid)) });
  expect(await grant(host, "user_Other")).toBeNull();
  await db.exec(`reset role; update public.hivra_canary_memory_overcommit set customer_health_ok = false; set role service_role`);
  expect(await grant()).toBeNull();
});

it("fails closed on malformed or over-cap clone lists", async () => {
  await setPermit();
  const badEntries = [
    null,
    cloneIdentity(9302),
    cloneIdentity(9400),
    cloneIdentity(9303, "A".repeat(32)),
    cloneIdentity(9303, "b".repeat(31)),
    `${cloneIdentity(9303)} `,
    `${cloneIdentity(9303)}\n`,
    cloneIdentity(9300, "c".repeat(32)),
  ];
  for (const bad of badEntries) {
    await enableWithClones([cloneIdentity(9300), bad]);
    expect(await grant()).toMatchObject({ measured_guests: [] });
  }
  await enableWithClones([[cloneIdentity(9300)], [cloneIdentity(9301)]]);
  expect(await grant()).toMatchObject({ measured_guests: [] });
  const atCap = [9300, 9301, ...Array.from({ length: 62 }, (_, i) => 9303 + i)].map(vmid => cloneIdentity(vmid));
  await enableWithClones(atCap);
  expect(await grant()).toMatchObject({ measured_guests: atCap });
  await enableWithClones([...atCap, cloneIdentity(9365)]);
  expect(await grant()).toMatchObject({ measured_guests: [] });
});
