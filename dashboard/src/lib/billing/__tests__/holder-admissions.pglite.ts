/**
 * @jest-environment node
 */
// SQL-contract regression tests for holder admissions. They run the real
// migration in PGlite, the repo's local disposable database harness. PGlite is
// single-connection, so the independent-transaction concurrency proof is not
// claimed here; the RPC's advisory transaction lock is exercised by repeated
// concurrent-shaped calls and the exact locking contract is in SQL.
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION = path.resolve(
  __dirname,
  "../../../../supabase/migrations/20261124230000_holder_admissions.sql",
);

import { FIXTURE_SQL } from "./holder-admission-schema.fixture";

type ResizeClaim = {
  status: "claimed" | "reused";
  operationId: string;
  hostConfigApplied: boolean;
};

let pg: PGlite;
jest.setTimeout(60_000);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(FIXTURE_SQL);
  await pg.exec(fs.readFileSync(MIGRATION, "utf8"));
  for (const file of ["20261125010000_hermes_holder_idle_claim.sql", "20261125020000_holder_allocation_updates.sql", "20261125030000_classic_holder_sleep.sql", "20261125040000_durable_proxmox_placement.sql"]) {
    await pg.exec(fs.readFileSync(path.join(path.dirname(MIGRATION), file), "utf8"));
  }
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    truncate public.holder_admissions, public.token_tier_qualifications,
      public.hermes_subscriptions, public.apple_iap_subscriptions,
      public.yearly_token_subscriptions, public.workspace_cloud_subscriptions,
      public.hivra_agents,
      public.hermes_instances, public.proxmox_hosts;
  `);
});

async function advance() {
  const { rows } = await pg.query<{ r: Record<string, unknown> }>(
    "select public.advance_holder_admissions() as r",
  );
  return rows[0].r;
}

async function qualify(user: string, tier: "pro" | "power", eligible = true) {
  await pg.query(
    `insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
     values ($1,$2,'hermesos',$3)`,
    [user, tier, eligible],
  );
}

async function admission(user: string) {
  const { rows } = await pg.query<Record<string, unknown>>(
    "select * from public.holder_admissions where user_id=$1",
    [user],
  );
  return rows[0] ?? null;
}

async function host(id: string, cpu: number, ramMb: number, overcommit = 1) {
  await pg.query(
    `insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio)
     values ($1,$2,$3,$4)`,
    [id, cpu, ramMb, overcommit],
  );
}

describe("holder admissions SQL authority", () => {
  it("does not entitle a user merely for joining the queue, admits on advancement, and retries idempotently", async () => {
    await host("h1", 22, 112640); // 20 eligible vCPU / 100GB eligible RAM => 4 CPU / 20480MB ceiling
    await qualify("u1", "pro");

    expect(await advance()).toMatchObject({ inserted: 1, advanced: 1, status: "ok" });
    const first = await admission("u1");
    expect(first).toMatchObject({ state: "admitted", tier: "pro", assigned_host_id: "h1" });

    const firstAdmittedAt = first!.admitted_at;
    expect(await advance()).toMatchObject({ inserted: 0, advanced: 0, status: "ok" });
    expect((await admission("u1"))!.admitted_at).toEqual(firstAdmittedAt);
  });

  it("replays the admissions migration before the idle-claim column exists", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(FIXTURE_SQL);
      await isolated.exec(fs.readFileSync(MIGRATION, "utf8"));
      await isolated.exec(`
        insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio)
        values('staged-host',12,57344,1);
        insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
        values('staged-user','pro','hermesos',true);
      `);
      const { rows } = await isolated.query<{ r: Record<string, unknown> }>(
        "select public.advance_holder_admissions() as r",
      );
      expect(rows[0].r).toMatchObject({ inserted: 1, advanced: 1, status: "ok" });

      await isolated.exec(fs.readFileSync(
        path.join(path.dirname(MIGRATION), "20261125010000_hermes_holder_idle_claim.sql"),
        "utf8",
      ));
      await isolated.exec(`
        insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,seat_funding,paused_reason,lifecycle_substate,holder_idle_claimed_at)
        values('staged-user','stopped','paused',2,4096,'holder','holder_idle','holder_wake',now());
        update public.token_tier_qualifications
        set currently_eligible=false,last_suspend_at=now()
        where user_id='staged-user';
      `);
      const held = await isolated.query<{ r: Record<string, unknown> }>(
        "select public.advance_holder_admissions() as r",
      );
      expect(held.rows[0].r).toMatchObject({ released: 0 });
      expect((await isolated.query<{ state: string }>(
        "select state from public.holder_admissions where user_id='staged-user'",
      )).rows[0].state).toBe("admitted");

      await isolated.exec("update public.hermes_instances set holder_idle_claimed_at=now()-interval '7 minutes'");
      const released = await isolated.query<{ r: Record<string, unknown> }>(
        "select public.advance_holder_admissions() as r",
      );
      expect(released.rows[0].r).toMatchObject({ released: 1 });
    } finally {
      await isolated.close();
    }
  });

  it("enforces the exact one-fifth ceiling independently on vCPU and RAM", async () => {
    // 20 eligible vCPU and 100GB RAM: exact vCPU ceiling is 4. Two Pro seats
    // exactly fill it; a third must remain queued even though RAM has room.
    await host("hcpu", 22, 112640);
    await qualify("cpu1", "pro");
    await qualify("cpu2", "pro");
    await qualify("cpu3", "pro");
    const cpuResult = await advance();
    expect(cpuResult).toMatchObject({ advanced: 2, blockReason: "holder_capacity_ceiling", ceilingCpu: 4 });
    expect((await admission("cpu3"))!.state).toBe("waitlisted");

    await pg.exec("truncate public.holder_admissions, public.token_tier_qualifications, public.proxmox_hosts");
    // Plenty of vCPU but only 20GB eligible RAM: exact RAM ceiling is 4096MB.
    // One Pro seat exactly fills it; the second is blocked by RAM.
    await pg.query(
      `insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb)
       values('hram',102,20480+4096+8192,1,2,4096,8192)`,
    );
    await qualify("ram1", "pro");
    await qualify("ram2", "pro");
    const ramResult = await advance();
    expect(ramResult).toMatchObject({ advanced: 1, blockReason: "holder_capacity_ceiling", ceilingRamMb: 4096 });
    expect((await admission("ram2"))!.state).toBe("waitlisted");
  });

  it("uses mixed tier sizes and requires a single unfragmented host fit in FIFO order", async () => {
    // Two 10-eligible-vCPU hosts have 20 vCPU aggregate, exactly enough ceiling
    // for one Power seat, but concurrent non-holder provisioning rows fragment
    // free cores to 3+3 so neither host alone fits Power's indivisible 4 vCPU.
    await host("ha", 12, 47104);
    await host("hb", 12, 47104);
    await pg.query(
      `insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host)
       values('nonholder','hivra-managed','provisioning',7,1,'ha'),
             ('nonholder','hivra-managed','provisioning',7,1,'hb')`,
    );
    await qualify("power", "power");
    await qualify("pro", "pro");
    const result = await advance();
    expect(result).toMatchObject({ advanced: 0, blockReason: "no_single_host_fit" });
    expect((await admission("power"))!.state).toBe("waitlisted");
    // Strict FIFO: the smaller Pro seat must not jump the Power waiter.
    expect((await admission("pro"))!.state).toBe("waitlisted");
  });

  it("excludes paid seats from the holder cohort while counting existing token-funded seats", async () => {
    await host("h1", 22, 112640); // holder vCPU ceiling 4
    // A paid user already occupies scheduler resources but is not a token-funded
    // holder seat, so it does not consume the holder cohort ceiling.
    await pg.exec(
      `insert into public.hermes_subscriptions(user_id,plan,status,instance_limit) values('paid','fleet','active',5);
       insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,seat_funding)
       values('paid','running','active',4,8192,'h1','paid');`,
    );
    // An existing grandfathered token-funded holder occupies 2 vCPU. It
    // consumes half the ceiling through its existing seat; the admission row
    // reserves only the unlaunched remainder, so it is not double-counted.
    await pg.exec(
      `insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
       values('existing','pro','hermesos',true);
       insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,grandfathered)
       values('existing','admitted','pro','hermesos',now(),2,4096,true);
       insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host,seat_funding)
       values('existing','hivra-managed','running',2,4,'h1','holder');`,
    );
    await qualify("new1", "pro");
    await qualify("new2", "pro");
    const result = await advance();
    expect(result).toMatchObject({ advanced: 1, blockReason: "holder_capacity_ceiling" });
    expect((await admission("new1"))!.state).toBe("admitted");
    expect((await admission("new2"))!.state).toBe("waitlisted");
  });

  it("capacity growth advances qualified waiters and skips newly ineligible waiters", async () => {
    await host("h1", 12, 57344); // 10 eligible vCPU => only one Pro seat fits ceiling
    await qualify("ineligible", "pro");
    await qualify("qualified", "pro");
    let result = await advance();
    expect(result).toMatchObject({ advanced: 1 });
    expect((await admission("ineligible"))!.state).toBe("admitted");

    // The first waiter loses eligibility before new capacity arrives. It is
    // skipped; the later qualified waiter advances when capacity grows.
    await pg.query("update public.holder_admissions set state='waitlisted', admitted_at=null, assigned_host_id=null");
    await pg.query("update public.token_tier_qualifications set currently_eligible=false where user_id='ineligible'");
    await host("h2", 12, 57344);
    result = await advance();
    expect(result).toMatchObject({ advanced: 1, skippedIneligible: 1 });
    expect((await admission("ineligible"))!.state).toBe("waitlisted");
    expect((await admission("qualified"))!.state).toBe("admitted");
  });

  it("reconciles a stale assigned host onto replacement eligible inventory", async () => {
    await host("oldhost", 12, 57344);
    await qualify("holder", "pro");
    await advance();
    expect((await admission("holder"))!.assigned_host_id).toBe("oldhost");

    await pg.query("update public.proxmox_hosts set status='maintenance' where id='oldhost'");
    await host("newhost", 12, 57344);
    const result = await advance();

    expect(result).toMatchObject({ advanced: 0, released: 0 });
    const row = await admission("holder");
    expect(row).toMatchObject({ state: "admitted", assigned_host_id: "newhost" });
  });

  it("keeps admissions through breach grace, releases them at suspension, and advances the next waiter", async () => {
    await host("h1", 12, 57344); // one Pro seat of holder ceiling
    await qualify("first", "pro");
    await qualify("second", "pro");
    let result = await advance();
    expect((await admission("first"))!.state).toBe("admitted");
    expect((await admission("second"))!.state).toBe("waitlisted");

    // A fresh breach without suspension is the evaluator's grace state. The
    // admitted seat is not released merely because currently_eligible flipped.
    await pg.query(
      `update public.token_tier_qualifications
       set currently_eligible=false,last_breach_at=now(),last_suspend_at=null
       where user_id='first'`,
    );
    result = await advance();
    expect(result).toMatchObject({ released: 0, advanced: 0 });
    expect((await admission("first"))!.state).toBe("admitted");

    // Suspension is authoritative end-of-grace. Releasing that reservation in
    // the same serialized transaction lets the next qualified waiter advance.
    await pg.query(
      `update public.token_tier_qualifications
       set last_suspend_at=now()
       where user_id='first'`,
    );
    result = await advance();
    expect(result).toMatchObject({ released: 1, advanced: 1 });
    expect((await admission("first"))!.state).toBe("released");
    expect((await admission("second"))!.state).toBe("admitted");
    const { rows } = await pg.query<{ r: { state: string } }>(
      "select public.holder_admission_state('first') as r",
    );
    expect(rows[0].r).toEqual({ state: "none", tier: null });
  });

  it("serializes concurrent-shaped advancement calls without double admission", async () => {
    await host("h1", 12, 57344); // ceiling exactly one Pro seat
    await qualify("u1", "pro");
    await qualify("u2", "pro");
    const [a, b] = await Promise.all([advance(), advance()]);
    expect(Number(a.advanced) + Number(b.advanced)).toBeLessThanOrEqual(2);
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.holder_admissions where state='admitted'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("counts only persisted holder seats in mixed accounts and atomically rejects oversubscription", async () => {
    await qualify("mixed", "pro");
    await pg.exec(
      `insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb)
       values('mixed','admitted','pro','hermesos',now(),2,4096);
       insert into public.hermes_subscriptions(user_id,plan,status,instance_limit)
       values('mixed','fleet','active',5);
       insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host,seat_funding)
       values('mixed','hivra-managed','running',1,2,'h1','holder');
       insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,seat_funding)
       values('mixed','running','active',4,8192,'h1','paid');`,
    );

    const { rows } = await pg.query<{ cpu: number; ram_mb: number }>(
      "select cpu::float, ram_mb::float from public.holder_admission_existing_usage('mixed')",
    );
    // The paid Hermes seat in the same account is not charged to the holder
    // reservation. Only the one persisted holder Hivra seat is.
    expect(rows[0]).toEqual({ cpu: 1, ram_mb: 2048 });

    // The remainder fits exactly once. The validating insert transaction is the
    // same owner-serialized authority both Hivra and Hermes creation use.
    await pg.query(
      `insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,seat_funding)
       values('mixed','provisioning','provisioning',1,2048,'h1','holder')`,
    );
    await expect(pg.query(
      `insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host,seat_funding)
       values('mixed','hivra-managed','provisioning',0.5,1,'h1','holder')`,
    )).rejects.toThrow(/holder seat funding is not admitted|exceeds the reserved seat resources/);
  });


  it("holds both sides of a resize claim until rollback or completion, including cross-lane launches", async () => {
    await host("h1", 12, 57344);
    await qualify("split", "pro");
    await advance();
    await pg.exec(`insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,seat_funding)
      values('split','hivra-managed','running',1,2,'holder')`);
    // Load the deployed-shape operation functions used by the action route.
    for (const [migration, name] of [
      ["20260830180000_hivra_agent_restore_points.sql", "claim_hivra_agent_operation"],
      ["20260915150000_hivra_resource_envelopes.sql", "continue_hivra_agent_resize_operation"],
    ]) {
      const sql = fs.readFileSync(path.join(path.dirname(MIGRATION), migration), "utf8");
      const start = sql.indexOf(`create or replace function public.${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      await pg.exec(sql.slice(start, sql.indexOf("$$;", start) + 3));
    }
    const claim = (cpu: number, ram: number, maximumCpu = cpu) => pg.query(
      `select public.claim_hivra_agent_operation(user_id,id,gen_random_uuid(),'resize','running',
        jsonb_build_object('cpu',$1::numeric,'ram',$2::int,'maximumCpu',$3::numeric))
       from public.hivra_agents where user_id='split'`, [cpu, ram, maximumCpu]);
    const complete = (cpu: number, ram: number) => pg.query<{ ok: boolean }>(
      `select public.continue_hivra_agent_resize_operation(user_id,id,operation_id,'running','provisioning',
        $1::numeric,$2::int,$1::numeric,$2::int) ok from public.hivra_agents where user_id='split'`, [cpu, ram]);
    const launch = () => pg.exec(`insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,seat_funding)
      values('split','provisioning','provisioning',1,2048,'holder')`);
    const release = "update public.hivra_agents set operation_kind=null, operation_id=null, operation_payload=null";
    await expect(claim(3, 2)).rejects.toThrow(/reserved seat resources/);
    await expect(claim(1, 2, 4)).rejects.toThrow(/reserved seat resources/);
    await claim(2, 4);
    await expect(launch()).rejects.toThrow(/reserved seat resources/);
    await pg.exec(release);
    await claim(2, 4);
    expect((await complete(2, 4)).rows[0].ok).toBe(true);
    await pg.exec(release);
    await claim(1, 2);
    await expect(launch()).rejects.toThrow(/reserved seat resources/);
    expect((await complete(1, 2)).rows[0].ok).toBe(true);
    await pg.exec(release);
    await launch();
    await expect(pg.exec("update public.hermes_instances set cpu_limit=2")).rejects.toThrow(/reserved seat resources/);
    await expect(pg.exec("update public.hivra_agents set ram=3")).rejects.toThrow(/reserved seat resources/);
  });

  it("charges released stopped and paused seats until freed, refuses resume and growth, and allows reduction and deletion", async () => {
    await host("h1", 12, 57344);
    await qualify("first", "pro");
    await advance();
    await pg.exec(`insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,seat_funding)
      values('first','hivra-managed','stopped',1,2,'holder');
      insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,seat_funding)
      values('first','stopped','paused',1,2048,'holder');
      update public.token_tier_qualifications set currently_eligible=false,last_suspend_at=now()`);
    await qualify("waiter", "pro");
    expect(await advance()).toMatchObject({ released: 1, advanced: 0, usedCpu: 2, usedRamMb: 4096 });
    const usage = async () => {
      const { rows } = await pg.query<{ cpu: number; ram_mb: number }>(
        "select cpu::float, ram_mb::float from public.holder_admission_existing_usage('first')",
      );
      return rows[0];
    };
    const hivraCheck =
      "select status,cpu::float,ram::float,operation_kind,operation_id from public.hivra_agents where user_id='first'";
    const hivraExpected = { status: "stopped", cpu: 1, ram: 2, operation_kind: null, operation_id: null };
    const classicCheck =
      "select lifecycle_state,status,paused_reason,lifecycle_substate,cpu_limit::float,ram_limit::float from public.hermes_instances where user_id='first'";
    const classicExpected = {
      lifecycle_state: "paused",
      status: "stopped",
      paused_reason: null,
      lifecycle_substate: null,
      cpu_limit: 1,
      ram_limit: 2048,
    };
    const forbidden = [
      {
        operation: "hivra resume",
        sql: "update public.hivra_agents set status='running'",
        check: hivraCheck,
        expected: hivraExpected,
      },
      {
        operation: "hivra start claim",
        sql: "update public.hivra_agents set operation_kind='start',operation_id=gen_random_uuid()",
        check: hivraCheck,
        expected: hivraExpected,
      },
      {
        operation: "hivra growth",
        sql: "update public.hivra_agents set ram=3",
        check: hivraCheck,
        expected: hivraExpected,
      },
      {
        operation: "classic resume",
        sql: "update public.hermes_instances set lifecycle_state='active',status='running'",
        check: classicCheck,
        expected: classicExpected,
      },
      {
        operation: "classic growth",
        sql: "update public.hermes_instances set ram_limit=4096",
        check: classicCheck,
        expected: classicExpected,
      },
    ];
    expect(await usage()).toEqual({ cpu: 2, ram_mb: 4096 });
    for (const attempt of forbidden) {
      let outcome: string;
      try {
        await pg.exec(attempt.sql);
        outcome = "resolved without rejection";
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error);
      }
      expect({ operation: attempt.operation, sql: attempt.sql, outcome }).toEqual({
        operation: attempt.operation,
        sql: attempt.sql,
        outcome: expect.stringMatching(/holder seat funding is not admitted/),
      });
      const { rows } = await pg.query<Record<string, unknown>>(attempt.check);
      expect({ operation: attempt.operation, sql: attempt.sql, row: rows[0] }).toEqual({
        operation: attempt.operation,
        sql: attempt.sql,
        row: attempt.expected,
      });
    }
    await pg.exec("update public.hermes_instances set cpu_limit=0.5,ram_limit=1024");
    expect(await usage()).toEqual({ cpu: 1.5, ram_mb: 3072 });
    expect(await advance()).toMatchObject({ advanced: 0, usedCpu: 1.5, usedRamMb: 3072 });
    await pg.exec("update public.hivra_agents set status='deleted'; update public.hermes_instances set lifecycle_state='cold_archived'");
    expect(await usage()).toEqual({ cpu: 0, ram_mb: 0 });
    expect(await advance()).toMatchObject({ advanced: 1, usedCpu: 2, usedRamMb: 4096 });
  });

  it("rejects growth and reassignment in the released idle-wake reconciliation write", async () => {
    await host("h1", 12, 57344);
    await qualify("wake-owner", "pro");
    await advance();
    await pg.exec(`insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,seat_funding,paused_reason,lifecycle_substate)
      values('wake-owner','stopped','paused',2,4096,'holder','holder_idle','holder_wake')`);
    await pg.exec("update public.token_tier_qualifications set currently_eligible=false,last_suspend_at=now() where user_id='wake-owner'");
    expect(await advance()).toMatchObject({ released: 1 });

    const finishShape = "lifecycle_state='active',status='running',paused_reason=null,lifecycle_substate=null";
    const attempts = [
      `update public.hermes_instances set ${finishShape},cpu_limit=3 where user_id='wake-owner'`,
      `update public.hermes_instances set ${finishShape},ram_limit=8192 where user_id='wake-owner'`,
      `update public.hermes_instances set ${finishShape},user_id='other-owner' where user_id='wake-owner'`,
    ];
    for (const sql of attempts) {
      await expect(pg.exec(sql)).rejects.toThrow(/holder seat funding is not admitted/);
    }
    await pg.exec("update public.hermes_instances set lifecycle_substate='holder_nap' where user_id='wake-owner'");
    await expect(pg.exec(
      `update public.hermes_instances set ${finishShape} where user_id='wake-owner'`,
    )).rejects.toThrow(/holder seat funding is not admitted/);

    const { rows } = await pg.query<Record<string, unknown>>(
      "select user_id,lifecycle_state,status,paused_reason,lifecycle_substate,cpu_limit::float,ram_limit::float from public.hermes_instances where user_id='wake-owner'",
    );
    expect(rows[0]).toEqual({
      user_id: "wake-owner",
      lifecycle_state: "paused",
      status: "stopped",
      paused_reason: "holder_idle",
      lifecycle_substate: "holder_nap",
      cpu_limit: 2,
      ram_limit: 4096,
    });
  });

  it("readmits a requalified owner with a surviving allocation without charging it twice", async () => {
    await host("h1", 12, 57344);
    await qualify("back", "pro");
    await advance();
    await pg.exec(`insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,seat_funding,proxmox_host)
      values('back','hivra-managed','running',2,4,'holder','h1');
      update public.token_tier_qualifications set currently_eligible=false,last_suspend_at=now()`);
    expect(await advance()).toMatchObject({ released: 1, usedCpu: 2 });
    await pg.exec("update public.token_tier_qualifications set currently_eligible=true,last_suspend_at=null");
    expect(await advance()).toMatchObject({ advanced: 1, usedCpu: 2 });
  });

  it("reconciles Power only after waiters and capacity, then charges an oversized allocation until it shrinks", async () => {
    await host("h1", 12, 57344);
    await qualify("existing", "pro");
    await advance();
    await qualify("existing", "power");
    await qualify("waiter", "pro");
    expect(await advance()).toMatchObject({ advanced: 0, retiered: 0 });
    await host("h2", 12, 57344);
    expect(await advance()).toMatchObject({ advanced: 1, retiered: 0 });
    expect(await admission("existing")).toMatchObject({ tier: "pro" });
    await host("h3", 12, 57344);
    expect(await advance()).toMatchObject({ advanced: 0, retiered: 1, usedCpu: 6 });
    await pg.exec(`insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,seat_funding)
      values('existing','hivra-managed','stopped',4,8,'holder');
      update public.token_tier_qualifications set currently_eligible=false,last_suspend_at=now() where tier='power'`);
    const state = await pg.query<{ r: unknown }>("select public.holder_admission_state('existing') r");
    expect(state.rows[0].r).toEqual({ state: "admitted", tier: "pro" });
    expect(await advance()).toMatchObject({ retiered: 1, usedCpu: 6 });
    expect(await admission("existing")).toMatchObject({ tier: "pro", reserved_ram_mb: 4096 });
    await pg.exec("update public.hivra_agents set cpu=2,ram=4");
    expect(await advance()).toMatchObject({ usedCpu: 4 });
  });

  it("filters the declared rotation, applies per-host disk size and counts disks on stopped VMs", async () => {
    await host("off-rotation", 102, 112640);
    await host("Node.A", 12, 57344);
    await qualify("holder", "pro");
    await pg.exec(`update public.proxmox_hosts set thinpool_size_gb=100,thinpool_overcommit_ratio=1;
      insert into public.hivra_agents(user_id,status,proxmox_host,vmid)
      values('other','stopped','Node.A',501), ('failed-launch','error','Node.A',null)`);
    const scoped = (required: number) => pg.query<{ r: unknown }>(
      "select public.advance_holder_admissions(array['node_a'],null,false,jsonb_build_object('node_a',$1::int)) r", [required]);
    expect((await scoped(61)).rows[0].r).toMatchObject({ blockReason: "no_single_host_fit", capacityCpu: 10 });
    expect((await scoped(60)).rows[0].r).toMatchObject({ advanced: 1, ceilingCpu: 2 });
    expect(await admission("holder")).toMatchObject({ assigned_host_id: "Node.A" });
  });

  it("uses fresh measured disk, reserves in-flight launches and falls back on stale or malformed readings", async () => {
    await host("h", 22, 112640);
    await qualify("a", "pro");
    await qualify("b", "pro");
    await pg.exec(`update public.proxmox_hosts set thinpool_size_gb=20,thinpool_overcommit_ratio=1;
      insert into public.hivra_agents(user_id,status,proxmox_host,cpu,ram)
      values('launch','provisioning','h',1,1)`);
    const reading = (at: string, version: string, used: number) => pg.query(
      `update public.proxmox_hosts set capacity_reading=jsonb_build_object('v',$1::jsonb,
        'at',now()-$2::interval,'pool',jsonb_build_object('sizeMb',102400,'usedPercent',$3::numeric))`,
      [version, at, used]);
    await reading("16 min", "1", 0);
    expect(await advance()).toMatchObject({ advanced: 0, blockReason: "no_single_host_fit" });
    await reading("1 min", '"1"', 0);
    expect(await advance()).toMatchObject({ advanced: 0 });
    await reading("1 min", "1", 46); // 85 - 46 - 20 = 19GB
    expect(await advance()).toMatchObject({ advanced: 0 });
    await reading("1 min", "1", 45);
    expect(await advance()).toMatchObject({ advanced: 1, blockReason: "no_single_host_fit" });
  });

  it("ranks by free RAM, disk and CPU and respects both placement deep-sleep switches", async () => {
    await host("small", 22, 57344);
    await host("big", 22, 112640);
    await qualify("one", "pro");
    await pg.exec(`insert into public.hivra_agents(user_id,status,proxmox_host,cpu,ram,sleep_state)
      values('sleep','running','big',20,90,'hibernated')`);
    expect(await advance()).toMatchObject({ advanced: 1 });
    expect(await admission("one")).toMatchObject({ assigned_host_id: "small" });
    await pg.exec("update public.proxmox_hosts set placement_skip_deep_sleep=true where id='big'");
    await qualify("two", "pro");
    await advance();
    expect(await admission("two")).toMatchObject({ assigned_host_id: "big" });
    await pg.exec("update public.proxmox_hosts set placement_skip_deep_sleep=false");
    await qualify("three", "pro");
    await pg.query("select public.advance_holder_admissions(null,null,true)");
    expect(await admission("three")).toMatchObject({ assigned_host_id: "big" });
  });

  it("keeps the waiter qualified until the host can nap and save, then admits it", async () => {
    await host("h1", 22, 112640);
    await qualify("wait", "pro");
    await pg.exec("update public.proxmox_hosts set sleep_mode='observe'");
    expect(await advance()).toMatchObject({ advanced: 0, blockReason: "no_single_host_fit" });
    expect(await admission("wait")).toMatchObject({ state: "waitlisted" });
    await pg.exec("update public.proxmox_hosts set sleep_mode='canary'");
    expect(await advance()).toMatchObject({ advanced: 1 });
    expect(await admission("wait")).toMatchObject({ state: "admitted", assigned_host_id: "h1" });
  });

  it("releases only physical compute for a hibernated holder and spends its own unlaunched remainder once", async () => {
    await host("h1", 22, 112640);
    await pg.exec("update public.proxmox_hosts set thinpool_size_gb=120,thinpool_overcommit_ratio=1");
    await qualify("sleep", "power");
    await advance();
    await pg.exec(`insert into public.hivra_agents(user_id,deployment_mode,status,proxmox_host,cpu,ram,sleep_state,seat_funding)
      values('sleep','hivra-managed','running','h1',3,6,'hibernated','holder')`);
    const available = async (skip: boolean, owner: string | null) => (await pg.query(
      "select free_cpu::float,free_ram_mb::int,free_disk_gb::int from public.holder_admission_host_availability(null,1,$1,'{}',$2)", [skip, owner])).rows[0];
    expect(await available(false, null)).toEqual({ free_cpu: 16, free_ram_mb: 92160, free_disk_gb: 40 });
    expect(await available(true, null)).toEqual({ free_cpu: 19, free_ram_mb: 98304, free_disk_gb: 40 });
    expect(await available(true, "sleep")).toEqual({ free_cpu: 20, free_ram_mb: 100352, free_disk_gb: 80 });
    await pg.exec("update public.proxmox_hosts set placement_skip_deep_sleep=true");
    expect(await available(false, null)).toEqual(await available(true, null));
    await expect(pg.exec(`insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,seat_funding)
      values('sleep','running','active',2,2048,'holder')`)).rejects.toThrow(/reserved seat resources/);
  });

  it("commits tier, mixed sizes and pending work together, rolling back stale or over-budget changes", async () => {
    await host("h1", 22, 112640);
    await qualify("owner", "power");
    await advance();
    const { rows } = await pg.query<{ id: string }>(`insert into public.hermes_instances
      (user_id,status,lifecycle_state,cpu_limit,ram_limit,resource_tier,seat_funding)
      values('owner','running','active',1,2048,'operator','holder'),
            ('owner','running','active',1,2048,'operator','holder') returning id`);
    const changes = rows.map(({ id }) => ({ id, previous_tier: "operator", previous_cpu: 1, previous_ram: 2048, cpu_limit: 1, ram_limit: 2048 }));
    const apply = (batch: typeof changes) => pg.query(
      "select public.apply_hermes_tier_allocations('owner',true,'fleet',$1)", [JSON.stringify(batch)]);
    await expect(apply([{ ...changes[0], cpu_limit: 2 }, { ...changes[1], cpu_limit: 4 }])).rejects.toThrow(/reserved seat resources/);
    await expect(apply([changes[0], { ...changes[1], previous_ram: 4096 }])).rejects.toThrow(/allocation changed/);
    expect((await pg.query("select count(*)::int n from public.hermes_instances where resource_tier='operator' and cpu_limit=1 and not tier_change_pending")).rows[0]).toEqual({ n: 2 });
    await apply([{ ...changes[0], cpu_limit: 2 }, changes[1]]);
    expect((await pg.query("select cpu_limit::float, tier_change_pending from public.hermes_instances where resource_tier='fleet' order by cpu_limit")).rows).toEqual([
      { cpu_limit: 1, tier_change_pending: false }, { cpu_limit: 2, tier_change_pending: true },
    ]);
  });

  it("grandfathers only evidenced legacy token-funded seats, not mere qualification or paid accounts", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(FIXTURE_SQL);
      await isolated.exec(
        `insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
         values('legacy','pro','hermesos',true),
               ('qualified_only','pro','hermesos',true),
               ('classic','power','hermesos',true),
               ('paid_legacy','pro','hermesos',true);
         insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,resource_tier)
         values('classic','running','active',4,8192,'fleet');
         insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host)
         values('legacy','hivra-managed','running',2,4,'h1'),
               ('paid_legacy','hivra-managed','running',2,4,'h1');
         insert into public.hermes_subscriptions(user_id,plan,status,instance_limit)
         values('paid_legacy','fleet','active',5);`,
      );
      await isolated.exec(fs.readFileSync(MIGRATION, "utf8"));

      const { rows } = await isolated.query<Record<string, unknown>>(
        `select a.user_id, a.state, a.grandfathered,
                (select seat_funding from public.hivra_agents x where x.user_id=a.user_id limit 1) as hivra_funding
         from public.holder_admissions a order by a.user_id`,
      );
      const byUser = Object.fromEntries(rows.map((row) => [row.user_id, row]));
      expect(byUser.legacy).toMatchObject({ state: "admitted", grandfathered: true, hivra_funding: "holder" });
      expect(byUser.classic).toMatchObject({ state: "admitted", grandfathered: true });
      expect((await isolated.query("select seat_funding,cpu_limit::float,ram_limit,status,lifecycle_state from public.hermes_instances where user_id='classic'")).rows[0])
        .toEqual({ seat_funding: "holder", cpu_limit: 4, ram_limit: 8192, status: "running", lifecycle_state: "active" });
      // Qualification alone is queue evidence, not proof that any pre-existing
      // seat was token-funded. This user waits for capacity like a new holder.
      expect(byUser.qualified_only).toMatchObject({ state: "waitlisted", grandfathered: false });
      // A currently paid account is ambiguous: its pre-feature seats may have
      // been paid, so the migration deliberately leaves them unknown rather
      // than inventing holder funding.
      expect(byUser.paid_legacy).toMatchObject({ state: "waitlisted", grandfathered: false, hivra_funding: null });
    } finally {
      await isolated.close();
    }
  });

  it("replays the migration against paid Workspace and Classic breach-grace fixtures", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(FIXTURE_SQL);
      await isolated.exec(
        `insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible,last_breach_at)
         values('workspace_paid','pro','hermesos',true,null),
               ('workspace_paid_lane','pro','hermesos',true,null),
               ('workspace_only','pro','hermesos',true,null),
               ('classic_grace','pro','hermesos',false,now() - interval '1 hour'),
               ('classic_expired','pro','hermesos',false,now() - interval '25 hours');
         insert into public.workspace_cloud_subscriptions(user_id,plan,status,instance_limit)
         values('workspace_paid','ws_cloud_pro','active',1),
               ('workspace_paid_lane','ws_cloud_pro','active',1);
         insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,resource_tier,product_surface)
         values('workspace_paid','running','active',2,4096,'fleet','hermesos'),
               ('workspace_paid_lane','running','active',2,4096,'fleet','workspace_cloud'),
               ('workspace_only','running','active',2,4096,'fleet','workspace_cloud'),
               ('classic_grace','running','active',2,4096,'fleet','hermesos'),
               ('classic_expired','running','active',2,4096,'fleet','hermesos');`,
      );
      await isolated.exec(fs.readFileSync(MIGRATION, "utf8"));

      const { rows: instances } = await isolated.query<{
        user_id: string;
        product_surface: string;
        seat_funding: string | null;
      }>(
        "select user_id,product_surface,seat_funding from public.hermes_instances order by user_id",
      );
      const instanceByUser = Object.fromEntries(instances.map((row) => [row.user_id, row]));
      expect(instanceByUser.workspace_paid).toMatchObject({ product_surface: "hermesos", seat_funding: null });
      expect(instanceByUser.workspace_paid_lane).toMatchObject({ product_surface: "workspace_cloud", seat_funding: null });
      expect(instanceByUser.workspace_only).toMatchObject({ product_surface: "workspace_cloud", seat_funding: null });
      expect(instanceByUser.classic_grace).toMatchObject({ product_surface: "hermesos", seat_funding: "holder" });
      expect(instanceByUser.classic_expired).toMatchObject({ product_surface: "hermesos", seat_funding: null });

      const { rows: admissions } = await isolated.query<{
        user_id: string;
        state: string;
        tier: string;
        grandfathered: boolean;
      }>(
        "select user_id,state,tier,grandfathered from public.holder_admissions order by user_id",
      );
      const admissionByUser = Object.fromEntries(admissions.map((row) => [row.user_id, row]));
      expect(admissionByUser.workspace_paid).toMatchObject({ state: "waitlisted", grandfathered: false });
      expect(admissionByUser.workspace_paid_lane).toMatchObject({ state: "waitlisted", grandfathered: false });
      expect(admissionByUser.workspace_only).toMatchObject({ state: "waitlisted", grandfathered: false });
      expect(admissionByUser.classic_grace).toMatchObject({ state: "admitted", tier: "pro", grandfathered: true });
      expect(admissionByUser.classic_expired).toBeUndefined();
    } finally {
      await isolated.close();
    }
  });

  it("writes and validates funding inside the launch-model reservation transaction", async () => {
    await host("h1", 32, 131072);
    // The real v1/v2 custody chain is older than this migration. This stub has
    // the same essential contract for the funding handoff: it inserts the
    // legacy-shape agent row and returns its agentId; the v3 replacement must
    // then stamp and validate funding in the same transaction.
    await pg.exec(`
      create table if not exists public.hivra_launch_model_requests(user_id text, request_id uuid);
      create or replace function public.lock_hivra_owner_agent_slots(text)
      returns void language plpgsql as $$ begin return; end $$;
      create or replace function public.hivra_owner_agent_slot_count(text)
      returns integer language sql as $$ select 0 $$;
      create or replace function public.reserve_hivra_launch_model_request_v2(p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,p_agent jsonb,p_selection jsonb,p_encrypted_key text)
      returns jsonb language plpgsql as $$
      declare v_id uuid;
      begin
        v_id := (p_agent->>'id')::uuid;
        insert into public.hivra_agents(id,user_id,deployment_mode,status,cpu,ram,proxmox_host)
        values(v_id,p_user_id,p_agent->>'deployment_mode','provisioning',
          (p_agent->>'cpu')::numeric,(p_agent->>'ram')::integer,p_agent->>'proxmox_host');
        return jsonb_build_object('status','reserved','agentId',v_id,'phase','waiting');
      end $$;
    `);
    await qualify("launch-model-holder", "pro");
    await pg.exec(
      `insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb)
       values('launch-model-holder','admitted','pro','hermesos',now(),2,4096)`,
    );

    const agent = {
      id: "22222222-2222-4222-8222-222222222222",
      type: "codex",
      name: "Holder seat",
      cpu: 2,
      ram: 4,
      proxmox_host: "h1",
      deployment_mode: "hivra-managed",
      computer_substrate: "proxmox-kvm",
      operation_id: "33333333-3333-4333-8333-333333333333",
      infrastructure_binding_token_hash: "a".repeat(64),
      seat_funding: "holder",
    };
    const result = await pg.query<{ r: Record<string, unknown> }>(
      `select public.reserve_hivra_launch_model_request_v3(
        'launch-model-holder','11111111-1111-4111-8111-111111111111','[]'::jsonb,
        '44444444-4444-4444-8444-444444444444',$1::jsonb,'{}'::jsonb,null,1) as r`,
      [JSON.stringify(agent)],
    );
    expect(result.rows[0].r).toMatchObject({ status: "reserved" });
    const { rows } = await pg.query<{ seat_funding: string }>(
      "select seat_funding from public.hivra_agents where id='22222222-2222-4222-8222-222222222222'",
    );
    expect(rows[0].seat_funding).toBe("holder");

    // The reservation is exactly consumed. A second holder row cannot slip
    // through the launch-model path even though the plan slot count would
    // still allow it.
    const second = { ...agent, id: "55555555-5555-4555-8555-555555555555" };
    await expect(pg.query(
      `select public.reserve_hivra_launch_model_request_v3(
        'launch-model-holder','66666666-6666-4666-8666-666666666666','[]'::jsonb,
        '77777777-7777-4777-8777-777777777777',$1::jsonb,'{}'::jsonb,null,2) as r`,
      [JSON.stringify(second)],
    )).rejects.toThrow(/holder seat funding is not admitted|exceeds the reserved seat resources/);

    const withoutFunding = { ...second };
    delete (withoutFunding as Record<string, unknown>).seat_funding;
    const invalid = await pg.query<{ r: Record<string, unknown> }>(
      `select public.reserve_hivra_launch_model_request_v3(
        'launch-model-holder','88888888-8888-4888-8888-888888888888','[]'::jsonb,
        '99999999-9999-4999-8999-999999999999',$1::jsonb,'{}'::jsonb,null,2) as r`,
      [JSON.stringify(withoutFunding)],
    );
    expect(invalid.rows[0].r).toEqual({ status: "invalid_request" });
  });

  it("requires and atomically validates funding in the direct managed-agent writer", async () => {
    await host("h1", 32, 131072);
    await pg.exec(`
      create or replace function public.lock_hivra_owner_agent_slots(text)
      returns void language plpgsql as $$ begin return; end $$;
      create or replace function public.hivra_owner_agent_slot_count(text)
      returns integer language sql as $$ select 0 $$;
    `);
    const baseRow = {
      user_id: "direct-holder",
      deployment_mode: "hivra-managed",
      status: "provisioning",
      cpu: 2,
      ram: 4,
      proxmox_host: "h1",
    };

    const missing = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hivra_managed_agent($1::jsonb,1) as r",
      [JSON.stringify(baseRow)],
    );
    expect(missing.rows[0].r).toEqual({ status: "invalid_request" });

    const paid = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hivra_managed_agent($1::jsonb,1) as r",
      [JSON.stringify({ ...baseRow, user_id: "direct-paid", seat_funding: "paid" })],
    );
    expect(paid.rows[0].r).toMatchObject({ status: "inserted", row: { seat_funding: "paid" } });

    await qualify("direct-holder", "pro");
    await pg.exec(
      `insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb)
       values('direct-holder','admitted','pro','hermesos',now(),2,4096)`,
    );
    const holder = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hivra_managed_agent($1::jsonb,1) as r",
      [JSON.stringify({ ...baseRow, seat_funding: "holder" })],
    );
    expect(holder.rows[0].r).toMatchObject({ status: "inserted", row: { seat_funding: "holder" } });

    await expect(pg.query(
      "select public.insert_hivra_managed_agent($1::jsonb,2) as r",
      [JSON.stringify({ ...baseRow, seat_funding: "holder" })],
    )).rejects.toThrow(/holder seat funding is not admitted|exceeds the reserved seat resources/);
  });

  it("keeps seat funding immutable and rejects holder rows without an admitted qualified reservation", async () => {
    await qualify("unadmitted", "pro");
    await expect(pg.query(
      `insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host,seat_funding)
       values('unadmitted','hivra-managed','provisioning',1,2,'h1','holder')`,
    )).rejects.toThrow(/holder seat funding is not admitted/);

    await qualify("immutable", "pro");
    await pg.exec(
      `insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb)
       values('immutable','admitted','pro','hermesos',now(),2,4096);
       insert into public.hivra_agents(user_id,deployment_mode,status,cpu,ram,proxmox_host,seat_funding)
       values('immutable','hivra-managed','provisioning',1,2,'h1','holder');`,
    );
    await expect(pg.query(
      "update public.hivra_agents set seat_funding='paid' where user_id='immutable'",
    )).rejects.toThrow(/seat_funding is immutable/);
  });

  it("makes paid Classic insertion, cross-lane insertion and resize consume the same host authority", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('cap',2,8192,1,0,0,1);
    `);
    const classicRow = (id: string, user: string) => ({
      id, user_id: user, status: "provisioning", lifecycle_state: "provisioning",
      cpu_limit: 1, ram_limit: 4096, proxmox_node: "cap", disk_size_gb: 30,
      seat_funding: "paid", infrastructure_provider: "proxmox",
    });
    const first = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hermes_instance($1::jsonb) as r",
      [JSON.stringify(classicRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "paid-a"))],
    );
    expect(first.rows[0].r).toMatchObject({ user_id: "paid-a" });
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify(classicRow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "paid-b"))],
    )).rejects.toThrow(/remaining compute capacity/);
    await expect(pg.query(
      "select public.insert_hivra_managed_agent($1::jsonb,10)",
      [JSON.stringify({ user_id: "hivra-paid", deployment_mode: "hivra-managed", status: "provisioning", cpu: 1, ram: 4, proxmox_host: "cap", seat_funding: "paid" })],
    )).rejects.toThrow(/remaining compute capacity/);

    await pg.exec(`
      update public.proxmox_hosts set total_cpu=4 where id='cap';
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider)
      values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','resize-b','provisioning','provisioning',1,4096,'cap',30,'paid','proxmox');
    `);
    const grown = await pg.query<{ r: ResizeClaim }>(
      "select public.resize_hermes_instance_allocation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','paid-a',2,4096,'01010101-0101-4010-8010-010101010101') as r",
    );
    expect(grown.rows[0].r).toEqual({
      status: "claimed",
      operationId: "01010101-0101-4010-8010-010101010101",
      hostConfigApplied: false,
    });
    await expect(pg.query(
      "select public.resize_hermes_instance_allocation('cccccccc-cccc-4ccc-8ccc-cccccccccccc','resize-b',2,4096,'02020202-0202-4020-8020-020202020202')",
    )).rejects.toThrow(/remaining compute capacity/);
  });

  it("reserves a Hivra resize claim before completion without losing hibernation disk backing", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('resizehost',3,24576,1,0,0,1);
      insert into public.hivra_agents(id,user_id,deployment_mode,status,desired_state,cpu,ram,proxmox_host,vmid,seat_funding)
      values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','resize-owner','hivra-managed','running','running',1,1,'resizehost',501,'paid');
    `);
    const claimed = await pg.query<{ r: boolean }>(
      `select public.claim_hivra_agent_operation(
        'resize-owner','dddddddd-dddd-4ddd-8ddd-dddddddddddd','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'resize','running','{"cpu":2,"ram":1}'::jsonb) as r`,
    );
    expect(claimed.rows[0].r).toBe(true);
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify({ user_id: "other-paid", status: "provisioning", lifecycle_state: "provisioning", cpu_limit: 1, ram_limit: 1024, proxmox_node: "resizehost", disk_size_gb: 30, seat_funding: "paid", infrastructure_provider: "proxmox" })],
    )).rejects.toThrow(/remaining compute capacity/);

    await pg.exec(`
      truncate public.hivra_agents, public.hermes_instances;
      update public.proxmox_hosts set placement_skip_deep_sleep=true, thinpool_size_gb=30, thinpool_overcommit_ratio=1 where id='resizehost';
    `);
    await qualify("sleep-holder", "pro");
    await pg.exec(`
      insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,assigned_host_id)
      values('sleep-holder','admitted','pro','hermesos',now(),2,4096,'resizehost');
      insert into public.hermes_instances(user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,paused_reason,lifecycle_substate)
      values('sleep-holder','stopped','paused',2,4096,'resizehost',30,'holder','holder_idle','holder_hibernated');
    `);
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify({ user_id: "disk-paid", status: "provisioning", lifecycle_state: "provisioning", cpu_limit: 1, ram_limit: 1024, proxmox_node: "resizehost", disk_size_gb: 30, seat_funding: "paid", infrastructure_provider: "proxmox" })],
    )).rejects.toThrow(/remaining disk capacity/);
    await pg.exec("update public.proxmox_hosts set thinpool_size_gb=90 where id='resizehost'");
    const reuse = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hermes_instance($1::jsonb) as r",
      [JSON.stringify({ user_id: "disk-paid", status: "provisioning", lifecycle_state: "provisioning", cpu_limit: 1, ram_limit: 1024, proxmox_node: "resizehost", disk_size_gb: 30, seat_funding: "paid", infrastructure_provider: "proxmox" })],
    );
    expect(reuse.rows[0].r).toMatchObject({ user_id: "disk-paid" });
  });

  it("keeps token requalification grace bounded to the product's 24-hour window", async () => {
    await pg.exec(`
      insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible,last_breach_at)
      values('grace-user','pro','hermesos',false,now() - interval '1 hour');
    `);
    const fresh = await pg.query<{ r: string | null }>(
      "select public.holder_admission_current_tier('grace-user') as r",
    );
    expect(fresh.rows[0].r).toBe("pro");
    await pg.exec("update public.token_tier_qualifications set last_breach_at=now()-interval '25 hours' where user_id='grace-user'");
    const expired = await pg.query<{ r: string | null }>(
      "select public.holder_admission_current_tier('grace-user') as r",
    );
    expect(expired.rows[0].r).toBeNull();
  });

  it("counts Classic provisioning launches in measured disk headroom", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio,capacity_reading,capacity_reading_at)
      values('diskcap',10,32768,1,0,0,1,jsonb_build_object('v',1,'at',now(),'pool',jsonb_build_object('sizeMb',25600,'usedPercent',0)),now());
    `);
    const row = (id: string, user: string) => ({
      id, user_id: user, status: "provisioning", lifecycle_state: "provisioning",
      cpu_limit: 1, ram_limit: 1024, proxmox_node: "diskcap", disk_size_gb: 30,
      seat_funding: "paid", infrastructure_provider: "proxmox",
    });
    const first = await pg.query<{ r: Record<string, unknown> }>("select public.insert_hermes_instance($1::jsonb) as r", [JSON.stringify(row("11111111-1111-4111-8111-111111111111", "disk-a"))]);
    expect(first.rows[0].r).toMatchObject({ user_id: "disk-a" });
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify(row("22222222-2222-4222-8222-222222222222", "disk-b"))],
    )).rejects.toThrow(/remaining disk capacity/);
  });

  it("checks paid tier allocation increases against host capacity atomically", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('tiercap',3,16384,1,0,0,1);
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider,resource_tier)
      values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tier-owner','running','active',1,4096,'tiercap',30,'paid','proxmox','operator'),
            ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','tier-owner','running','active',1,4096,'tiercap',30,'paid','proxmox','operator');
    `);
    await expect(pg.query(
      "select public.apply_hermes_tier_allocations('tier-owner',false,'fleet',$1)",
      [JSON.stringify([
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", previous_tier: "operator", previous_cpu: 1, previous_ram: 4096, cpu_limit: 2, ram_limit: 4096 },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", previous_tier: "operator", previous_cpu: 1, previous_ram: 4096, cpu_limit: 1, ram_limit: 4096 },
      ])],
    )).rejects.toThrow(/remaining compute capacity/);
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.hermes_instances where resource_tier='operator' and cpu_limit=1",
    );
    expect(rows[0].n).toBe(2);
  });

  it("preserves the dedicated Workspace host and empty-registry fallback contracts", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio,status)
      values('wrk1',8,32768,1,0,0,1,'maintenance');
    `);
    const row = (surface: string, user: string, id: string, hostId = "wrk1", cpuLimit = 1) => ({
      id, user_id: user, status: "provisioning", lifecycle_state: "provisioning",
      cpu_limit: cpuLimit, ram_limit: 1024, proxmox_node: hostId, disk_size_gb: 30,
      seat_funding: "paid", infrastructure_provider: "proxmox", product_surface: surface,
    });
    const workspace = await pg.query<{ r: Record<string, unknown> }>("select public.insert_hermes_instance($1::jsonb) as r", [JSON.stringify(row("workspace_cloud", "workspace-user", "33333333-3333-4333-8333-333333333333"))]);
    expect(workspace.rows[0].r).toMatchObject({ user_id: "workspace-user" });
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify(row("hermesos", "ordinary-user", "44444444-4444-4444-8444-444444444444"))],
    )).rejects.toThrow(/not available for placement/);

    const dedicated = await pg.query<{ r: Record<string, unknown> }>(
      "select public.insert_hermes_instance($1::jsonb) as r",
      [JSON.stringify(row("workspace_cloud", "workspace-user-dedicated", "66666666-6666-4666-8666-666666666666", "dedicated-unregistered"))],
    );
    expect(dedicated.rows[0].r).toMatchObject({ user_id: "workspace-user-dedicated", proxmox_node: "dedicated-unregistered" });

    await pg.exec(`
      truncate public.hermes_instances, public.proxmox_hosts;
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio,status)
      values('wrkactive',2,8192,2,0,0,1,'active');
    `);
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [JSON.stringify(row("workspace_cloud", "workspace-zero-cpu", "77777777-7777-4777-8777-777777777777", "wrkactive", 2))],
    )).rejects.toThrow(/not available for placement|remaining compute capacity/);

    await pg.exec("truncate public.hermes_instances, public.proxmox_hosts");
    const fallback = await pg.query<{ r: Record<string, unknown> }>("select public.insert_hermes_instance($1::jsonb) as r", [JSON.stringify(row("hermesos", "fallback-user", "55555555-5555-4555-8555-555555555555", "envhost"))]);
    expect(fallback.rows[0].r).toMatchObject({ user_id: "fallback-user", proxmox_node: "envhost" });
  });

  it("reserves the larger Classic resize size per axis until fenced completion or rollback", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('resizecap',5,32768,1,0,0,1);
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider,resource_tier)
      values('66666666-6666-4666-8666-666666666666','resize-owner','running','active',2,4096,'resizecap',30,'paid','proxmox','operator');
    `);
    const begin = (cpu: number, ram: number, op: string) => pg.query<{ r: ResizeClaim }>(
      "select public.resize_hermes_instance_allocation('66666666-6666-4666-8666-666666666666','resize-owner',$1,$2,$3::uuid) as r",
      [cpu, ram, op],
    );
    const finish = (fn: string, op: string) => pg.query<{ r: boolean }>(
      `select public.${fn}('66666666-6666-4666-8666-666666666666','resize-owner',$1::uuid) as r`,
      [op],
    );
    const read = async () => (await pg.query<{ cpu_limit: number; ram_limit: number; resize_operation_id: string | null }>(
      "select cpu_limit::float, ram_limit, resize_operation_id::text from public.hermes_instances where id='66666666-6666-4666-8666-666666666666'",
    )).rows[0];

    const shrinkOp = "77777777-7777-4777-8777-777777777777";
    expect((await begin(1, 2048, shrinkOp)).rows[0].r).toEqual({
      status: "claimed",
      operationId: shrinkOp,
      hostConfigApplied: false,
    });
    expect((await begin(1, 2048, shrinkOp)).rows[0].r).toEqual({
      status: "reused",
      operationId: shrinkOp,
      hostConfigApplied: false,
    });
    expect(await read()).toEqual({ cpu_limit: 2, ram_limit: 4096, resize_operation_id: shrinkOp });
    await expect(begin(1, 2048, "88888888-8888-4888-8888-888888888888")).rejects.toThrow(/already in progress/);
    expect((await finish("rollback_hermes_instance_resize_allocation", "88888888-8888-4888-8888-888888888888")).rows[0].r).toBe(false);
    expect((await read()).cpu_limit).toBe(2);
    expect((await finish("complete_hermes_instance_resize_allocation", shrinkOp)).rows[0].r).toBe(true);
    expect(await read()).toEqual({ cpu_limit: 1, ram_limit: 2048, resize_operation_id: null });

    const growOp = "99999999-9999-4999-8999-999999999999";
    expect((await begin(2, 4096, growOp)).rows[0].r).toEqual({
      status: "claimed",
      operationId: growOp,
      hostConfigApplied: false,
    });
    expect((await read()).cpu_limit).toBe(2);
    expect((await finish("complete_hermes_instance_resize_allocation", shrinkOp)).rows[0].r).toBe(false);
    expect((await read()).cpu_limit).toBe(2);
    expect((await finish("rollback_hermes_instance_resize_allocation", growOp)).rows[0].r).toBe(true);
    expect(await read()).toEqual({ cpu_limit: 1, ram_limit: 2048, resize_operation_id: null });
  });

  it("rejects a tier allocation write while a Classic resize claim is outstanding", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('tierfence',8,32768,1,0,0,1);
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider,resource_tier)
      values('11111111-1111-4111-8111-111111111111','fence-owner','running','active',2,4096,'tierfence',30,'paid','proxmox','operator');
    `);
    const resizeOp = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const claimed = await pg.query<{ r: ResizeClaim }>(
      "select public.resize_hermes_instance_allocation('11111111-1111-4111-8111-111111111111','fence-owner',1,2048,$1::uuid) as r",
      [resizeOp],
    );
    expect(claimed.rows[0].r).toEqual({
      status: "claimed",
      operationId: resizeOp,
      hostConfigApplied: false,
    });

    await expect(pg.query(
      "select public.apply_hermes_tier_allocations('fence-owner',false,'fleet',$1)",
      [JSON.stringify([{
        id: "11111111-1111-4111-8111-111111111111",
        previous_tier: "operator",
        previous_cpu: 2,
        previous_ram: 4096,
        cpu_limit: 3,
        ram_limit: 4096,
        operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }])],
    )).rejects.toThrow(/already in progress/);
    expect((await pg.query<{ cpu_limit: number; resource_tier: string }>(
      "select cpu_limit::float, resource_tier from public.hermes_instances where id='11111111-1111-4111-8111-111111111111'",
    )).rows[0]).toEqual({ cpu_limit: 2, resource_tier: "operator" });

    expect((await pg.query<{ r: boolean }>(
      "select public.complete_hermes_instance_resize_allocation('11111111-1111-4111-8111-111111111111','fence-owner',$1::uuid) as r",
      [resizeOp],
    )).rows[0].r).toBe(true);
    expect((await pg.query<{ cpu_limit: number; resource_tier: string }>(
      "select cpu_limit::float, resource_tier from public.hermes_instances where id='11111111-1111-4111-8111-111111111111'",
    )).rows[0]).toEqual({ cpu_limit: 1, resource_tier: "operator" });
  });

  it("does not release shrunk Classic capacity until fenced completion", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('shrinkcap',4,8192,1,0,0,1);
      update public.proxmox_hosts set thinpool_size_gb=90, thinpool_overcommit_ratio=1 where id='shrinkcap';
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider,resource_tier)
      values('22222222-2222-4222-8222-222222222222','shrink-owner','running','active',2,2048,'shrinkcap',30,'paid','proxmox','fleet');
    `);
    const shrinkOp = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await pg.query(
      "select public.apply_hermes_tier_allocations('shrink-owner',false,'operator',$1)",
      [JSON.stringify([{
        id: "22222222-2222-4222-8222-222222222222",
        previous_tier: "fleet",
        previous_cpu: 2,
        previous_ram: 2048,
        cpu_limit: 1,
        ram_limit: 1024,
        operation_id: shrinkOp,
      }])],
    );
    const read = async () => (await pg.query<{ cpu_limit: number; ram_limit: number; resize_operation_id: string | null }>(
      "select cpu_limit::float, ram_limit, resize_operation_id::text from public.hermes_instances where id='22222222-2222-4222-8222-222222222222'",
    )).rows[0];
    expect(await read()).toEqual({ cpu_limit: 2, ram_limit: 2048, resize_operation_id: shrinkOp });

    const competitor = JSON.stringify({
      id: "33333333-3333-4333-8333-333333333333",
      user_id: "competing-paid",
      status: "provisioning",
      lifecycle_state: "provisioning",
      cpu_limit: 2,
      ram_limit: 1024,
      proxmox_node: "shrinkcap",
      disk_size_gb: 30,
      seat_funding: "paid",
      infrastructure_provider: "proxmox",
    });
    await expect(pg.query(
      "select public.insert_hermes_instance($1::jsonb)",
      [competitor],
    )).rejects.toThrow(/remaining compute capacity/);

    expect((await pg.query<{ r: boolean }>(
      "select public.complete_hermes_instance_resize_allocation('22222222-2222-4222-8222-222222222222','shrink-owner',$1::uuid) as r",
      [shrinkOp],
    )).rows[0].r).toBe(true);
    expect(await read()).toEqual({ cpu_limit: 1, ram_limit: 1024, resize_operation_id: null });
    const inserted = await pg.query<{ r: { user_id: string } }>(
      "select public.insert_hermes_instance($1::jsonb) as r",
      [competitor],
    );
    expect(inserted.rows[0].r).toMatchObject({ user_id: "competing-paid" });
  });

  it("reconciles an interrupted Classic resize only for the stored operation and target", async () => {
    await pg.exec(`
      insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio)
      values('reconcilecap',8,32768,1,0,0,1);
      insert into public.hermes_instances(id,user_id,status,lifecycle_state,cpu_limit,ram_limit,proxmox_node,disk_size_gb,seat_funding,infrastructure_provider,resource_tier)
      values('44444444-4444-4444-8444-444444444444','reconcile-owner','running','active',2,2048,'reconcilecap',30,'paid','proxmox','fleet');
    `);
    const batch = (operationId: string, previousTier = "fleet") => [{
      id: "44444444-4444-4444-8444-444444444444",
      previous_tier: previousTier,
      previous_cpu: 2,
      previous_ram: 2048,
      cpu_limit: 1,
      ram_limit: 1024,
      operation_id: operationId,
    }];
    const apply = (operationId: string, previousTier = "fleet") => pg.query(
      "select public.apply_hermes_tier_allocations('reconcile-owner',false,'operator',$1)",
      [JSON.stringify(batch(operationId, previousTier))],
    );
    const firstOperation = "55555555-5555-4555-8555-555555555555";

    await apply(firstOperation);
    await apply(firstOperation, "operator");
    await expect(apply("66666666-6666-4666-8666-666666666666", "operator")).rejects.toThrow(/already in progress/);
    expect((await pg.query<{ cpu_limit: number; resize_operation_id: string }>(
      "select cpu_limit::float, resize_operation_id::text from public.hermes_instances where id='44444444-4444-4444-8444-444444444444'",
    )).rows[0]).toEqual({ cpu_limit: 2, resize_operation_id: firstOperation });
  });

  it("takes the holder funding lock before the placement lock on capacity write paths", () => {
    const placementSql = fs.readFileSync(path.join(path.dirname(MIGRATION), "20261125040000_durable_proxmox_placement.sql"), "utf8");
    const assertStart = placementSql.indexOf("create or replace function public.assert_proxmox_placement_capacity(");
    const assertEnd = placementSql.indexOf("$$;", assertStart);
    const assertBody = placementSql.slice(assertStart, assertEnd);
    const ownerLock = assertBody.indexOf("holder-seat-funding-v1:");
    const placementLock = assertBody.indexOf("holder-admissions-v1");
    expect(ownerLock).toBeGreaterThanOrEqual(0);
    expect(placementLock).toBeGreaterThan(ownerLock);

    const applyStart = placementSql.indexOf("create or replace function public.apply_hermes_tier_allocations(");
    const applyEnd = placementSql.indexOf("$$;", applyStart);
    const applyBody = placementSql.slice(applyStart, applyEnd);
    const applyOwnerLock = applyBody.indexOf("holder-seat-funding-v1:");
    const applyCapacityCheck = applyBody.indexOf("assert_proxmox_placement_capacity");
    expect(applyOwnerLock).toBeGreaterThanOrEqual(0);
    expect(applyCapacityCheck).toBeGreaterThan(applyOwnerLock);
  });

  it("keeps the Node VM modules flag in the shared and CI Jest invocations", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const script of ["test", "test:ci"]) {
      expect(pkg.scripts[script]).toMatch(/NODE_OPTIONS=.*--experimental-vm-modules/);
    }
    const workflow = fs.readFileSync(path.resolve(__dirname, "../../../../../.github/workflows/dashboard-ci.yml"), "utf8");
    expect(workflow).toContain("NODE_OPTIONS=--experimental-vm-modules npm run test:ci");
  });

});
