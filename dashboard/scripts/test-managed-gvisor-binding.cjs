// Offline PGlite proof. Only the infrastructure tables and selected existing
// constraints come from migrations. The reservation schema is synthetic.
// Replay takes a trusted, authenticated customer ID. This fixture does not
// exercise API authorization, billing, the production triggers, or dispatch.
//
// Before enabling managed launch, reserve the customer-owned agent, request
// identity, operation and operator binding atomically. Replay must use shared
// customer/request uniqueness across deployment modes and reject changed input.
// Observe/exec and all lifecycle operations must resolve the exact persisted
// authority, never select a replacement from current config. Keep uncertain
// operations and their binding for reconciliation. Release live capacity only
// after authoritative absence (or proven never-created), retaining a customer-
// scoped tombstone with request identity and the exact cleanup receipt.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migration = (name) => readFileSync(path.join(__dirname, "../supabase/migrations", name), "utf8");
const connection = "66666666-6666-4666-8666-666666666666";
const target = "77777777-7777-4777-8777-777777777777";
const foreignTarget = "88888888-8888-4888-8888-888888888888";
const request = "99999999-9999-4999-8999-999999999999";
const operator = "operator-fixture";

async function main() {
  const db = new PGlite();
  try {
    const infrastructure = migration("20260825170000_infrastructure_connections.sql");
    const portable = migration("20260826120000_portable_hivra_target_bindings.sql");
    const gvisor = migration("20260915170000_hivra_gvisor_computers.sql");
    // Isolate the real table declarations and binding constraints from unrelated RPCs.
    for (const table of ["infrastructure_connections", "deployment_targets"]) {
      await db.exec(infrastructure.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]+?\\n\\);`))[0]);
    }
    await db.exec(portable.slice(portable.indexOf("alter table public.deployment_targets"),
      portable.indexOf("alter table public.hivra_agents")));
    await db.exec(gvisor.slice(gvisor.indexOf("alter table public.deployment_targets"),
      gvisor.indexOf("alter table public.hivra_agents")));
    const hostConnections = migration("20260826140000_host_connections_v2.sql");
    await db.exec(hostConnections.slice(0, hostConnections.indexOf("create or replace function")));
    for (const [id, owner] of [[connection, operator], [foreignTarget, "foreign-operator"]]) {
      await db.query(`insert into infrastructure_connections
        (id,user_id,name,provider,status,ssh_host,ssh_host_fingerprint_sha256,revision)
        values ($1,$2,'fixture','host','ready','fixture.invalid',repeat('a',64),7)`, [id, owner]);
    }
    for (const [id, owner, host] of [[target, operator, connection], [foreignTarget, "foreign-operator", foreignTarget]]) {
      await db.query(`insert into deployment_targets
        (id,user_id,connection_id,external_id,display_name,status,evidence_connection_revision,
         isolation_class,supported_isolation_drivers,capabilities)
        values ($1,$2,$3,'fixture','fixture','ready',7,'application-kernel',
         array['gvisor-runsc'],'{"kind":"gvisor","launchReady":true}')`, [id, owner, host]);
    }
    await db.exec(`
      create table hivra_agents (id uuid primary key default gen_random_uuid(), user_id text not null,
        deployment_target_id uuid, infrastructure_connection_id uuid, gvisor_launch_request_id uuid,
        computer_substrate text, deployment_mode text, vmid int, provider_capacity_order_id uuid,
        provider_enrollment_attempt_id uuid, provider_server_id text, gvisor_sandbox_id uuid,
        gvisor_adapter_version text, gvisor_adapter_sha256 text, gvisor_runtime_sha256 text,
        computer_profile text, type text, cpu_max numeric, cpu numeric, ram_max numeric, ram numeric,
        status text, infrastructure_connection_revision bigint, gvisor_cleanup_receipt jsonb,
        infrastructure_binding_token_enforced boolean,
        constraint hivra_agents_provider_identity_check check (true));
    `);
    const ownerFk = portable.match(/add constraint hivra_agents_self_managed_target_fk[\s\S]+?on delete restrict;/)[0];
    const requestIndex = gvisor.match(/create unique index hivra_agents_gvisor_launch_request_unique[\s\S]+?;/)[0];
    await db.exec("alter table hivra_agents " + ownerFk);
    await db.exec(requestIndex);
    const system = migration("20260923120000_digitalocean_managed_agent_sessions.sql");
    await db.exec(system.match(/alter table public\.hivra_agents\s+drop constraint hivra_agents_provider_identity_check,[\s\S]+?\) is true\);/)[0]);
    const adapter = migration("20261020150000_gvisor_sandbox_update.sql");
    await db.exec(adapter.slice(adapter.indexOf("do $migration$"), adapter.indexOf("  -- 2. Target evidence"))
      + "end; $migration$;");
    const agent = (owner, mode = "self-managed") => db.query(`insert into hivra_agents
      (user_id,deployment_mode,deployment_target_id,infrastructure_connection_id,gvisor_launch_request_id,
       computer_substrate,gvisor_sandbox_id,gvisor_adapter_version,gvisor_adapter_sha256,gvisor_runtime_sha256,
       computer_profile,type,cpu_max,cpu,ram_max,ram,status,infrastructure_connection_revision,infrastructure_binding_token_enforced)
      values ($1,$2,$3,$4,$5,'gvisor',gen_random_uuid(),'2026.10.20.1',repeat('a',64),repeat('b',64),
       'linux-terminal','linux-terminal',2,2,4,4,'provisioning',7,true)`, [owner, mode, target, connection, request]);
    await assert.rejects(agent("customer-a", "hivra-managed"), { code: "23514", constraint: "hivra_agents_provider_identity_check" });
    await assert.rejects(agent("customer-a"), { code: "23503", constraint: "hivra_agents_self_managed_target_fk" });
    await agent(operator);
    await assert.rejects(agent(operator), { code: "23505", constraint: "hivra_agents_gvisor_launch_request_unique" });

    // Synthetic reservation only. It does not create an agent or grant a
    // lifecycle operation. A production writer would own this whole transaction.
    await db.exec(`
      create table configured_operator_target (
        operator_id text not null, connection_id uuid not null, target_id uuid not null,
        revision bigint not null check (revision > 0),
        primary key (operator_id, connection_id, target_id, revision),
        foreign key (target_id, connection_id, operator_id)
          references deployment_targets (id, connection_id, user_id)
      );
      create table managed_gvisor_reservation (
        computer_id uuid primary key default gen_random_uuid(),
        customer_id text not null check (btrim(customer_id) <> ''),
        request_id uuid not null,
        operator_id text not null, connection_id uuid not null, target_id uuid not null,
        revision bigint not null,
        constraint managed_request_key unique (customer_id, request_id),
        constraint managed_distinct_owner check (customer_id <> operator_id),
        constraint managed_configured_target_fk foreign key (operator_id, connection_id, target_id, revision)
          references configured_operator_target on update restrict on delete restrict
      );
      create function guard_managed_fixture_reservation() returns trigger language plpgsql as $$
      begin
        if tg_op <> 'INSERT' then
          raise exception 'managed reservation is immutable' using errcode = '55000';
        end if;
        perform 1 from deployment_targets t join infrastructure_connections c
          on (t.connection_id,t.user_id) = (c.id,c.user_id)
          where (t.id,t.connection_id,t.user_id) = (new.target_id,new.connection_id,new.operator_id)
            and t.evidence_connection_revision = new.revision and c.revision = new.revision
            and t.status = 'ready' and c.status = 'ready' and c.provider = 'host'
            and t.isolation_class = 'application-kernel'
            and t.supported_isolation_drivers = array['gvisor-runsc']
            and t.capabilities @> '{"kind":"gvisor","launchReady":true}'
          for share of t,c;
        if not found then
          raise exception 'managed target evidence does not match' using errcode = '55006';
        end if;
        return new;
      end $$;
      create trigger managed_fixture_reservation_guard before insert or update or delete
        on managed_gvisor_reservation for each row execute function guard_managed_fixture_reservation();
    `);
    await db.query("insert into configured_operator_target values ($1,$2,$3,7)", [operator, connection, target]);
    const reserve = (customer, owner = operator, host = connection, placement = target, revision = 7) =>
      db.query(`insert into managed_gvisor_reservation
        (customer_id,request_id,operator_id,connection_id,target_id,revision)
        values ($1,$2,$3,$4,$5,$6) returning computer_id`,
      [customer, request, owner, host, placement, revision]);
    const replay = async (customer) => (await db.query(`select computer_id from managed_gvisor_reservation
      where customer_id=$1 and request_id=$2`, [customer, request])).rows;

    const original = (await reserve("customer-a")).rows;
    await assert.rejects(reserve("customer-a"), { code: "23505", constraint: "managed_request_key" });
    assert.deepEqual(await replay("customer-a"), original);
    assert.deepEqual(await replay("customer-b"), []);
    assert.deepEqual(await replay(operator), []);
    const independent = (await reserve("customer-b")).rows;
    assert.notDeepEqual(independent, original);
    assert.deepEqual(await replay("customer-b"), independent);
    await assert.rejects(reserve(operator), { code: "23514", constraint: "managed_distinct_owner" });
    await assert.rejects(reserve("customer-c", "foreign-operator", foreignTarget, foreignTarget),
      { code: "23503", constraint: "managed_configured_target_fk" });
    await assert.rejects(reserve("customer-c", operator, connection, foreignTarget), { code: "55006" });
    await assert.rejects(reserve("customer-c", operator, connection, target, 8), { code: "55006" });
    // Connection rotation invalidates reads for new reservations even when the
    // old target evidence and configured authority still match each other.
    await db.query("update infrastructure_connections set revision=8 where id=$1", [connection]);
    await assert.rejects(reserve("customer-c"), { code: "55006" });

    for (const assignment of ["customer_id='customer-c'", "operator_id='foreign-operator'",
      `connection_id='${foreignTarget}'`, `target_id='${foreignTarget}'`, "revision=8"]) {
      await assert.rejects(db.query(`update managed_gvisor_reservation set ${assignment} where computer_id=$1`,
        [original[0].computer_id]), { code: "55000" });
    }
    await assert.rejects(db.query("update configured_operator_target set revision=8 where target_id=$1", [target]),
      { code: "23001", constraint: "managed_configured_target_fk" });
    await assert.rejects(db.query("delete from managed_gvisor_reservation where computer_id=$1",
      [original[0].computer_id]), { code: "55000" });
    assert.deepEqual(await replay("customer-a"), original);
    console.log("Managed gVisor binding proof passed: exact authority, tenant-scoped replay, original FK/index, rotation and immutability.");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
