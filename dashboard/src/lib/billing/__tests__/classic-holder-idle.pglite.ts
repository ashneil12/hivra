/** @jest-environment node */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { GET as tick } from "@/app/api/cron/holder-inactivity-sweep/route";
import { GET as wakeStatus } from "@/app/api/instances/[id]/wake/route";
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
    "20261125020000_holder_allocation_updates", "20261125030000_classic_holder_sleep"]) {
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
      sql = "select claim_classic_holder_idle($1,$2,$3) value";
      values = [args.p_id,args.p_owner,args.p_allow_sleep];
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
  expect((await start()).status).not.toBe(200);
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
