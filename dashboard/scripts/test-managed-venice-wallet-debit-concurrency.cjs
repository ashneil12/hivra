// Opt-in: real PostgreSQL sessions racing managed-Venice wallet debits.
//
// Uses only an already-present image (postgres:17-alpine by default, or
// HIVRA_TEST_POSTGRES_IMAGE), with no network, host ports, host mounts,
// credentials or persistent volume. It proves, with separate backends:
//   1. the control: the application's old read-then-write lot debit loses a
//      debit when two sessions interleave (the review's race is real here);
//   2. while one capture holds the wallet lock, the other captures and a
//      hold-less overage debit queue on it (seen in pg_stat_activity) and then
//      every one of them lands;
//   3. twenty captures fired at once all land, and none twice.
// test-managed-venice-atomic-wallet-debits.cjs covers the same functions in
// PGlite on every CI run.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const FILES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
  "20260925201500_managed_venice_atomic_wallet_debits.sql",
];
const USER = "user_race";
const IMAGE = process.env.HIVRA_TEST_POSTGRES_IMAGE || "postgres:17-alpine";

function cleanupOwnedContainer(docker, name, owner) {
  const id = docker(["ps", "--all", "--no-trunc", "--quiet", "--filter", `name=^/${name}$`]);
  if (!id) return;
  assert.match(id, /^[a-f0-9]{64}$/, "exactly one full container ID required");
  assert.equal(docker(["inspect", id, "--format", '{{index .Config.Labels "hivra.test.owner"}}']), owner);
  docker(["stop", "--time", "3", id]);
  if (docker(["ps", "--all", "--quiet", "--filter", `id=${id}`])) docker(["rm", id]);
  assert.equal(docker(["ps", "--all", "--quiet", "--filter", `id=${id}`]), "");
}

