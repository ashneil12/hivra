/** @jest-environment node */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { GET as tick } from "@/app/api/cron/holder-inactivity-sweep/route";
import { GET as wakeStatus } from "@/app/api/instances/[id]/wake/route";
import { GET as webuiHandoff } from "@/app/api/instances/[id]/webui-login-url/route";
import { POST as power } from "@/app/api/instances/[id]/route";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { FIXTURE_SQL } from "./holder-admission-schema.fixture";
import { AWAKE, VMID, makeHostHarness, type HostState } from "@/lib/hivra/__tests__/sleep-stub-host.fixtures";

jest.mock("@/lib/logger", () => jest.requireActual("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "owner" }) }));
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/telemetry/wake-events", () => ({ captureWakeEvent: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  ...jest.requireActual("@/lib/services/proxmox-instance-service"), resolveProxmoxHostEnv: jest.fn(), runProxmoxHostScript: jest.fn(),
}));
jest.mock("@/lib/hivra/managed-provisioner-channel", () => ({
  ...jest.requireActual("@/lib/hivra/managed-provisioner-channel"),
  managedHivraProvisionerChannelConfiguration: () => ({ runtime: { provisionerDirectory: host.provisionerDir } }),
}));

const id = "12345678-0123-4567-89ab-000000000057";
const params = { params: Promise.resolve({ id }) };
const base = "http://localhost/api/instances/" + id;
const gateway = "fixture.example.test";
const ip = "192.0.2.57";
let host: ReturnType<typeof makeHostHarness>;
let db: PGlite;
let vm: HostState;
let refuseCapacity = false;
let loseReply = false;
const calls: string[] = [];
const transport = jest.mocked(runProxmoxHostScript);
const row = async () => (await db.query<Record<string, unknown>>("select * from hermes_instances where id=$1", [id])).rows[0];
const query = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
async function sweep() {
  const response = await tick(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", { headers: { authorization: "Bearer fixture" } }));
  expect(response.status).toBe(200);
  return (await response.json()).data.outcomes;
}
async function start() {
  return power(new NextRequest(base, { method: "POST", body: JSON.stringify({ action: "start", wakeSource: "wake_page" }) }), params);
}
async function handoff() {
  return webuiHandoff(new NextRequest(base + "/webui-login-url"), params);
}
// Move fixture timestamps together without sleeping for sixteen wall-clock minutes.
const ageFixture = (sql: string) => db.exec("begin; alter table hermes_instances disable trigger keep_classic_holder_activity_watermark;" +
  sql + "; alter table hermes_instances enable trigger keep_classic_holder_activity_watermark; commit");
const ageNap = () => ageFixture("update hermes_instances set holder_napped_at=now()-interval '12 minutes', last_activity_at=now()-interval '16 minutes', holder_idle_claimed_at=now()-interval '12 minutes'");

jest.setTimeout(90_000);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(FIXTURE_SQL);
  const dir = path.resolve(__dirname, "../../../../supabase/migrations");
  for (const name of ["20261124230000_holder_admissions", "20261125010000_hermes_holder_idle_claim",
    "20261125020000_holder_allocation_updates", "20261125030000_classic_holder_sleep",
    "20261125050000_classic_holder_lifecycle_repairs"]) {
    await db.exec(readFileSync(path.join(dir, name + ".sql"), "utf8"));
  }
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  host = makeHostHarness({ socketless: true });
  writeFileSync(path.join(host.dir, gateway + ".caddy"), "redir https://dashboard.example.test/wake/" + id + " 302");
  process.env.CRON_SECRET = "fixture";
  process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED = "true";
  calls.length = 0; refuseCapacity = false; loseReply = false;
  vm = { ...AWAKE, tags: "", name: "hermes-fixture-12345678", ip, volatileData: "in-memory-session", probeStdout: "CLASSIC_IDLE" };
  await db.exec(`truncate holder_admissions,proxmox_hosts,token_tier_qualifications,hermes_instances,channel_connections;
    insert into proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio) values ('fixture',40,120000,1);
    insert into token_tier_qualifications(user_id,tier,token_key,currently_eligible) values ('owner','pro','hermesos',true);
    select advance_holder_admissions();`);
  await db.query(`insert into hermes_instances(id,user_id,status,lifecycle_state,seat_funding,cpu_limit,ram_limit,
    proxmox_node,proxmox_vmid,created_at,last_activity_at,config) values ($1,'owner','running','active','holder',2,4096,
    'fixture',$2,now()-interval '1 day',now()-interval '4 minutes',$3)`, [id, VMID, JSON.stringify({
    infrastructure: { provider: "proxmox", node: "fixture", vmid: VMID, gatewayHost: gateway, privateIpv4: ip },
  })]);
  jest.mocked(resolveProxmoxHostEnv).mockReturnValue({ PROXMOX_CADDY_SITES_DIR: host.dir });
  transport.mockImplementation(async (script) => {
    const result = host.run(script, vm, refuseCapacity ? { STUB_ADMISSION_REFUSES: "1" } : {});
    vm = result.state;
    calls.push(...result.calls);
    return { ok: result.status === 0 && !loseReply, stdout: result.stdout, stderr: result.stderr };
  });
  jest.mocked(supabaseAdmin!.rpc).mockImplementation((async (name: string, args: Record<string, unknown>) => {
    let sql: string;
    let values: unknown[];
    if (name === "claim_classic_holder_idle") {
      sql = "select claim_classic_holder_idle($1,$2,$3,$4) value";
      values = [args.p_id,args.p_owner,args.p_allow_sleep,args.p_exclude_hosts];
    } else if (name === "finish_classic_holder_idle") {
      sql = "select finish_classic_holder_idle($1,$2,$3,$4,$5) value";
      values = [args.p_id,args.p_generation,args.p_node,args.p_vmid,args.p_state];
    } else throw new Error("Unexpected RPC " + name);
    return { data: (await db.query<{value: unknown}>(sql, values)).rows[0].value, error: null };
  }) as never);
  jest.mocked(supabaseAdmin!.from).mockImplementation(((table: string) => {
    expect(table).toBe("hermes_instances");
    const builder = { select: () => builder, eq: () => builder, neq: () => builder, single: async () => ({ data: await row() }) };
    return builder;
  }) as never);
});
afterEach(() => { host.cleanup(); delete process.env.CRON_SECRET; delete process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED; });

