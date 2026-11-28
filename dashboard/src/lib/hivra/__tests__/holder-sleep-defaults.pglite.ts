import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

it("enrolls managed KVM holders in idle sleep on direct admission or delayed funding assignment", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.hivra_agents (
        name text primary key,
        seat_funding text,
        deployment_mode text not null default 'hivra-managed',
        computer_substrate text not null default 'proxmox-kvm',
        deployment_target_id uuid,
        infrastructure_connection_id uuid,
        always_on boolean not null default false,
        sleep_policy text not null default 'off'
      );
    `);
    await db.exec(readFileSync("supabase/migrations/20261128183300_hivra_holder_sleep_defaults.sql", "utf8"));
    await db.exec(`
      insert into hivra_agents (name, seat_funding, always_on, sleep_policy) values
        ('direct', 'holder', true, 'off'), ('late', null, true, 'off'),
        ('paid', 'paid', true, 'off'), ('unknown', null, false, 't3');
      insert into hivra_agents (name, seat_funding, computer_substrate) values ('other', 'holder', 'provider-vm');
      insert into hivra_agents (name, seat_funding, deployment_mode) values ('self-managed', 'holder', 'self-managed');
      update hivra_agents set seat_funding='holder' where name='late';
    `);
    expect((await db.query("select name,always_on,sleep_policy from hivra_agents order by name")).rows).toEqual([
      { name: "direct", always_on: false, sleep_policy: "full" },
      { name: "late", always_on: false, sleep_policy: "full" },
      { name: "other", always_on: false, sleep_policy: "off" },
      { name: "paid", always_on: true, sleep_policy: "off" },
      { name: "self-managed", always_on: false, sleep_policy: "off" },
      { name: "unknown", always_on: false, sleep_policy: "t3" },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);