async function main() {
  const owner = randomUUID();
  const name = `hivra-wallet-race-${owner}`;
  const docker = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 15_000 }).trim();
  const image = docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const sessions = [];
  let attempted = false;

  function session(label) {
    const app = `${owner}-${label}`;
    const child = spawn("docker", [
      "exec", "-e", `PGAPPNAME=${app}`, "-i", name,
      "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0", "-U", "postgres",
    ]);
    let pending = null;
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (pending && output.includes(`${pending.marker}\n`)) {
        const at = output.indexOf(`${pending.marker}\n`);
        const result = output.slice(0, at).trim();
        output = output.slice(at + pending.marker.length + 1);
        const error = errors;
        errors = "";
        clearTimeout(pending.timer);
        const { resolve, reject } = pending;
        pending = null;
        if (error.includes("ERROR:")) reject(new Error(error.trim()));
        else resolve(result);
      }
    });
    child.stderr.on("data", (data) => { errors += data; });
    child.on("exit", (code) => {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`psql ${label} exited ${code}: ${errors}`));
        pending = null;
      }
    });
    const handle = {
      app,
      child,
      run(sql) {
        assert.equal(pending, null, "one statement batch per session at a time");
        return new Promise((resolve, reject) => {
          const marker = `DONE_${randomUUID().replaceAll("-", "")}`;
          const timer = setTimeout(() => { pending = null; reject(new Error(`session ${label} exceeded 20s`)); }, 20_000);
          pending = { marker, resolve, reject, timer };
          child.stdin.write(`${sql};\n\\echo ${marker}\n`);
        });
      },
    };
    sessions.push(handle);
    return handle;
  }

  try {
    attempted = true;
    docker([
      "run", "--detach", "--rm", "--name", name, "--label", `hivra.test.owner=${owner}`,
      "--network", "none", "--memory", "256m", "--cpus", "1", "--pids-limit", "128",
      "--tmpfs", "/var/lib/postgresql/data:rw,size=256m",
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image,
    ]);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (docker(["exec", name, "cat", "/proc/1/comm"]) === "postgres") {
          docker(["exec", name, "pg_isready", "-U", "postgres"]);
          // initdb's temporary server also answers; confirm a real query.
          docker(["exec", name, "psql", "-U", "postgres", "-c", "select 1"]);
          break;
        }
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
      if (Date.now() > deadline) throw new Error("PostgreSQL did not start");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const admin = session("admin");
    await admin.run(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      ${FILES.map((file) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8")).join("\n")}
    `);
    const account = await admin.run(
      `insert into public.managed_venice_wallet_accounts (user_id) values ('${USER}') returning id`
    );
    const reset = (lotValue, holds) => admin.run(`
      delete from public.managed_venice_reservations;
      delete from public.managed_venice_token_lots;
      insert into public.managed_venice_token_lots
        (id, account_id, user_id, token_amount_raw, remaining_token_amount_raw, snapshot_price_usd,
         original_value_micro_usd, remaining_value_micro_usd, quote_source, quoted_at)
      values ('00000000-0000-4000-8000-000000000001', '${account}', '${USER}', ${lotValue}, ${lotValue},
              '0.001', ${lotValue}, ${lotValue}, 'test', now());
      ${holds.map(([reference, amount]) => `
        insert into public.managed_venice_reservations
          (account_id, user_id, wallet_type, reference_id, estimated_cost_micro_usd, reserved_micro_usd)
        values ('${account}', '${USER}', 'hermesos', '${reference}', ${amount}, ${amount});`).join("")}
    `);
    const lotValue = async () => Number(await admin.run(
      "select remaining_value_micro_usd from public.managed_venice_token_lots"
    ));
    const capture = (reference, amount) =>
      `select (public.capture_managed_venice_reservation('${USER}', '${reference}', ${amount}))->>'captured'`;

    // 1. Control: the old application debit (read the lot, then write the
    //    value it computed) loses one of two interleaved debits.
    await reset(1_000_000, []);
    const readerA = session("old-a");
    const readerB = session("old-b");
    const readA = Number(await readerA.run("begin; select remaining_value_micro_usd from public.managed_venice_token_lots"));
    const readB = Number(await readerB.run("begin; select remaining_value_micro_usd from public.managed_venice_token_lots"));
    await readerA.run(`update public.managed_venice_token_lots set remaining_value_micro_usd = ${readA - 50_000}; commit`);
    await readerB.run(`update public.managed_venice_token_lots set remaining_value_micro_usd = ${readB - 50_000}; commit`);
    assert.equal(await lotValue(), 950_000, "control: the old read-then-write shape should lose a debit");

    // 2. One capture holds the wallet lock; nine captures and an overage
    //    debit queue behind it on the database, then all of them land.
    const holds = Array.from({ length: 10 }, (_, index) => [`image_${index}`, 50_000]);
    await reset(1_000_000, holds);
    const holder = session("holder");
    assert.equal(await holder.run(`begin; ${capture("image_0", 50_000)}`), "true");
    const waiters = holds.slice(1).map(([reference, amount]) => {
      const waiter = session(`waiter-${reference}`);
      return { waiter, result: waiter.run(capture(reference, amount)) };
    });
    const overage = session("overage");
    const overageResult = overage.run(
      `select (public.debit_managed_venice_wallet('${USER}', 'hermesos', 25000, 'image_0:overage'))->>'debited'`
    );
    const blockedApps = [...waiters.map(({ waiter }) => waiter.app), overage.app];
    const until = Date.now() + 10_000;
    let blocked = 0;
    while (Date.now() < until) {
      blocked = Number(await admin.run(
        `select count(*) from pg_stat_activity
          where application_name in (${blockedApps.map((app) => `'${app}'`).join(",")})
            and wait_event_type = 'Lock'`
      ));
      if (blocked === blockedApps.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(blocked, blockedApps.length, "every other debit should be waiting on the wallet lock");
    await holder.run("commit");
    assert.deepEqual(await Promise.all(waiters.map(({ result }) => result)), Array(9).fill("true"));
    assert.equal(await overageResult, "true");
    assert.equal(await lotValue(), 1_000_000 - 10 * 50_000 - 25_000);
    assert.equal(await admin.run("select count(*) from public.managed_venice_reservations where status = 'captured'"), "10");

    // 3. Twenty captures fired at once, each from its own session, and each
    //    hold captured twice: every debit lands exactly once.
    const burst = Array.from({ length: 20 }, (_, index) => [`burst_${index}`, 40_000]);
    await reset(1_000_000, burst);
    const racers = Array.from({ length: 20 }, (_, index) => session(`racer-${index}`));
    const outcomes = await Promise.all([
      ...burst.map(([reference, amount], index) => racers[index].run(capture(reference, amount))),
    ]);
    assert.deepEqual(outcomes, Array(20).fill("true"));
    const repeats = await Promise.all(
      burst.map(([reference, amount], index) => racers[index].run(capture(reference, amount)))
    );
    assert.deepEqual(repeats, Array(20).fill("false"));
    assert.equal(await lotValue(), 1_000_000 - 20 * 40_000);

    console.log(`PASS real PostgreSQL wallet debits: control lost a debit; ${blockedApps.length} queued on the lock and all landed; 20 concurrent captures landed once each; image ${IMAGE}`);
  } finally {
    for (const handle of sessions) handle.child.stdin.end();
    if (attempted) {
      cleanupOwnedContainer(docker, name, owner);
      console.log("CLEANUP verified: owned container absent; tmpfs database removed; no host ports or persistent volumes");
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { main };