it("naps at four, saves after twelve more, and restores the owner's volatile session via the wake page's APIs", async () => {
  const usage = () => query("select cpu::int, ram_mb::int,disk_gb::int,launched_cpu::int from holder_placement_accounting(array['fixture'],true)");
  expect(await sweep()).toEqual({ napping: 1 });
  expect(vm.qmp).toBe("paused");
  expect(await usage()).toEqual([{ cpu: 2, ram_mb: 4096, disk_gb: 30, launched_cpu: 2 }]);
  expect(await sweep()).toEqual({});
  await ageNap();
  expect(await sweep()).toEqual({ hibernated: 1 });
  expect(vm).toMatchObject({ vmstate: true, status: "stopped", savedData: "in-memory-session" });
  expect(vm.volatileData).toBeUndefined();
  expect(await usage()).toEqual([{ cpu: 0, ram_mb: 0, disk_gb: 30, launched_cpu: 2 }]);
  expect((await (await wakeStatus(new NextRequest(base + "/wake"), params)).json()).data.wakeable).toBe(true);
  // A wake still works after disabling new automatic sleeps.
  delete process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED;
  refuseCapacity = true;
  expect((await start()).status).toBe(429);
  expect(vm.vmstate).toBe(true);
  expect((await row()).lifecycle_substate).toBe("holder_hibernated");
  refuseCapacity = false;
  expect((await start()).status).toBe(200);
  expect(vm).toMatchObject({ qmp: "running", volatileData: "in-memory-session", onboot: 1, vmstate: false });
  expect(await row()).toMatchObject({ lifecycle_state: "active", paused_reason: null, seat_funding: "holder" });
  expect(calls).toContain("qm suspend " + VMID + " --todisk 1");
  expect(calls.some(call => /^qm (shutdown|stop) /.test(call))).toBe(false);
});

