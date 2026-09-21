-- Global API Keys Vault Schema
drop table if exists public.user_vault_profiles cascade;
create table if not exists public.user_api_keys (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    name text not null,
    provider text not null,
    key_encrypted text not null,
    key_preview text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger user_api_keys_updated_at
    before update on user_api_keys
    for each row execute function update_updated_at();
alter table user_api_keys enable row level security;
create policy "users manage own api keys"
    on user_api_keys for all
    using (auth.uid()::text = user_id);
