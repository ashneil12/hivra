-- Creates hermes_hosts table to represent the Hetzner virtual machine the agent slices reside on.
create table if not exists hermes_hosts (
    id              uuid primary key default gen_random_uuid(),
    user_id         text not null,
    hetzner_server_id bigint,
    name            text not null,
    total_cpu       int not null default 2,
    total_ram       int not null default 4096,
    status          text not null default 'provisioning'
                        check (status in ('provisioning','running','stopped','failed','error','deleted')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create trigger hermes_hosts_updated_at
    before update on hermes_hosts
    for each row execute function update_updated_at();
create index if not exists hermes_hosts_user_id_idx on hermes_hosts(user_id);
create index if not exists hermes_hosts_status_idx on hermes_hosts(status);
alter table hermes_hosts enable row level security;
create policy "users see own hosts"
    on hermes_hosts for all
    using (auth.uid()::text = user_id);
-- Alter hermes_instances (Agents) to depend on hermes_hosts
alter table hermes_instances
    add column if not exists host_id uuid references hermes_hosts(id) on delete restrict,
    add column if not exists cpu_limit int not null default 1,
    add column if not exists ram_limit int not null default 2048;
-- (Optional in future) move hetzner_server_id logic purely to host. We'll leave it in instances as legacy mapping for now.;