it("spares recent activity, channel connections, unknown and paid funding, and refuses an unreadable guest", async () => {
  await db.exec("update hermes_instances set last_activity_at=now()-interval '239 seconds'");
  expect(await sweep()).toEqual({});
  await ageFixture("update hermes_instances set last_activity_at=now()-interval '1 day',last_agent_activity_at=now()");
  expect(await sweep()).toEqual({});
  await db.query("insert into channel_connections values ('hermes',$1)",[id]);
  await db.exec("update hermes_instances set last_agent_activity_at=null");
  expect(await sweep()).toEqual({});
  await db.exec("delete from channel_connections");
  vm.probeStdout = "unknown";
  expect(await sweep()).toEqual({ deferred: 1 });
  expect(vm.qmp).toBe("running");
  for (const funding of ["paid", null]) {
    await db.exec("delete from hermes_instances");
    await db.query("insert into hermes_instances select (jsonb_populate_record(null::hermes_instances,$1)).*", [JSON.stringify({
      id,user_id:"owner",status:"running",lifecycle_state:"active",seat_funding:funding,proxmox_node:"fixture",proxmox_vmid:VMID,
      config:{infrastructure:{provider:"proxmox",vmid:VMID,node:"fixture",privateIpv4:ip,gatewayHost:gateway}},created_at:"2000-01-01",last_activity_at:"2000-01-01",holder_idle_generation:0,
    })]);
    expect(await sweep()).toEqual({});
  }
  expect(transport).toHaveBeenCalledTimes(1);
});

it("recovers a lost nap receipt on access and never cold boots a VM with missing memory", async () => {
  loseReply = true;
  expect(await sweep()).toEqual({ deferred: 1 });
  expect(vm.qmp).toBe("paused");
  loseReply = false;
  expect((await start()).status).toBe(200);
  expect(vm.volatileData).toBe("in-memory-session");
  await ageFixture("update hermes_instances set last_activity_at=now()-interval '4 minutes',holder_idle_claimed_at=null");
  expect(await sweep()).toEqual({ napping: 1 });
  await ageNap();
  expect(await sweep()).toEqual({ hibernated: 1 });
  vm.vmstate = false;
  expect((await start()).status).toBe(429);
  expect(calls).not.toContain("qm start " + VMID);
});

it("fences stale completion and wakes when access races the operation", async () => {
  const [sleep] = await query("select claim_classic_holder_idle(null,null,true)->>'generation' as gen");
  expect(await sweep()).toEqual({});
  await db.exec("update hermes_instances set last_activity_at=clock_timestamp()");
  expect((await db.query("select finish_classic_holder_idle($1,$2,'fixture',$3,'napping') result", [id,sleep.gen,VMID])).rows).toEqual([{result:"retry"}]);
  expect((await row()).lifecycle_substate).toBe("holder_retry");
  expect((await start()).status).toBe(200);
  expect((await db.query("select finish_classic_holder_idle($1,$2,'fixture',$3,'napping') ok", [id,sleep.gen,VMID])).rows).toEqual([{ok:null}]);
});

it("reconciles an expired operation, and refuses an owner mismatch or a released reservation", async () => {
  const [claim] = await query("select claim_classic_holder_idle(null,null,true)->>'generation' as gen");
  expect(claim.gen).toBe("1");
  expect(await query("select claim_classic_holder_idle('" + id + "','another-owner',false) as result")).toEqual([{result:null}]);
  await db.exec("update hermes_instances set holder_idle_claimed_at=now()-interval '7 minutes'");
  expect(await sweep()).toEqual({ awake: 1 });
  await ageFixture("update hermes_instances set last_activity_at=now()-interval '4 minutes', holder_idle_claimed_at=null");
  expect(await sweep()).toEqual({ napping: 1 });
  await db.exec("update holder_admissions set state='released'");
  const dispatched = transport.mock.calls.length;
  const powerResponse = await start();
  expect(powerResponse.status).toBe(409);
  expect(await powerResponse.json()).toMatchObject({ retryable: false, reason: "reservation_released" });
  const handoffResponse = await handoff();
  expect(handoffResponse.status).toBe(409);
  expect(await handoffResponse.json()).toMatchObject({ kind: "error", reason: "reservation_released" });
  expect(transport).toHaveBeenCalledTimes(dispatched);
  expect(vm.qmp).toBe("paused");
});

