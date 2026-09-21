-- Add is_temporary to hermes_conversations
alter table public.hermes_conversations 
add column if not exists is_temporary boolean not null default false;
-- Add index for filtering
create index if not exists hermes_conversations_is_temporary_idx 
on public.hermes_conversations(is_temporary);
