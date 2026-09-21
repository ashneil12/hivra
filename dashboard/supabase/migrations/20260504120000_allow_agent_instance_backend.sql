-- Allow the new direct Hermes agent runtime mode.
--
-- Existing rows remain unchanged. This only expands the backend discriminator
-- so chat routes can opt into the Workspace-style direct agent contract
-- without pretending those instances are either legacy gateway or WebUI.

DO $$
DECLARE
  existing_constraint_name text;
BEGIN
  SELECT c.conname
    INTO existing_constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'hermes_instances'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%backend%'
  ORDER BY c.conname
  LIMIT 1;

  IF existing_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.hermes_instances DROP CONSTRAINT %I',
      existing_constraint_name
    );
  END IF;

  ALTER TABLE public.hermes_instances
    ADD CONSTRAINT hermes_instances_backend_check
    CHECK (backend IN ('gateway', 'webui', 'agent'));

  COMMENT ON COLUMN public.hermes_instances.backend IS
    'Per-instance chat backend. "gateway" = legacy Hermes gateway overlay. "webui" = Hermes WebUI runtime. "agent" = direct Hermes agent session/history/stream runtime.';
END $$;
