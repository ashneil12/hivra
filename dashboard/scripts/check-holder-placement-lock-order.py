#!/usr/bin/env python3
"""Disposable multi-session proof for the holder placement lock order.

PGlite runs one connection, so it cannot exercise the row-lock/advisory-lock
interleaving that previously deadlocked Classic wake against holder tier
maintenance. This script uses a networkless, in-memory postgres:16-alpine
container, applies the real fixture and migrations, forces a Classic wake to
hold its instance row immediately before holder-funding validation, then waits
for holder tier maintenance to block on that row. In the corrected order the
batch holds only the placement advisory while blocked; it does not already own
the per-owner funding advisory, so the wake finishes and both transactions
complete without deadlock detection. A second test overlaps two cron claims
for distinct instances on one host, then checks the persisted claim after
the first transaction commits.

The container is disposable and is always removed. A local Docker daemon and a
local postgres:16-alpine image are required; this is a verification harness,
not part of the application runtime.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import subprocess
import time
import uuid

APP = Path(__file__).resolve().parents[1]
IMAGE = "postgres:16-alpine"
NAME = "holder-placement-lock-" + uuid.uuid4().hex[:12]
MIGRATIONS = [
    "20261124230000_holder_admissions.sql",
    "20261125010000_hermes_holder_idle_claim.sql",
    "20261125020000_holder_allocation_updates.sql",
    "20261125030000_classic_holder_sleep.sql",
    "20261125040000_durable_proxmox_placement.sql",
    "20261125050000_classic_holder_lifecycle_repairs.sql",
]
INSTANCE_ID = "11111111-1111-4111-8111-111111111111"
OWNER = "lock-order-owner"


def docker(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )


def sql(statement: str, label: str = "controller") -> str:
    result = docker(
        "exec",
        "-i",
        "-e",
        "PGAPPNAME=" + label,
        NAME,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        input_text=statement,
    )
    return result.stdout.strip()


def wait_for_backend(label: str, predicate: str, description: str) -> None:
    query = (
        "select count(*) from pg_stat_activity where application_name='"
        + label
        + "' and "
        + predicate
        + ";"
    )
    for _ in range(80):
        if sql(query) == "1":
            return
        time.sleep(0.1)
    raise RuntimeError(f"backend did not reach {description}")


def fixture_sql() -> str:
    text = (APP / "src/lib/billing/__tests__/holder-admission-schema.fixture.ts").read_text()
    return text.split("export const FIXTURE_SQL = `", 1)[1].rsplit("`;", 1)[0]


def check_overlapping_cron_claims() -> None:
    sql(
        """
        insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio)
        values('overlap-host',12,57344,1);
        insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
        values('overlap-first','pro','hermesos',true), ('overlap-second','pro','hermesos',true);
        insert into public.holder_admissions(
          user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,assigned_host_id
        ) values
          ('overlap-first','admitted','pro','hermesos',now(),2,4096,'overlap-host'),
          ('overlap-second','admitted','pro','hermesos',now(),2,4096,'overlap-host');
        insert into public.hermes_instances(
          id,user_id,status,lifecycle_state,cpu_limit,ram_limit,resource_tier,
          proxmox_node,proxmox_vmid,disk_size_gb,seat_funding,infrastructure_provider,
          config,ipv4_address,gateway_url,created_at,last_activity_at
        ) values
          ('22222222-2222-4222-8222-222222222222','overlap-first','running','active',1,2048,'operator',
           'overlap-host',201,30,'holder','proxmox','{}','192.0.2.3','https://gateway.example',
           now()-interval '1 hour',now()-interval '1 hour'),
          ('33333333-3333-4333-8333-333333333333','overlap-second','running','active',1,2048,'operator',
           'overlap-host',202,30,'holder','proxmox','{}','192.0.2.4','https://gateway.example',
           now()-interval '1 hour',now()-interval '1 hour');
        """,
        "overlap_setup",
    )

    claim = "select coalesce(public.claim_classic_holder_idle(null,null,true)::text,'NO_CLAIM');"
    with ThreadPoolExecutor(max_workers=1) as pool:
        # The setup below restores the unpaced validator. Sleep only after the
        # first claim has been written and while its transaction still owns it.
        first = pool.submit(sql, "begin; " + claim + " select pg_sleep(5); commit;", "cron_first")
        wait_for_backend("cron_first", "wait_event='PgSleep'", "the uncommitted first cron claim")
        during = sql(claim, "cron_overlap")
        if sql("select count(*) from pg_stat_activity where application_name='cron_first' and wait_event='PgSleep';") != "1":
            raise AssertionError("the overlapping claim finished after the first transaction ended")
        first_result = first.result(timeout=10)

    after = sql(claim, "cron_after_commit")
    claimed = json.loads(first_result)
    if claimed.get("action") != "nap" or claimed.get("node") != "overlap-host":
        raise AssertionError(f"first sweep did not claim the fixture host: {first_result!r}")
    if during != "NO_CLAIM" or after != "NO_CLAIM":
        raise AssertionError(f"second sweep claimed an occupied host: during={during!r}, after={after!r}")
    print("PASS: overlapping cron claims never dispatched two operations on the same host.")


def main() -> None:
    docker(
        "run",
        "-d",
        "--rm",
        "--name",
        NAME,
        "--network",
        "none",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        IMAGE,
        input_text=None,
    )
    try:
        for _ in range(90):
            ready = subprocess.run(
                ["docker", "exec", NAME, "pg_isready", "-U", "postgres"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("disposable Postgres did not become ready")

        sql(fixture_sql(), "setup")
        migration_dir = APP / "supabase/migrations"
        for migration in MIGRATIONS:
            sql((migration_dir / migration).read_text(), "setup")

        sql(
            f"""
            insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio)
            values('h1',12,57344,1);
            insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible)
            values('{OWNER}','pro','hermesos',true);
            insert into public.holder_admissions(
              user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,assigned_host_id
            ) values('{OWNER}','admitted','pro','hermesos',now(),2,4096,'h1');
            insert into public.hermes_instances(
              id,user_id,status,lifecycle_state,cpu_limit,ram_limit,resource_tier,
              proxmox_node,proxmox_vmid,disk_size_gb,seat_funding,infrastructure_provider,
              config,ipv4_address,gateway_url,paused_reason,lifecycle_substate,
              created_at,last_activity_at,last_agent_activity_at
            ) values(
              '{INSTANCE_ID}','{OWNER}','stopped','paused',1,2048,'operator',
              'h1',101,30,'holder','proxmox','{{}}'::jsonb,'192.0.2.2','https://gateway.example',
              'holder_idle','holder_hibernated',now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour'
            );
            """,
            "setup",
        )

        # Pace the exact validation point without changing its lock sequence:
        # claim_classic_holder_idle row-locks the instance, then enters the
        # holder funding validator. The wrapper only makes that window observable.
        sql(
            """
            alter function public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric)
              rename to holder_seat_funding_valid_unpaced;
            create function public.holder_seat_funding_valid(
              p_user_id text,p_cpu numeric,p_ram_mb numeric,
              p_exclude_hivra_agent_id uuid default null,
              p_exclude_hermes_instance_id uuid default null,
              p_max_cpu numeric default null,p_max_ram_mb numeric default null
            ) returns boolean language plpgsql volatile security definer
            set search_path=pg_catalog,pg_temp as $$
            begin
              perform pg_sleep(3);
              return public.holder_seat_funding_valid_unpaced(
                p_user_id,p_cpu,p_ram_mb,p_exclude_hivra_agent_id,p_exclude_hermes_instance_id,p_max_cpu,p_max_ram_mb
              );
            end $$;
            """,
            "setup",
        )

        change = json.dumps([
            {
                "id": INSTANCE_ID,
                "previous_tier": "operator",
                "previous_cpu": 1,
                "previous_ram": 2048,
                "cpu_limit": 1,
                "ram_limit": 2048,
            }
        ])
        wake_sql = (
            "begin; "
            f"select public.claim_classic_holder_idle('{INSTANCE_ID}'::uuid,'{OWNER}',true); "
            "commit;"
        )
        apply_sql = (
            "begin; "
            f"select public.apply_hermes_tier_allocations('{OWNER}',true,'operator','{change}'::jsonb); "
            "commit;"
        )

        with ThreadPoolExecutor(max_workers=2) as pool:
            wake = pool.submit(sql, wake_sql, "classic_wake")
            wait_for_backend("classic_wake", "wait_event='PgSleep'", "paced holder funding validation")
            apply_batch = pool.submit(sql, apply_sql, "tier_apply")
            wait_for_backend("tier_apply", "wait_event_type='Lock'", "the instance row lock")

            wake_result = wake.result(timeout=10)
            apply_result = apply_batch.result(timeout=10)

        if '"action": "wake"' not in wake_result:
            raise AssertionError(f"Classic wake did not claim a wake: {wake_result!r}")
        if apply_result != "1":
            raise AssertionError(f"tier allocation batch did not complete once: {apply_result!r}")
        print("PASS: Classic wake and holder tier maintenance completed in the corrected lock order.")
        sql("""
            drop function public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric);
            alter function public.holder_seat_funding_valid_unpaced(text,numeric,numeric,uuid,uuid,numeric,numeric)
              rename to holder_seat_funding_valid;
        """, "restore_validator")
        check_overlapping_cron_claims()
    finally:
        subprocess.run(["docker", "rm", "-f", NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("Removed the disposable Postgres container.")


if __name__ == "__main__":
    main()