it("keeps the nap and reservation after a failed save, then retries without losing memory", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await ageNap();
  vm.hibernateFail = true;
  expect(await sweep()).toEqual({ deferred: 1 });
  expect(vm).toMatchObject({ qmp: "paused", onboot: 1, volatileData: "in-memory-session" });
  expect((await row()).lifecycle_substate).toBe("holder_napping");
  vm.hibernateFail = false;
  await db.exec("update hermes_instances set holder_idle_claimed_at=now()-interval '1 minute'");
  expect(await sweep()).toEqual({ hibernated: 1 });
});

it("uses the stored Proxmox columns on legacy seats and keeps access when preparation fails", async () => {
  await db.query("update hermes_instances set config='{}'::jsonb, infrastructure_provider='proxmox',ipv4_address=$1,gateway_url=$2", [ip, "https://" + gateway]);
  jest.mocked(resolveProxmoxHostEnv).mockImplementationOnce(() => { throw new Error("Fixture host routing unavailable"); });
  expect(await sweep()).toEqual({ deferred: 1 });
  expect(transport).not.toHaveBeenCalled();
  expect(await row()).toMatchObject({ status:"running",paused_reason:null });
  await db.exec("update hermes_instances set holder_idle_claimed_at=null");
  expect(await sweep()).toEqual({ napping: 1 });
  const delayedNap = transport.mock.calls[0][0];
  expect((await start()).status).toBe(200);
  const replay = host.run(delayedNap, vm);
  expect(replay.stdout).toContain('"reason":"superseded"');
  expect(replay.state).toMatchObject({ qmp: "running", volatileData: "in-memory-session" });
});

it("defers a lapsed qualification without dispatching or ending the sweep as empty", async () => {
  await db.exec("delete from token_tier_qualifications");
  expect(await sweep()).toEqual({ deferred: 1 });
  expect(transport).not.toHaveBeenCalled();
  expect(await row()).toMatchObject({ status: "running", paused_reason: null });
});

it("resumes an already-napped holder when automatic sleep is disabled", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  expect(vm.qmp).toBe("paused");
  delete process.env.HERMES_CLASSIC_HOLDER_SLEEP_ENABLED;
  await db.exec("update hermes_instances set holder_idle_claimed_at=now()-interval '31 seconds'");
  expect(await sweep()).toEqual({ awake: 1 });
  expect(vm).toMatchObject({ qmp: "running", volatileData: "in-memory-session" });
  expect(await row()).toMatchObject({ status: "running", lifecycle_state: "active", paused_reason: null });
  expect(calls).not.toContain("qm suspend " + VMID + " --todisk 1");
});

it("completes a due save on a draining host but takes the safe nap exit on maintenance", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await ageNap();
  await db.exec("update proxmox_hosts set status='draining'");
  expect(await sweep()).toEqual({ hibernated: 1 });
  expect(vm).toMatchObject({ status: "stopped", vmstate: true, savedData: "in-memory-session" });
});

it("does not start a fresh nap on a draining host while still finishing an existing nap there", async () => {
  await db.exec("update proxmox_hosts set status='draining'");
  expect(await sweep()).toEqual({});
  expect(vm.qmp).toBe("running");
  await db.exec("update proxmox_hosts set status='active'");
  expect(await sweep()).toEqual({ napping: 1 });
  await ageNap();
  await db.exec("update proxmox_hosts set status='draining'");
  expect(await sweep()).toEqual({ hibernated: 1 });
  expect(vm).toMatchObject({ status: "stopped", vmstate: true, savedData: "in-memory-session" });
});

it("resumes instead of deepening a nap when the host enters maintenance", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await db.exec("update proxmox_hosts set status='maintenance'");
  await db.exec("update hermes_instances set holder_idle_claimed_at=now()-interval '31 seconds'");
  expect(await sweep()).toEqual({ awake: 1 });
  expect(vm).toMatchObject({ qmp: "running", volatileData: "in-memory-session" });
  expect(calls).not.toContain("qm suspend " + VMID + " --todisk 1");
});

it("returns a permanent ineligibility at both owner wake routes without host dispatch", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await db.exec("delete from token_tier_qualifications");
  const dispatched = transport.mock.calls.length;
  const powerResponse = await start();
  expect(powerResponse.status).toBe(409);
  expect(await powerResponse.json()).toMatchObject({ retryable: false, reason: "reservation_ineligible" });
  const handoffResponse = await handoff();
  expect(handoffResponse.status).toBe(409);
  expect(await handoffResponse.json()).toMatchObject({ kind: "error", reason: "reservation_ineligible" });
  expect(transport).toHaveBeenCalledTimes(dispatched);
  expect((await row()).lifecycle_substate).toBe("holder_napping");
});

