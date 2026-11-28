/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

it("seeds only a fresh authorized paid Canary reservation, without changing admission or replay", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.hivra_agents (
        id uuid primary key, user_id text, operation_id uuid, operation_kind text,
        status text, deployment_mode text, computer_substrate text, type text, managed_provisioner_channel text,
        seat_funding text, sleep_policy text default 'off', always_on boolean default false
      );
      create function public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)
      returns jsonb language plpgsql as $$
      declare agent_id uuid:=($5->>'id')::uuid;
      begin
        if $8=0 then return jsonb_build_object('status','plan_agent_limit'); end if;
        if $9 is distinct from 1.25::numeric or $10 is distinct from true then
          raise exception 'placement policy changed';
        end if;
        if exists(select 1 from public.hivra_agents where id=agent_id) then
          return jsonb_build_object('status','existing','agentId',agent_id);
        end if;
        insert into public.hivra_agents (id,user_id,operation_id,operation_kind,status,deployment_mode,computer_substrate,type,managed_provisioner_channel,seat_funding)
        values(agent_id,$1,($5->>'operation_id')::uuid,'provision','provisioning',$5->>'deployment_mode',
          $5->>'computer_substrate',coalesce($5->>'type','codex'),$5->>'managed_provisioner_channel',$5->>'seat_funding');
        return jsonb_build_object('status','reserved','agentId',agent_id);
      end;
      $$;
    `);
    const sql = readFileSync(path.join(__dirname, "../../supabase/migrations/20261128163000_canary_kvm_idle_hibernate_default.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const signature = "public.reserve_canary_hivra_disk_sleep_launch(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)";
    expect((await db.query(`select has_function_privilege('anon',$1,'EXECUTE') anon,
      has_function_privilege('authenticated',$1,'EXECUTE') authenticated,
      has_function_privilege('service_role',$1,'EXECUTE') service_role`, [signature])).rows)
      .toEqual([{ anon: false, authenticated: false, service_role: true }]);

    const agent = {
      id: "11111111-1111-4111-8111-111111111111", operation_id: "22222222-2222-4222-8222-222222222222",
      deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", seat_funding: "paid", managed_provisioner_channel: "canary",
    };
    const second = { ...agent, id: "44444444-4444-4444-8444-444444444444" };
    const request = "33333333-3333-4333-8333-333333333333";
    const reserve = async (row: typeof agent & { type?: string }, limit = 1) =>
      (await db.query<{ status: string }>("select public.reserve_canary_hivra_disk_sleep_launch('owner',$1,'[]',$1,$2,'{}',null,$3,1.25,true)->>'status' status",
        [request, JSON.stringify(row), limit])).rows[0].status;
    const policies = async () => (await db.query("select sleep_policy from public.hivra_agents")).rows;

    expect(await reserve(agent)).toBe("reserved");
    expect(await policies()).toEqual([{ sleep_policy: "t3" }]);
    await db.exec("update public.hivra_agents set sleep_policy='off'");
    expect(await reserve(agent)).toBe("existing");
    expect(await reserve(second, 0)).toBe("plan_agent_limit");
    expect(await reserve({ ...second, seat_funding: "holder" })).toBe("invalid_request");
    await expect(reserve({ ...second, type: "aeon" })).rejects.toThrow("Canary launch sleep default was not persisted");
    expect(await policies()).toEqual([{ sleep_policy: "off" }]);
  } finally {
    await db.close();
  }
}, 30_000);
