-- Hermes Deploy — Dedicated Schema
create extension if not exists "pgcrypto";
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
create table if not exists hermes_instances (
    id              uuid primary key default gen_random_uuid(),
    user_id         text not null,
    name            text not null,
    subdomain       text,
    status          text not null default 'provisioning'
                        check (status in ('provisioning','running','stopped','failed','error','deleted','redeploying')),
    hetzner_server_id bigint,
    gateway_url     text,
    provider        text not null default 'openrouter',
    api_key_encrypted text,
    api_key_preview text,
    api_server_key_encrypted text,
    config          jsonb not null default '{}',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create trigger hermes_instances_updated_at
    before update on hermes_instances
    for each row execute function update_updated_at();
create index if not exists hermes_instances_user_id_idx on hermes_instances(user_id);
create index if not exists hermes_instances_status_idx on hermes_instances(status);
alter table hermes_instances enable row level security;
create policy "users see own instances"
    on hermes_instances for all
    using (auth.uid()::text = user_id);
