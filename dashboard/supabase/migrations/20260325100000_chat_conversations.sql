-- Hermes Chat — Conversations & Messages
-- Provides persistence for the chat UI

-- ── Conversations table ──────────────────────────────────────────────
create table if not exists hermes_conversations (
    id              uuid primary key default gen_random_uuid(),
    instance_id     uuid not null references hermes_instances(id) on delete cascade,
    user_id         text not null,
    title           text not null default 'New Chat',
    pinned          boolean not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create trigger hermes_conversations_updated_at
    before update on hermes_conversations
    for each row execute function update_updated_at();
create index if not exists hermes_conversations_instance_idx
    on hermes_conversations(instance_id);
create index if not exists hermes_conversations_user_idx
    on hermes_conversations(user_id);
create index if not exists hermes_conversations_updated_idx
    on hermes_conversations(updated_at desc);
alter table hermes_conversations enable row level security;
create policy "users see own conversations"
    on hermes_conversations for all
    using (auth.uid()::text = user_id);
-- ── Messages table ───────────────────────────────────────────────────
create table if not exists hermes_messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references hermes_conversations(id) on delete cascade,
    role            text not null check (role in ('user','assistant','system','tool')),
    content         text,
    tool_calls      jsonb,                              -- structured tool invocations from assistant
    tool_call_id    text,                                -- for tool-role result messages
    attachments     jsonb not null default '[]'::jsonb,  -- [{name, url, type, size}]
    artifacts       jsonb not null default '[]'::jsonb,  -- [{id, title, type, content, language}]
    metadata        jsonb not null default '{}'::jsonb,  -- {model, tokens, duration, etc}
    created_at      timestamptz not null default now()
);
create index if not exists hermes_messages_conversation_idx
    on hermes_messages(conversation_id);
create index if not exists hermes_messages_created_idx
    on hermes_messages(conversation_id, created_at asc);
alter table hermes_messages enable row level security;
create policy "users see own messages"
    on hermes_messages for all
    using (
        exists (
            select 1 from hermes_conversations c
            where c.id = hermes_messages.conversation_id
              and c.user_id = auth.uid()::text
        )
    );
-- ── Storage bucket for attachments ───────────────────────────────────
insert into storage.buckets (id, name, public)
values ('hermes-attachments', 'hermes-attachments', false)
on conflict (id) do nothing;
create policy "users upload own attachments"
    on storage.objects for insert
    with check (bucket_id = 'hermes-attachments' and auth.uid() is not null);
create policy "users read own attachments"
    on storage.objects for select
    using (bucket_id = 'hermes-attachments' and auth.uid() is not null);
