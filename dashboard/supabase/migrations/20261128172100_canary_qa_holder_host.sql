alter table public.hivra_canary_qa_holder_settings
  add column host_id text check (host_id ~ '^[a-z0-9][a-z0-9-]*$'),
  add constraint hivra_canary_qa_holder_enabled_requires_host check (not enabled or host_id is not null);
