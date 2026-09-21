create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
drop table if exists public.user_vault cascade;
create table if not exists public.user_vault_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id text not null,
    profile_name text not null,
    
    openai_key_encrypted text,
    openai_key_preview text,

    openrouter_key_encrypted text,
    openrouter_key_preview text,

    honcho_key_encrypted text,
    honcho_key_preview text,

    anthropic_key_encrypted text,
    anthropic_key_preview text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger user_vault_profiles_updated_at
    before update on user_vault_profiles
    for each row execute function update_updated_at();
alter table user_vault_profiles enable row level security;
create policy "users manage own vault profiles"
    on user_vault_profiles for all
    using (auth.uid()::text = user_id);