it("refuses a hibernated wake while its admitted backing is on another host", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await ageNap();
  expect(await sweep()).toEqual({ hibernated: 1 });

  await db.exec("update holder_admissions set assigned_host_id='replacement-host'");
  const dispatched = transport.mock.calls.length;
  const refused = await start();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ retryable: false, reason: "reservation_ineligible" });
  expect(transport).toHaveBeenCalledTimes(dispatched);
  expect((await row()).lifecycle_substate).toBe("holder_hibernated");

  await db.exec("update holder_admissions set assigned_host_id='fixture'");
  expect((await start()).status).toBe(200);
  expect(vm).toMatchObject({ qmp: "running", volatileData: "in-memory-session" });
});

it.each(["holder_nap", "holder_save", "holder_wake"] as const)("keeps a same-host sweep claim behind a fresh %s operation", async (substate) => {
  const secondId = "22345678-0123-4567-89ab-000000000057";
  const secondVmid = 2234;
  await db.exec("update hermes_instances set cpu_limit=1,ram_limit=2048");
  await db.query(`insert into hermes_instances(id,user_id,status,lifecycle_state,seat_funding,cpu_limit,ram_limit,
    proxmox_node,proxmox_vmid,created_at,last_activity_at,config) values ($1,'owner','running','active','holder',1,2048,
    'fixture',$2,now()-interval '1 day',now()-interval '5 minutes',$3)`, [secondId, secondVmid, JSON.stringify({
    infrastructure: { provider: "proxmox", node: "fixture", vmid: secondVmid, gatewayHost: gateway, privateIpv4: "192.0.2.58" },
  })]);
  await db.query(
    "update hermes_instances set lifecycle_state='paused',status='stopped',paused_reason='holder_idle'," +
      "lifecycle_substate=$1,holder_idle_claimed_at=now(),holder_napped_at=now() where id=$2",
    [substate, id],
  );

  const [claim] = await query("select claim_classic_holder_idle(null,null,true) as claim");
  expect(claim.claim).toBeNull();
});

it("lets an overlapping sweep claim another host and releases the busy host after finish", async () => {
  const secondId = "22345678-0123-4567-89ab-000000000057";
  const thirdId = "32345678-0123-4567-89ab-000000000057";
  const secondVmid = 2234;
  const thirdVmid = 3234;
  await db.exec(`insert into proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio) values ('fixture-b',40,120000,1);
    update token_tier_qualifications set tier='power';
    update holder_admissions set tier='power',reserved_cpu=4,reserved_ram_mb=8192;
    update hermes_instances set cpu_limit=1,ram_limit=2048;`);
  for (const [otherId, otherVmid, node, otherIp] of [
    [secondId, secondVmid, "fixture", "192.0.2.58"],
    [thirdId, thirdVmid, "fixture-b", "192.0.2.59"],
  ] as const) {
    await db.query(`insert into hermes_instances(id,user_id,status,lifecycle_state,seat_funding,cpu_limit,ram_limit,
      proxmox_node,proxmox_vmid,created_at,last_activity_at,config) values ($1,'owner','running','active','holder',1,2048,
      $2,$3,now()-interval '1 day',now()-interval '5 minutes',$4)`, [otherId, node, otherVmid, JSON.stringify({
      infrastructure: { provider: "proxmox", node, vmid: otherVmid, gatewayHost: gateway, privateIpv4: otherIp },
    })]);
  }
  const claim = async () => (await db.query<{ claim: { id: string; action: string; node: string; generation: number } | null }>(
    "select claim_classic_holder_idle(null,null,true) as claim",
  )).rows[0].claim;

  const first = await claim();
  expect(first).toMatchObject({ id, action: "nap", node: "fixture" });
  expect(await claim()).toMatchObject({ id: thirdId, action: "nap", node: "fixture-b" });
  expect(await claim()).toBeNull();
  const finished = (await db.query<{ result: string | null }>(
    "select finish_classic_holder_idle($1,$2,'fixture',$3,'napping') result",
    [id, first!.generation, VMID],
  )).rows[0].result;
  expect(finished).toBe("napping");
  expect(await claim()).toMatchObject({ id: secondId, action: "nap", node: "fixture" });
});

