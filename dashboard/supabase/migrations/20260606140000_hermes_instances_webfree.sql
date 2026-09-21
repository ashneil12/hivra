-- Per-instance webui-free opt-in for the staged webui -> webui-free fleet
-- migration. This is SEPARATE from hermes_instances.backend: webfree rows stay
-- backend='webui', so all existing webui routing / readiness / auth (proven on
-- the prod fleet) is unchanged. Only the rendered compose/Caddyfile/bootstrap
-- differ. When true, the provisioner renders the webui-free stack (gateway on
-- the agent image + tokenless rich-chat + /dash bundles file_served by the inner
-- Caddy) instead of the legacy webui-image stack.
--
-- Additive + reversible (drop the column). Default false => every existing row
-- keeps the legacy webui stack until an instance is deliberately flipped
-- (update hermes_instances set webfree=true where id=...), then reconciled via
-- the redeploy-webui-instances cron. Idempotent (IF NOT EXISTS).
alter table public.hermes_instances
  add column if not exists webfree boolean not null default false;

comment on column public.hermes_instances.webfree is
  'When true, render the webui-free stack (gateway on the agent image + tokenless rich chat) instead of the legacy webui-image stack. Separate from `backend` (webfree rows stay backend=webui). Drives the staged webui -> webui-free fleet migration.';
