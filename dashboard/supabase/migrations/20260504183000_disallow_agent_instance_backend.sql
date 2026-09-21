-- Roll back the abandoned direct-agent backend mode.
--
-- The 20260504120000 migration reached production, so we keep that historical
-- migration file in the repo and close the door with this forward migration.
-- Any rows left on the experimental backend are moved back to WebUI before the
-- constraint is tightened.

UPDATE public.hermes_instances
SET backend = 'webui',
    updated_at = now()
WHERE backend = 'agent';

ALTER TABLE public.hermes_instances
  DROP CONSTRAINT IF EXISTS hermes_instances_backend_check;

ALTER TABLE public.hermes_instances
  ADD CONSTRAINT hermes_instances_backend_check
  CHECK (backend IN ('gateway', 'webui'));

COMMENT ON COLUMN public.hermes_instances.backend IS
  'Per-instance chat backend. "gateway" = legacy Hermes gateway overlay. "webui" = Hermes WebUI runtime.';