it("keeps a slow host operation fenced while another host proceeds", async () => {
  const secondId = "22345678-0123-4567-89ab-000000000057";
  const thirdId = "32345678-0123-4567-89ab-000000000057";
  const secondVmid = 2234;
  const thirdVmid = 3234;
  await db.exec(`insert into proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio) values
    ('fixture-a',40,120000,1),('fixture-b',40,120000,1);
    update token_tier_qualifications set tier='power';
    update holder_admissions set tier='power',reserved_cpu=4,reserved_ram_mb=8192;
    update hermes_instances set cpu_limit=1,proxmox_node='fixture-a',
      config=jsonb_set(config,'{infrastructure,node}','"fixture-a"'::jsonb);`);
  for (const [otherId, otherVmid, node] of [[secondId, secondVmid, "fixture-b"], [thirdId, thirdVmid, "fixture-a"]] as const) {
    await db.query(`insert into hermes_instances(id,user_id,status,lifecycle_state,seat_funding,cpu_limit,ram_limit,
      proxmox_node,proxmox_vmid,created_at,last_activity_at,config) values ($1,'owner','running','active','holder',1,2048,
      $2,$3,now()-interval '1 day',now()-interval '4 minutes',$4)`, [otherId, node, otherVmid, JSON.stringify({
      infrastructure: { provider: "proxmox", node, vmid: otherVmid, gatewayHost: gateway, privateIpv4: ip },
    })]);
  }

  await ageFixture(`update hermes_instances set lifecycle_state='paused',status='stopped',paused_reason='holder_idle',
    lifecycle_substate='holder_napping',holder_napped_at=now()-interval '13 minutes',holder_idle_claimed_at=now()-interval '13 minutes',
    last_activity_at=now()-interval '16 minutes',last_agent_activity_at=null`);

  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
  const started: number[] = [];
  transport.mockImplementation(async (script) => {
    const vmid = Number(script.match(/^VMID=(\d+)/m)?.[1]);
    started.push(vmid);
    if (vmid === VMID) await slowGate;
    return {
      ok: true,
      stdout: `HIVRA_SLEEP_RESULT {"ok":true,"vmid":${vmid},"tier":"hibernate","from":"napping","to":"hibernated","reason":"hibernated","ms":1,"steps":{},"probe":null}\n`,
      stderr: "",
    };
  });

  const pendingSweep = tick(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", { headers: { authorization: "Bearer fixture" } }));
  for (let i = 0; i < 100 && !started.includes(secondVmid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(started).toEqual([VMID, secondVmid]);
  expect(started).not.toContain(thirdVmid);
  expect((await row()).lifecycle_substate).toBe("holder_save");
  const overlappingResponse = await tick(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", { headers: { authorization: "Bearer fixture" } }));
  expect(overlappingResponse.status).toBe(200);
  expect((await overlappingResponse.json()).data.outcomes).toEqual({});
  expect(started).not.toContain(thirdVmid);
  releaseSlow();
  const response = await pendingSweep;
  expect(response.status).toBe(200);
  expect((await response.json()).data.outcomes).toEqual({ hibernated: 2 });
  expect(await sweep()).toEqual({ hibernated: 1 });
  expect(started.filter(value => value === thirdVmid)).toHaveLength(1);
});

it("holds reservation release during an in-flight wake and reconciles after the host resumes", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  const dispatched = transport.mock.calls.length;
  let releaseWake!: () => void;
  const wakeGate = new Promise<void>(resolve => { releaseWake = resolve; });
  transport.mockImplementationOnce(async (script) => {
    const result = host.run(script, vm);
    vm = result.state;
    await wakeGate;
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  });
  const pendingStart = start();
  for (let i = 0; i < 100 && transport.mock.calls.length === dispatched; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(transport).toHaveBeenCalledTimes(dispatched + 1);
  expect(vm.qmp).toBe("running");
  expect(await row()).toMatchObject({ lifecycle_state: "paused", status: "stopped", lifecycle_substate: "holder_wake" });
  await db.exec("delete from token_tier_qualifications");
  await db.exec("select advance_holder_admissions()");
  expect(await query("select state from holder_admissions where user_id='owner'")).toEqual([{ state: "admitted" }]);
  releaseWake();
  const response = await pendingStart;
  expect(response.status).toBe(200);
  expect(await row()).toMatchObject({ lifecycle_state: "active", status: "running", paused_reason: null });
  await db.exec("select advance_holder_admissions()");
  expect(await query("select state from holder_admissions where user_id='owner'")).toEqual([{ state: "released" }]);
});

it("rejects growth, reassignment and generation drift in a released wake completion", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await db.query(
    "update hermes_instances set lifecycle_substate='holder_wake',holder_idle_claimed_at=now()-interval '7 minutes' where id=$1",
    [id],
  );
  await db.exec("delete from token_tier_qualifications");
  await db.exec("select advance_holder_admissions()");
  expect(await query("select state from holder_admissions where user_id='owner'")).toEqual([{ state: "released" }]);

  const finishShape = "lifecycle_state='active',status='running',paused_reason=null,lifecycle_substate=null";
  const write = (extra: string) => `update hermes_instances set ${finishShape}${extra} where id='${id}'`;
  await expect(db.exec(write(",cpu_limit=3"))).rejects.toThrow(/holder seat funding is not admitted/);
  await expect(db.exec(write(",ram_limit=8192"))).rejects.toThrow(/holder seat funding is not admitted/);
  await expect(db.exec(write(",user_id='other'"))).rejects.toThrow(/holder seat funding is not admitted/);
  await expect(db.exec(write(",holder_idle_generation=holder_idle_generation+1"))).rejects.toThrow(/holder seat funding is not admitted/);

  await db.query("update hermes_instances set lifecycle_substate='holder_nap' where id=$1", [id]);
  await expect(db.exec(write(""))).rejects.toThrow(/holder seat funding is not admitted/);
  const stored = await db.query<Record<string, unknown>>(
    "select user_id,lifecycle_state,status,paused_reason,lifecycle_substate,cpu_limit::float,ram_limit::float from hermes_instances where id=$1",
    [id],
  );
  expect(stored.rows[0]).toEqual({
    user_id: "owner",
    lifecycle_state: "paused",
    status: "stopped",
    paused_reason: "holder_idle",
    lifecycle_substate: "holder_nap",
    cpu_limit: 2,
    ram_limit: 4096,
  });
});

it("reconciles a lost wake receipt after release instead of stranding the row in retry", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  await db.query(
    "update hermes_instances set lifecycle_substate='holder_retry',holder_idle_claimed_at=now()-interval '7 minutes' where id=$1",
    [id],
  );
  await db.exec("delete from token_tier_qualifications");
  await db.exec("select advance_holder_admissions()");
  expect(await query("select state from holder_admissions where user_id='owner'")).toEqual([{ state: "released" }]);

  const dispatched = transport.mock.calls.length;
  const response = await start();
  expect(response.status).toBe(200);
  expect(transport.mock.calls.length).toBeGreaterThan(dispatched);
  expect(await row()).toMatchObject({ lifecycle_state: "active", status: "running", paused_reason: null, seat_funding: "holder" });
});

it("reconciles a confirmed wake after an expired operation outlives the reservation", async () => {
  expect(await sweep()).toEqual({ napping: 1 });
  const dispatched = transport.mock.calls.length;
  let releaseWake!: () => void;
  const wakeGate = new Promise<void>(resolve => { releaseWake = resolve; });
  transport.mockImplementationOnce(async (script) => {
    const result = host.run(script, vm);
    vm = result.state;
    await wakeGate;
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  });
  const pendingStart = start();
  for (let i = 0; i < 100 && transport.mock.calls.length === dispatched; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(transport).toHaveBeenCalledTimes(dispatched + 1);
  expect(vm.qmp).toBe("running");
  await db.exec("update hermes_instances set holder_idle_claimed_at=now()-interval '7 minutes'");
  await db.exec("delete from token_tier_qualifications");
  await db.exec("select advance_holder_admissions()");
  expect(await query("select state from holder_admissions where user_id='owner'")).toEqual([{ state: "released" }]);
  releaseWake();
  const response = await pendingStart;
  expect(response.status).toBe(200);
  expect(await row()).toMatchObject({ lifecycle_state: "active", status: "running", paused_reason: null, seat_funding: "holder" });
});
