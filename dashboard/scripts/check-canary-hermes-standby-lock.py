#!/usr/bin/env python3
"""Exercise standby claims and paid placement in three local Postgres sessions."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import subprocess
import time
import uuid

APP = Path(__file__).resolve().parents[1]
NAME = "hermes-standby-lock-" + uuid.uuid4().hex[:12]
IMAGE = "postgres:16-alpine"
OWNER = "standby-lock-fixture"
DIGEST = "a" * 64
GENERATION, A, B, C, OP_A, OP_B, OP_C = [
    f"11111111-0000-4000-8000-{i:012d}" for i in range(1, 8)
]


def docker(*args, input=None, check=True):
    return subprocess.run(
        ["docker", *args], input=input, check=check, timeout=60, capture_output=True, text=True
    )


def sql(statement, label="controller", check=True):
    result = docker(
        "exec", "-i", "-e", f"PGAPPNAME={label}", NAME, "psql", "-X", "-qAt", "-U", "postgres",
        "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", input=statement, check=check,
    )
    return result.stdout.strip() if check else result


def wait_for_sessions(predicate, expected):
    for _ in range(60):
        if sql(f"select count(*) from pg_stat_activity where {predicate};") == str(expected):
            return
        time.sleep(0.05)
    raise AssertionError(f"expected {expected} distinct query sessions matching {predicate}")


def paid_insert(agent, operation, **overrides):
    fixture = dict(
        id=agent, user_id=OWNER, name="Warm race", type="hermes", proxmox_host="",
        status="provisioning", deployment_mode="hivra-managed", computer_substrate="proxmox-kvm",
        managed_provisioner_channel="canary", seat_funding="paid", cpu=2, ram=4,
        desired_state="running", operation_id=operation, operation_kind="provision",
        operation_payload={"stage": "pre_allocation_access"}, infrastructure_binding_token_enforced=True,
        infrastructure_binding_token_hash="b" * 64,
    )
    fixture.update(overrides)
    return (
        "select public.insert_hivra_managed_agent("
        f"jsonb_build_object('operation_started_at',now()) || '{json.dumps(fixture)}'::jsonb,2,null,false);"
    )


def claim(agent, operation):
    return (
        f"select public.claim_hivra_hermes_standby('{OWNER}','{agent}','{operation}',"
        f"'fixture-standby-host','{GENERATION}',9354,'192.0.2.42','{DIGEST}');"
    )


def verify():
    schema = subprocess.check_output([
        "node", "-e",
        "const x=require('./scripts/lib/pglite-all-migrations.cjs'); "
        "console.log(x.SUPABASE_STUBS); for (const file of x.migrationFiles()) console.log(x.readMigration(file));",
    ], cwd=APP, text=True)
    sql(schema)
    sql(f"""
        insert into public.proxmox_hosts
          (id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,
            cpu_overcommit_ratio,thinpool_size_gb)
        values ('fixture-standby-host',10,16384,0,0,0,1,100);
        select public.reserve_hivra_hermes_standby('{OWNER}','fixture-standby-host','{GENERATION}',9354,
          '192.0.2.42','{DIGEST}',2,4096,40,now()+interval '10 minutes');
        select public.advance_hivra_hermes_standby('{GENERATION}','make_available');
        {paid_insert(A, OP_A)} {paid_insert(B, OP_B)}
    """)
    oversized = paid_insert(C, OP_C, user_id="different-race-owner", proxmox_host="fixture-standby-host", ram=13)
    with ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(sql, "begin; " + claim(A, OP_A) + " select pg_sleep(8); commit;", "first_claim")
        wait_for_sessions("application_name='first_claim' and wait_event='PgSleep'", 1)
        second = pool.submit(sql, claim(B, OP_B), "competing_claim")
        paid = pool.submit(sql, oversized, "competing_paid", False)
        wait_for_sessions(
            "application_name in ('competing_claim','competing_paid') "
            "and wait_event_type='Lock' and wait_event='advisory'", 2,
        )
        assert json.loads(first.result())["status"] == "claimed"
        assert json.loads(second.result()) == {"status": "no_match"}
        refused = paid.result()
        assert refused.returncode and "P0058" in refused.stderr, refused

    assert json.loads(sql(claim(A, OP_A)))["status"] == "claimed"
    assert sql("""select free_ram_mb from
      public.holder_admission_host_availability(array['fixture-standby-host'],null,false,'{}',null);""") == "12288"
    print("Competing claim and paid placement serialized; exact replay kept 12 GiB free.")


if __name__ == "__main__":
    docker(
        "run", "-d", "--rm", "--name", NAME, "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
        "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
    )
    try:
        for _ in range(30):
            if docker("exec", NAME, "pg_isready", "-U", "postgres", check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("disposable Postgres did not become ready")
        verify()
    finally:
        docker("rm", "-f", NAME, check=False)
